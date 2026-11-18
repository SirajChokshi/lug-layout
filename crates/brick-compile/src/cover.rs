mod below;
mod instance_tree;
mod ray;
mod triangle_tree;

use std::thread;

use rustc_hash::{FxHashMap, FxHashSet};

use self::below::{certifiable_faces, coordinates_bounded, BelowCertifier, BelowStud};
use self::instance_tree::InstanceTree;
use self::ray::{dot, sub, unit, Bounds, Ray, HIT_EPSILON};
use self::triangle_tree::{TriangleHit, TriangleTree};
use crate::affine::{Affine, Vec3};
use crate::clip::{clip_to_box, polygon_area};
use crate::flatten::INHERIT_COLOR;
use crate::lattice::STUD_LDU;
use crate::mesh::{Mesh, WELD_EPSILON_LDU};

pub const PLATE_LDU: f64 = 8.0;
pub const EMPTY_COLUMN: i32 = -1;
const HALF_STUD_LDU: f64 = STUD_LDU / 2.0;
const UPRIGHT_COSINE: f64 = 1.0 - 1e-9;
const BROAD_CELL_LDU: f64 = 2.0 * STUD_LDU;
const AZIMUTH_RAYS: usize = 16;
const BELOW_AZIMUTH_RAYS: usize = 64;
const ENCLOSURE_ELEVATIONS_DEGREES: [f64; 3] = [0.0, 30.0, 60.0];
const BELOW_ELEVATION_STEP_DEGREES: f64 = 2.5;
const BELOW_ELEVATION_STEPS: usize = 36;
const BELOW_HEIGHT_STEPS: usize = 8;
const BELOW_START_OUTSIDE: f64 = 1.001;
const BELOW_REACH_LDU: f64 = 3.0 * STUD_LDU;
const RIM_PROBE_FRACTION: f64 = 0.9;
const TREE_WALK_TRIANGLES: usize = 64;
const CANDIDATES_PER_DEAL: usize = 32;
const CLIPPED_HEIGHT_ROUNDING_LDU: f64 = 1e-6;
const ENCLOSURE_BLOCKERS_KEPT: usize = 8;
const UP: Vec3 = [0.0, 1.0, 0.0];
const DOWN: Vec3 = [0.0, -1.0, 0.0];

#[derive(Clone, Copy)]
enum Material {
    Opaque,
    Clear,
    Inherited,
}

impl Material {
    fn counts(self, inherited_opaque: bool) -> bool {
        match self {
            Material::Opaque => true,
            Material::Clear => false,
            Material::Inherited => inherited_opaque,
        }
    }
}

pub struct Opacity {
    transparent: FxHashSet<u32>,
}

impl Opacity {
    pub fn new(transparent: impl IntoIterator<Item = u32>) -> Self {
        Opacity {
            transparent: transparent.into_iter().collect(),
        }
    }

    fn opaque(&self, color: u32) -> bool {
        !self.transparent.contains(&color)
    }

    fn material(&self, code: u32) -> Material {
        if code == INHERIT_COLOR {
            Material::Inherited
        } else if self.opaque(code) {
            Material::Opaque
        } else {
            Material::Clear
        }
    }
}

pub struct PartSolid {
    triangles: Vec<[Vec3; 3]>,
    tree_colors: Vec<u32>,
    tree_points: Vec<[Vec3; 3]>,
    certifiable: Vec<bool>,
    tree: TriangleTree,
    min: Vec3,
    max: Vec3,
}

impl PartSolid {
    pub fn from_mesh(mesh: &Mesh) -> Self {
        let point = |index: u32| {
            let k = index as usize * 3;
            [
                f64::from(mesh.positions[k]),
                f64::from(mesh.positions[k + 1]),
                f64::from(mesh.positions[k + 2]),
            ]
        };
        let mut triangles = Vec::new();
        let mut colors = Vec::new();
        for group in &mesh.groups {
            for t in group.indices.as_chunks::<3>().0 {
                triangles.push([point(t[0]), point(t[1]), point(t[2])]);
                colors.push(group.color);
            }
        }
        let (tree, order) = TriangleTree::build(&triangles);
        let [min, max] = mesh
            .bounds()
            .unwrap_or([[0.0; 3]; 2])
            .map(|corner| corner.map(f64::from));
        let tree_points: Vec<[Vec3; 3]> = order.iter().map(|&t| triangles[t]).collect();
        PartSolid {
            tree_colors: order.iter().map(|&t| colors[t]).collect(),
            certifiable: certifiable_faces(&tree_points, &tree),
            tree_points,
            triangles,
            tree,
            min,
            max,
        }
    }

    fn materials(&self, opacity: &Opacity) -> Vec<Material> {
        self.tree_colors
            .iter()
            .map(|&code| opacity.material(code))
            .collect()
    }

    fn lowest_y(&self, matrix: &Affine) -> f64 {
        self.triangles
            .iter()
            .flatten()
            .map(|p| matrix.apply(*p)[1])
            .fold(f64::INFINITY, f64::min)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverKind {
    AntiStud,
    Flat,
}

fn azimuth(k: usize) -> f64 {
    std::f64::consts::TAU * k as f64 / AZIMUTH_RAYS as f64
}

fn below_azimuth(k: usize) -> f64 {
    std::f64::consts::TAU * k as f64 / BELOW_AZIMUTH_RAYS as f64
}

fn enclosure_directions() -> Vec<Vec3> {
    let mut directions = vec![UP];
    for elevation in ENCLOSURE_ELEVATIONS_DEGREES {
        let (rise, run) = elevation.to_radians().sin_cos();
        for k in 0..AZIMUTH_RAYS {
            let (sin, cos) = azimuth(k).sin_cos();
            directions.push([run * cos, rise, run * sin]);
        }
    }
    directions
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StudShape {
    pub height: f64,
    pub radius: f64,
}

#[derive(Clone, Copy)]
struct StudFrame {
    base: Vec3,
    up: Vec3,
    across: Vec3,
    along: Vec3,
}

impl StudFrame {
    fn of(matrix: &Affine) -> Self {
        StudFrame {
            base: translation(matrix),
            up: up_of(matrix),
            across: unit([matrix.m[0], matrix.m[4], matrix.m[8]]),
            along: unit([matrix.m[2], matrix.m[6], matrix.m[10]]),
        }
    }

    fn upright_at(base: Vec3) -> Self {
        StudFrame {
            base,
            up: UP,
            across: [1.0, 0.0, 0.0],
            along: [0.0, 0.0, 1.0],
        }
    }

    fn at(&self, height: f64, side: Vec3, offset: f64) -> Vec3 {
        [0, 1, 2].map(|axis| self.base[axis] + self.up[axis] * height + side[axis] * offset)
    }

    fn radial(&self, k: usize) -> Vec3 {
        let (sin, cos) = below_azimuth(k).sin_cos();
        [0, 1, 2].map(|axis| self.across[axis] * cos + self.along[axis] * sin)
    }

    fn probes(&self, shape: StudShape) -> [Vec3; 5] {
        let rim = shape.radius * RIM_PROBE_FRACTION;
        let middle = shape.height / 2.0;
        [
            self.at(middle, self.across, 0.0),
            self.at(middle, self.across, rim),
            self.at(middle, self.across, -rim),
            self.at(middle, self.along, rim),
            self.at(middle, self.along, -rim),
        ]
    }

    fn radials(&self) -> Vec<Vec3> {
        let mut radials: Vec<Vec3> = (0..BELOW_AZIMUTH_RAYS).map(|k| self.radial(k)).collect();
        for k in 0..BELOW_AZIMUTH_RAYS {
            let (sin, cos) = below_azimuth(k).sin_cos();
            let lattice = [cos, 0.0, sin];
            let rise = dot(lattice, self.up);
            let flat = [0, 1, 2].map(|axis| lattice[axis] - self.up[axis] * rise);
            if dot(flat, flat) < HIT_EPSILON {
                continue;
            }
            let flat = unit(flat);
            if radials.iter().all(|r| dot(*r, flat) < UPRIGHT_COSINE) {
                radials.push(flat);
            }
        }
        radials
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoverShard {
    pub from: usize,
    pub to: usize,
    pub of: usize,
}

impl CoverShard {
    pub const WHOLE: CoverShard = CoverShard {
        from: 0,
        to: 1,
        of: 1,
    };

    fn takes(&self, candidate: usize) -> bool {
        let slot = (candidate / CANDIDATES_PER_DEAL) % self.of;
        (self.from..self.to).contains(&slot)
    }
}

pub struct CoverInstance<'a> {
    pub matrix: &'a Affine,
    pub color: u32,
    pub part: usize,
    pub studs: &'a [Affine],
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCells {
    pub origin: [f64; 2],
    pub width: usize,
    pub depth: usize,
    pub bottom_y: f64,
    pub footprint: Vec<usize>,
    pub flat: Vec<usize>,
    pub column_bottom: Vec<i32>,
    pub column_top: Vec<i32>,
}

impl ModelCells {
    pub fn height_plates(&self) -> i32 {
        self.column_top
            .iter()
            .copied()
            .max()
            .unwrap_or(EMPTY_COLUMN)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCover {
    pub visible: Vec<bool>,
    pub open_below: usize,
    pub cells: Option<ModelCells>,
}

impl ModelCover {
    pub fn covered_count(&self) -> usize {
        self.visible.iter().filter(|v| !**v).count()
    }

    pub fn visible_bits(&self) -> Vec<u32> {
        let mut words = vec![0u32; self.visible.len().div_ceil(32)];
        for (i, visible) in self.visible.iter().enumerate() {
            if *visible {
                words[i / 32] |= 1 << (i % 32);
            }
        }
        words
    }
}

fn translation(matrix: &Affine) -> Vec3 {
    [matrix.m[3], matrix.m[7], matrix.m[11]]
}

fn rotation_bits(matrix: &Affine) -> [u64; 9] {
    [0, 1, 2, 4, 5, 6, 8, 9, 10].map(|k| matrix.m[k].to_bits())
}

fn up_of(matrix: &Affine) -> Vec3 {
    unit([matrix.m[1], matrix.m[5], matrix.m[9]])
}

fn inverse(matrix: &Affine) -> Option<Affine> {
    let m = &matrix.m;
    let determinant = matrix.determinant();
    if determinant.abs() < f64::EPSILON {
        return None;
    }
    let r = |a: usize, b: usize, c: usize, d: usize| (m[a] * m[b] - m[c] * m[d]) / determinant;
    let linear = [
        r(5, 10, 6, 9),
        r(2, 9, 1, 10),
        r(1, 6, 2, 5),
        r(6, 8, 4, 10),
        r(0, 10, 2, 8),
        r(2, 4, 0, 6),
        r(4, 9, 5, 8),
        r(1, 8, 0, 9),
        r(0, 5, 1, 4),
    ];
    let t = translation(matrix);
    let mut out = [0.0; 12];
    for row in 0..3 {
        let [a, b, c] = [linear[row * 3], linear[row * 3 + 1], linear[row * 3 + 2]];
        out[row * 4] = a;
        out[row * 4 + 1] = b;
        out[row * 4 + 2] = c;
        out[row * 4 + 3] = -(a * t[0] + b * t[1] + c * t[2]);
    }
    Some(Affine { m: out })
}

fn world_box(instance: &CoverInstance, solid: &PartSolid) -> [Vec3; 2] {
    corner_box(instance.matrix, solid.min, solid.max)
}

fn corner_box(matrix: &Affine, min: Vec3, max: Vec3) -> [Vec3; 2] {
    let mut bounds = Bounds::EMPTY;
    for i in 0..8 {
        let pick = |bit: usize, axis: usize| {
            if i & bit == 0 {
                min[axis]
            } else {
                max[axis]
            }
        };
        bounds = bounds.grow(matrix.apply([pick(1, 0), pick(2, 1), pick(4, 2)]));
    }
    [bounds.min, bounds.max]
}

type ProbeKey = (usize, bool, [u64; 3]);

fn broad_cell(v: f64) -> i64 {
    (v / BROAD_CELL_LDU).floor() as i64
}

#[derive(Clone, Copy)]
struct CellRange {
    lo: [i64; 3],
    hi: [i64; 3],
}

impl CellRange {
    fn welded(min: Vec3, max: Vec3) -> Self {
        CellRange {
            lo: min.map(|v| broad_cell(v - WELD_EPSILON_LDU)),
            hi: max.map(|v| broad_cell(v + WELD_EPSILON_LDU)),
        }
    }

    fn spanned(a: Vec3, b: Vec3) -> Self {
        CellRange {
            lo: [0, 1, 2].map(|axis| broad_cell(a[axis].min(b[axis]))),
            hi: [0, 1, 2].map(|axis| broad_cell(a[axis].max(b[axis]))),
        }
    }

    fn shares_cell(&self, other: &CellRange) -> bool {
        (0..3).all(|axis| self.lo[axis].max(other.lo[axis]) <= self.hi[axis].min(other.hi[axis]))
    }
}

struct Segment {
    ray: Ray,
    end: Vec3,
    cells: CellRange,
}

impl Segment {
    fn new(origin: Vec3, direction: Vec3, reach: f64) -> Self {
        let end = [0, 1, 2].map(|axis| origin[axis] + direction[axis] * reach);
        Segment {
            ray: Ray {
                origin,
                direction,
                reach,
            },
            end,
            cells: CellRange::spanned(origin, end),
        }
    }
}

struct Placed {
    part: usize,
    inverse: Affine,
    translation: Vec3,
    rotation: [u64; 9],
    up: Vec3,
    cells: CellRange,
    inherited_opaque: bool,
    blocks: bool,
}

impl Placed {
    fn local(&self, segment: &Segment) -> Option<Ray> {
        self.local_between(self.inverse.apply(segment.ray.origin), segment.end)
    }

    fn local_between(&self, origin: Vec3, end: Vec3) -> Option<Ray> {
        let span = sub(self.inverse.apply(end), origin);
        let length = dot(span, span).sqrt();
        if length == 0.0 {
            return None;
        }
        Some(Ray {
            origin,
            direction: span.map(|v| v / length),
            reach: length,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Blocker {
    instance: usize,
    hit: TriangleHit,
}

struct ModelSolids<'a> {
    solids: &'a [PartSolid],
    materials: Vec<Vec<Material>>,
    placed: Vec<Option<Placed>>,
    index: InstanceTree,
    anchors: FxHashMap<[i64; 3], Vec<usize>>,
    coordinates_bounded: bool,
}

impl<'a> ModelSolids<'a> {
    fn new(
        instances: &[CoverInstance],
        boxes: &[[Vec3; 2]],
        solids: &'a [PartSolid],
        opacity: &Opacity,
    ) -> Self {
        let mut materials: Vec<Vec<Material>> = solids.iter().map(|_| Vec::new()).collect();
        for instance in instances {
            if materials[instance.part].is_empty() {
                materials[instance.part] = solids[instance.part].materials(opacity);
            }
        }
        let mut members = Vec::new();
        let mut anchors: FxHashMap<[i64; 3], Vec<usize>> = FxHashMap::default();
        let placed = instances
            .iter()
            .zip(boxes)
            .enumerate()
            .map(|(i, (instance, &[min, max]))| {
                let inverse = inverse(instance.matrix)?;
                let inherited_opaque = opacity.opaque(instance.color);
                members.push((i, Bounds { min, max }.padded(WELD_EPSILON_LDU)));
                let translation = translation(instance.matrix);
                anchors
                    .entry(translation.map(broad_cell))
                    .or_default()
                    .push(i);
                Some(Placed {
                    part: instance.part,
                    inverse,
                    translation,
                    rotation: rotation_bits(instance.matrix),
                    up: up_of(instance.matrix),
                    cells: CellRange::welded(min, max),
                    inherited_opaque,
                    blocks: materials[instance.part]
                        .iter()
                        .any(|material| material.counts(inherited_opaque)),
                })
            })
            .collect();
        ModelSolids {
            solids,
            materials,
            placed,
            index: InstanceTree::build(members),
            anchors,
            coordinates_bounded: coordinates_bounded(boxes),
        }
    }

    fn counts<'s>(&'s self, placed: &'s Placed) -> impl Fn(usize) -> bool + 's {
        let materials = &self.materials[placed.part];
        move |triangle| materials[triangle].counts(placed.inherited_opaque)
    }

    fn tree(&self, placed: &Placed) -> &TriangleTree {
        &self.solids[placed.part].tree
    }

    fn first_blocker(&self, instance: usize, segment: &Segment) -> Option<Blocker> {
        let placed = self.placed[instance].as_ref()?;
        if !placed.blocks || !placed.cells.shares_cell(&segment.cells) {
            return None;
        }
        let local = placed.local(segment)?;
        let hit = self.tree(placed).first_hit(&local, self.counts(placed))?;
        Some(Blocker { instance, hit })
    }

    fn search(&self, segment: &Segment) -> Option<Blocker> {
        let mut found = None;
        self.index.any_along(&segment.ray, |instance| {
            found = self.first_blocker(instance, segment);
            found.is_some()
        });
        found
    }
}

struct Coverers<'a, 'b> {
    model: &'b ModelSolids<'a>,
    stud: StudShape,
    directions: Vec<Vec3>,
    enclosed: FxHashMap<ProbeKey, Option<CoverKind>>,
    nearby: Vec<usize>,
    blockers: Vec<(usize, bool, TriangleHit)>,
}

impl Coverers<'_, '_> {
    fn enclosure(&mut self, placed: &Placed, probe: Vec3) -> Option<CoverKind> {
        let enclosed = (0..self.directions.len()).all(|k| {
            let direction = self.directions[k];
            self.hits(placed, probe, direction)
        });
        if !enclosed {
            return None;
        }
        if self.hits(placed, probe, DOWN) {
            Some(CoverKind::Flat)
        } else {
            Some(CoverKind::AntiStud)
        }
    }

    fn probe(&mut self, placed: &Placed, local: Vec3) -> Option<CoverKind> {
        let key = (
            placed.part,
            placed.inherited_opaque,
            local.map(f64::to_bits),
        );
        if let Some(known) = self.enclosed.get(&key) {
            return *known;
        }
        let found = self.enclosure(placed, local);
        self.enclosed.insert(key, found);
        found
    }

    fn hits(&mut self, placed: &Placed, origin: Vec3, direction: Vec3) -> bool {
        let tree = self.model.tree(placed);
        let counts = self.model.counts(placed);
        let ray = Ray {
            origin,
            direction,
            reach: f64::INFINITY,
        };
        let solid = (placed.part, placed.inherited_opaque);
        let remembered = self.blockers.iter().position(|&(part, opaque, hit)| {
            (part, opaque) == solid && tree.confirms(&ray, hit, &counts)
        });
        if let Some(index) = remembered {
            self.blockers[..=index].rotate_right(1);
            return true;
        }
        let Some(hit) = tree.first_hit(&ray, &counts) else {
            return false;
        };
        self.blockers
            .insert(0, (placed.part, placed.inherited_opaque, hit));
        self.blockers.truncate(ENCLOSURE_BLOCKERS_KEPT);
        true
    }

    fn covers(&mut self, stud: StudFrame, owner: Option<usize>) -> Option<(CoverKind, usize)> {
        let StudFrame { base, up, .. } = stud;
        let probes = stud.probes(self.stud);
        let model = self.model;
        let mut nearby = std::mem::take(&mut self.nearby);
        model.index.containing(base, &mut nearby);
        let mut found = None;
        for &i in &nearby {
            if Some(i) == owner {
                continue;
            }
            let Some(placed) = &model.placed[i] else {
                continue;
            };
            if dot(up, placed.up) < UPRIGHT_COSINE {
                continue;
            }
            let solid = &model.solids[placed.part];
            let local_base = placed.inverse.apply(base);
            if (local_base[1] - solid.min[1]).abs() > WELD_EPSILON_LDU {
                continue;
            }
            let mut centre = None;
            for (k, probe) in probes.iter().enumerate() {
                let enclosure = self.probe(placed, placed.inverse.apply(*probe));
                if enclosure.is_none() {
                    centre = None;
                    break;
                }
                if k == 0 {
                    centre = enclosure;
                }
            }
            if let Some(kind) = centre {
                found = Some((kind, i));
                break;
            }
        }
        self.nearby = nearby;
        found
    }
}

fn cell_range(min: f64, max: f64, phase: f64) -> (i64, i64) {
    let first = ((min - phase + HALF_STUD_LDU) / STUD_LDU).floor() as i64;
    let last = ((max - phase + HALF_STUD_LDU) / STUD_LDU).ceil() as i64 - 1;
    (first, last.max(first))
}

fn overlapping_cells(lo: f64, hi: f64, edge: f64, count: usize) -> (usize, usize) {
    let first = ((lo + WELD_EPSILON_LDU - edge) / STUD_LDU).floor().max(0.0) as usize;
    let end = (((hi - WELD_EPSILON_LDU - edge) / STUD_LDU).ceil().max(0.0) as usize).min(count);
    (first.min(end), end)
}

fn closed_below_all(model: &ModelSolids, candidates: &[BelowStud], shape: StudShape) -> Vec<bool> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let workers = thread::available_parallelism().map_or(1, |n| n.get());
    if workers == 1 {
        let mut below = BelowCertifier::new(model, shape);
        return candidates.iter().map(|stud| below.closed(stud)).collect();
    }
    let chunk = candidates.len().div_ceil(workers);
    let mut closed = vec![false; candidates.len()];
    thread::scope(|scope| {
        for (slice, out) in candidates.chunks(chunk).zip(closed.chunks_mut(chunk)) {
            scope.spawn(move || {
                let mut below = BelowCertifier::new(model, shape);
                for (stud, result) in slice.iter().zip(out.iter_mut()) {
                    *result = below.closed(stud);
                }
            });
        }
    });
    closed
}

pub fn model_cover(
    instances: &[CoverInstance],
    solids: &[PartSolid],
    opacity: &Opacity,
    phase: Option<[u32; 2]>,
    stud: StudShape,
    shard: CoverShard,
) -> ModelCover {
    let boxes: Vec<[Vec3; 2]> = instances
        .iter()
        .map(|instance| world_box(instance, &solids[instance.part]))
        .collect();
    let mut aabb = Bounds::EMPTY;
    for [min, max] in &boxes {
        aabb = aabb.grow(*min).grow(*max);
    }
    let model = ModelSolids::new(instances, &boxes, solids, opacity);
    let mut coverers = Coverers {
        model: &model,
        stud,
        directions: enclosure_directions(),
        enclosed: FxHashMap::default(),
        nearby: Vec::new(),
        blockers: Vec::new(),
    };

    let mut visible = Vec::new();
    let mut candidates = Vec::new();
    for (owner, instance) in instances.iter().enumerate() {
        for stud_matrix in instance.studs {
            let world = instance.matrix.then(stud_matrix);
            let frame = StudFrame::of(&world);
            if let Some((_, coverer)) = coverers.covers(frame, Some(owner)) {
                candidates.push((
                    visible.len(),
                    BelowStud {
                        frame,
                        rotation: rotation_bits(&world),
                        owner,
                        coverer,
                    },
                ));
            }
            visible.push(true);
        }
    }
    let (indices, candidates): (Vec<usize>, Vec<BelowStud>) = candidates
        .into_iter()
        .enumerate()
        .filter(|(candidate, _)| shard.takes(*candidate))
        .map(|(_, taken)| taken)
        .unzip();
    let closed = closed_below_all(&model, &candidates, stud);
    let mut open_below = 0;
    for (&index, closed) in indices.iter().zip(closed) {
        if closed {
            visible[index] = false;
        } else {
            open_below += 1;
        }
    }
    let rest_y = instances
        .iter()
        .map(|instance| solids[instance.part].lowest_y(instance.matrix))
        .fold(f64::INFINITY, f64::min);
    let cells = phase.map(|phase| {
        model_cells(
            instances,
            &boxes,
            solids,
            &mut coverers,
            aabb,
            rest_y,
            phase,
        )
    });
    ModelCover {
        visible,
        open_below,
        cells,
    }
}

struct ColumnReach {
    origin: [f64; 2],
    width: usize,
    depth: usize,
    lowest: Vec<f64>,
    highest: Vec<f64>,
    bounded: bool,
}

impl ColumnReach {
    fn new(origin: [f64; 2], width: usize, depth: usize, bounded: bool) -> Self {
        ColumnReach {
            origin,
            width,
            depth,
            lowest: vec![f64::INFINITY; width * depth],
            highest: vec![f64::NEG_INFINITY; width * depth],
            bounded,
        }
    }

    fn brackets(&self, cell: usize, low: f64, high: f64) -> bool {
        self.bounded
            && self.lowest[cell] + CLIPPED_HEIGHT_ROUNDING_LDU <= low
            && high <= self.highest[cell] - CLIPPED_HEIGHT_ROUNDING_LDU
    }

    fn holds_level(&self, cell: usize, y: f64) -> bool {
        self.lowest[cell] <= y && y <= self.highest[cell]
    }

    fn brackets_box(&self, [min, max]: [Vec3; 2]) -> bool {
        let (x0, x1) = overlapping_cells(
            min[0] - CLIPPED_HEIGHT_ROUNDING_LDU,
            max[0] + CLIPPED_HEIGHT_ROUNDING_LDU,
            self.origin[0],
            self.width,
        );
        let (z0, z1) = overlapping_cells(
            min[2] - CLIPPED_HEIGHT_ROUNDING_LDU,
            max[2] + CLIPPED_HEIGHT_ROUNDING_LDU,
            self.origin[1],
            self.depth,
        );
        (z0..z1).all(|j| (x0..x1).all(|i| self.brackets(j * self.width + i, min[1], max[1])))
    }

    fn add_solid(&mut self, solid: &PartSolid, faces: &Faces, matrix: &Affine) {
        let add_unless_face = |reach: &mut Self, t: usize| {
            if !faces.marked[t] {
                reach.add(&solid.tree_points[t].map(|p| matrix.apply(p)));
            }
        };
        for &face in &faces.first {
            self.add(&solid.tree_points[face].map(|p| matrix.apply(p)));
        }
        if solid.tree_points.len() < TREE_WALK_TRIANGLES {
            for t in 0..solid.tree_points.len() {
                add_unless_face(self, t);
            }
            return;
        }
        solid.tree.walk(|bounds, leaf| match leaf {
            Some(range) => {
                for t in range {
                    add_unless_face(self, t);
                }
                false
            }
            None => !self.brackets_box(corner_box(matrix, bounds.min, bounds.max)),
        });
    }

    fn add(&mut self, triangle: &[Vec3; 3]) {
        let span = |axis: usize| {
            triangle
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
                    (lo.min(p[axis]), hi.max(p[axis]))
                })
        };
        let ((lo_x, hi_x), (lo_y, hi_y), (lo_z, hi_z)) = (span(0), span(1), span(2));
        let (x0, x1) = overlapping_cells(lo_x, hi_x, self.origin[0], self.width);
        let (z0, z1) = overlapping_cells(lo_z, hi_z, self.origin[1], self.depth);
        let level = lo_y == hi_y;
        for j in z0..z1 {
            for i in x0..x1 {
                let cell = j * self.width + i;
                if self.brackets(cell, lo_y, hi_y) || (level && self.holds_level(cell, lo_y)) {
                    continue;
                }
                let edge_x = self.origin[0] + STUD_LDU * i as f64;
                let edge_z = self.origin[1] + STUD_LDU * j as f64;
                let inside = clip_to_box(
                    triangle,
                    [
                        edge_x + WELD_EPSILON_LDU,
                        f64::NEG_INFINITY,
                        edge_z + WELD_EPSILON_LDU,
                    ],
                    [
                        edge_x + STUD_LDU - WELD_EPSILON_LDU,
                        f64::INFINITY,
                        edge_z + STUD_LDU - WELD_EPSILON_LDU,
                    ],
                );
                if polygon_area(&inside) <= 0.0 {
                    continue;
                }
                let (points, len) = inside;
                for point in &points[..len] {
                    self.lowest[cell] = self.lowest[cell].min(point[1]);
                    self.highest[cell] = self.highest[cell].max(point[1]);
                }
            }
        }
    }
}

struct Faces {
    first: Vec<usize>,
    marked: Vec<bool>,
}

fn extreme_faces(solid: &PartSolid) -> Faces {
    fn heights(t: &[Vec3; 3]) -> impl Iterator<Item = f64> + '_ {
        t.iter().map(|p| p[1])
    }
    let points = &solid.tree_points;
    let low = points
        .iter()
        .flat_map(heights)
        .fold(f64::INFINITY, f64::min);
    let high = points
        .iter()
        .flat_map(heights)
        .fold(f64::NEG_INFINITY, f64::max);
    let marked: Vec<bool> = points
        .iter()
        .map(|t| heights(t).all(|y| y == low) || heights(t).all(|y| y == high))
        .collect();
    Faces {
        first: (0..points.len()).filter(|&t| marked[t]).collect(),
        marked,
    }
}

fn extremes_first(boxes: &[[Vec3; 2]]) -> Vec<usize> {
    let mut lowest_first: Vec<usize> = (0..boxes.len()).collect();
    lowest_first.sort_by(|&a, &b| boxes[a][0][1].total_cmp(&boxes[b][0][1]));
    let mut highest_first = lowest_first.clone();
    highest_first.sort_by(|&a, &b| boxes[b][1][1].total_cmp(&boxes[a][1][1]));
    let mut taken = vec![false; boxes.len()];
    let mut order = Vec::with_capacity(boxes.len());
    for (&low, &high) in lowest_first.iter().zip(&highest_first) {
        for index in [low, high] {
            if !std::mem::replace(&mut taken[index], true) {
                order.push(index);
            }
        }
    }
    order
}

fn model_cells(
    instances: &[CoverInstance],
    boxes: &[[Vec3; 2]],
    solids: &[PartSolid],
    coverers: &mut Coverers,
    aabb: Bounds,
    bottom_y: f64,
    phase: [u32; 2],
) -> ModelCells {
    let [phase_x, phase_z] = phase.map(f64::from);
    let (first_x, last_x) = cell_range(aabb.min[0], aabb.max[0], phase_x);
    let (first_z, last_z) = cell_range(aabb.min[2], aabb.max[2], phase_z);
    let width = (last_x - first_x + 1) as usize;
    let depth = (last_z - first_z + 1) as usize;
    let origin = [
        phase_x - HALF_STUD_LDU + STUD_LDU * first_x as f64,
        phase_z - HALF_STUD_LDU + STUD_LDU * first_z as f64,
    ];
    let centre = |axis: usize, i: usize| origin[axis] + HALF_STUD_LDU + STUD_LDU * i as f64;

    let mut footprint = Vec::new();
    let mut flat = Vec::new();
    for j in 0..depth {
        for i in 0..width {
            let cell = j * width + i;
            let base = [centre(0, i), bottom_y, centre(1, j)];
            match coverers.covers(StudFrame::upright_at(base), None) {
                None => {}
                Some((CoverKind::AntiStud, _)) => footprint.push(cell),
                Some((CoverKind::Flat, _)) => {
                    footprint.push(cell);
                    flat.push(cell);
                }
            }
        }
    }

    let mut reach = ColumnReach::new(origin, width, depth, coverers.model.coordinates_bounded);
    let mut faces: Vec<Option<Faces>> = solids.iter().map(|_| None).collect();
    for index in extremes_first(boxes) {
        if reach.brackets_box(boxes[index]) {
            continue;
        }
        let instance = &instances[index];
        let solid = &solids[instance.part];
        let faces = faces[instance.part].get_or_insert_with(|| extreme_faces(solid));
        reach.add_solid(solid, faces, instance.matrix);
    }
    let plates = |y: f64| (y - bottom_y) / PLATE_LDU;
    let slack = WELD_EPSILON_LDU / PLATE_LDU;
    let mut column_bottom = vec![EMPTY_COLUMN; width * depth];
    let mut column_top = vec![EMPTY_COLUMN; width * depth];
    for (cell, (&lowest, &highest)) in reach.lowest.iter().zip(&reach.highest).enumerate() {
        if lowest > highest {
            continue;
        }
        column_bottom[cell] = ((plates(lowest) + slack).floor() as i32).max(0);
        column_top[cell] = (plates(highest) - slack).ceil() as i32;
    }

    ModelCells {
        origin,
        width,
        depth,
        bottom_y,
        footprint,
        flat,
        column_bottom,
        column_top,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::{clip_to_box, polygon_area};
    use crate::flatten::Triangle;
    use crate::mesh;

    const STUD: StudShape = StudShape {
        height: 4.0,
        radius: 6.0,
    };
    const OPAQUE: u32 = 4;
    const TRANS_CLEAR: u32 = 47;

    fn quad(out: &mut Vec<Triangle>, [a, b, c, d]: [Vec3; 4]) {
        for points in [[a, b, c], [a, c, d]] {
            out.push(Triangle {
                color: INHERIT_COLOR,
                points,
                double_sided: true,
            });
        }
    }

    fn solid(min: Vec3, max: Vec3, walls_along_z: bool, floor: bool, ceiling: f64) -> PartSolid {
        let [x0, y0, z0] = min;
        let [x1, y1, z1] = max;
        let mut t = Vec::new();
        quad(
            &mut t,
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
        );
        quad(
            &mut t,
            [
                [x0, ceiling, z0],
                [x1, ceiling, z0],
                [x1, ceiling, z1],
                [x0, ceiling, z1],
            ],
        );
        quad(
            &mut t,
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
        );
        quad(
            &mut t,
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
        );
        if walls_along_z {
            quad(
                &mut t,
                [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
            );
            quad(
                &mut t,
                [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            );
        }
        if floor {
            quad(
                &mut t,
                [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            );
        }
        PartSolid::from_mesh(&mesh::build(&t, &[]))
    }

    fn tessellated(min: Vec3, max: Vec3, divisions: usize) -> PartSolid {
        let [x0, y0, z0] = min;
        let [x1, y1, z1] = max;
        let step = |lo: f64, hi: f64, k: usize| lo + (hi - lo) * k as f64 / divisions as f64;
        let mut t = Vec::new();
        for a in 0..divisions {
            for b in 0..divisions {
                let (xa, xb) = (step(x0, x1, a), step(x0, x1, a + 1));
                let (za, zb) = (step(z0, z1, b), step(z0, z1, b + 1));
                for y in [y0, y1] {
                    quad(&mut t, [[xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb]]);
                }
                let xm = (xa + xb) / 2.0;
                let zm = (za + zb) / 2.0;
                quad(
                    &mut t,
                    [
                        [xa, y0, zm],
                        [xb, y0, zm],
                        [xb, y1 - 3.0, zm],
                        [xa, y0 + 1.0, zm],
                    ],
                );
                quad(
                    &mut t,
                    [
                        [xm, y0 + 2.0, za],
                        [xm, y0 + 2.0, zb],
                        [xm, y1 - 2.0, zb],
                        [xm, y1 - 2.0, za],
                    ],
                );
            }
        }
        quad(
            &mut t,
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
        );
        quad(
            &mut t,
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
        );
        quad(
            &mut t,
            [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
        );
        quad(
            &mut t,
            [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
        );
        PartSolid::from_mesh(&mesh::build(&t, &[]))
    }

    fn at(x: f64, y: f64, z: f64) -> Affine {
        Affine {
            m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z],
        }
    }

    fn cover_of(
        solids: &[PartSolid],
        parts: &[(usize, u32, Affine)],
        studs: &[Affine],
        phase: Option<[u32; 2]>,
    ) -> ModelCover {
        let instances: Vec<CoverInstance> = parts
            .iter()
            .enumerate()
            .map(|(i, (part, color, matrix))| CoverInstance {
                matrix,
                color: *color,
                part: *part,
                studs: if i == 0 { studs } else { &[] },
            })
            .collect();
        model_cover(
            &instances,
            solids,
            &Opacity::new([TRANS_CLEAR]),
            phase,
            STUD,
            CoverShard::WHOLE,
        )
    }

    const COLUMN_SCENES: u64 = 12;
    const PIECES_PER_COLUMN_SCENE: u64 = 40;
    const COLUMN_SCENE_STUDS: u64 = 5;

    struct Draws(u64);

    impl Draws {
        fn below(&mut self, count: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) % count
        }

        fn unit(&mut self) -> f64 {
            self.below(1 << 30) as f64 / f64::from(1u32 << 30)
        }
    }

    fn placed_piece(draws: &mut Draws) -> Affine {
        let x = 20.0 * draws.below(COLUMN_SCENE_STUDS) as f64;
        let z = 20.0 * draws.below(COLUMN_SCENE_STUDS) as f64;
        let y = -8.0 * draws.below(8) as f64;
        match draws.below(4) {
            0 => at(
                x + draws.unit() * 7.0,
                y - draws.unit() * 5.0,
                z + draws.unit() * 7.0,
            ),
            1 => Affine {
                m: [0.0, 0.0, 1.0, x, 0.0, 1.0, 0.0, y, -1.0, 0.0, 0.0, z],
            },
            2 => {
                let (sin, cos) = (draws.unit() * 0.6).sin_cos();
                Affine {
                    m: [1.0, 0.0, 0.0, x, 0.0, cos, -sin, y, 0.0, sin, cos, z],
                }
            }
            _ => at(x, y, z),
        }
    }

    fn columns_clipping_every_triangle(
        solids: &[PartSolid],
        parts: &[(usize, u32, Affine)],
        cells: &ModelCells,
    ) -> (Vec<f64>, Vec<f64>) {
        let count = cells.width * cells.depth;
        let (mut lowest, mut highest) =
            (vec![f64::INFINITY; count], vec![f64::NEG_INFINITY; count]);
        for (part, _, matrix) in parts {
            for points in &solids[*part].triangles {
                let triangle = points.map(|p| matrix.apply(p));
                for cell in 0..count {
                    let edge_x = cells.origin[0] + STUD_LDU * (cell % cells.width) as f64;
                    let edge_z = cells.origin[1] + STUD_LDU * (cell / cells.width) as f64;
                    let inside = clip_to_box(
                        &triangle,
                        [
                            edge_x + WELD_EPSILON_LDU,
                            f64::NEG_INFINITY,
                            edge_z + WELD_EPSILON_LDU,
                        ],
                        [
                            edge_x + STUD_LDU - WELD_EPSILON_LDU,
                            f64::INFINITY,
                            edge_z + STUD_LDU - WELD_EPSILON_LDU,
                        ],
                    );
                    if polygon_area(&inside) <= 0.0 {
                        continue;
                    }
                    for point in &inside.0[..inside.1] {
                        lowest[cell] = lowest[cell].min(point[1]);
                        highest[cell] = highest[cell].max(point[1]);
                    }
                }
            }
        }
        (lowest, highest)
    }

    const PROBED_PIECES: u64 = 24;
    const PROBES_PER_PIECE: u64 = 40;
    const EXTRA_DIRECTIONS: u64 = 16;

    fn tilted_piece(draws: &mut Draws) -> Affine {
        let q = [0, 1, 2, 3].map(|_| draws.unit() * 2.0 - 1.0);
        let norm = q.iter().map(|v| v * v).sum::<f64>().sqrt();
        let [w, x, y, z] = q.map(|v| v / norm);
        Affine {
            m: [
                1.0 - 2.0 * (y * y + z * z),
                2.0 * (x * y - w * z),
                2.0 * (x * z + w * y),
                draws.unit() * 100.0,
                2.0 * (x * y + w * z),
                1.0 - 2.0 * (x * x + z * z),
                2.0 * (y * z - w * x),
                draws.unit() * 100.0,
                2.0 * (x * z - w * y),
                2.0 * (y * z + w * x),
                1.0 - 2.0 * (x * x + y * y),
                draws.unit() * 100.0,
            ],
        }
    }

    #[test]
    fn remembered_enclosure_blockers_answer_as_walking_the_part_tree() {
        let solids = [
            solid([-20.0, 0.0, -20.0], [20.0, 24.0, 20.0], true, false, 4.0),
            solid([-20.0, 0.0, -40.0], [20.0, 8.0, 40.0], false, true, 4.0),
            solid([-10.0, 0.0, -10.0], [10.0, 24.0, 10.0], false, false, 12.0),
        ];
        let mut draws = Draws(11);
        let (mut hits, mut misses) = (0, 0);
        let parts: Vec<(usize, u32, Affine)> = (0..PROBED_PIECES)
            .map(|_| {
                let color = if draws.below(4) == 0 {
                    TRANS_CLEAR
                } else {
                    OPAQUE
                };
                (draws.below(3) as usize, color, tilted_piece(&mut draws))
            })
            .collect();
        let instances: Vec<CoverInstance> = parts
            .iter()
            .map(|(part, color, matrix)| CoverInstance {
                matrix,
                color: *color,
                part: *part,
                studs: &[],
            })
            .collect();
        let boxes: Vec<[Vec3; 2]> = instances
            .iter()
            .map(|instance| world_box(instance, &solids[instance.part]))
            .collect();
        let opacity = Opacity::new([TRANS_CLEAR]);
        let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
        let mut coverers = Coverers {
            model: &model,
            stud: STUD,
            directions: enclosure_directions(),
            enclosed: FxHashMap::default(),
            nearby: Vec::new(),
            blockers: Vec::new(),
        };
        for placed in model.placed.iter().flatten() {
            let tree = model.tree(placed);
            let counts = model.counts(placed);
            for _ in 0..PROBES_PER_PIECE {
                let probe = [0, 1, 2].map(|axis| {
                    let [min, max] = [solids[placed.part].min[axis], solids[placed.part].max[axis]];
                    min + (max - min) * (draws.unit() * 1.2 - 0.1)
                });
                let random = (0..EXTRA_DIRECTIONS)
                    .map(|_| unit([0, 1, 2].map(|_| draws.unit() * 2.0 - 1.0)));
                let directions: Vec<Vec3> = enclosure_directions()
                    .into_iter()
                    .chain([DOWN])
                    .chain(random)
                    .collect();
                for direction in directions {
                    let ray = Ray {
                        origin: probe,
                        direction,
                        reach: f64::INFINITY,
                    };
                    let walked = tree.first_hit(&ray, &counts).is_some();
                    assert_eq!(coverers.hits(placed, probe, direction), walked);
                    if walked {
                        hits += 1;
                    } else {
                        misses += 1;
                    }
                }
            }
        }
        assert!(hits > 1000 && misses > 1000, "{hits} hits, {misses} misses");
    }

    #[test]
    fn two_probes_closer_than_a_thousandth_keep_their_own_enclosures() {
        let solids = [solid(
            [-20.0, 0.0, -20.0],
            [20.0, 24.0, 20.0],
            true,
            false,
            4.0,
        )];
        let instances = [CoverInstance {
            matrix: &Affine::IDENTITY,
            color: OPAQUE,
            part: 0,
            studs: &[],
        }];
        let boxes = [world_box(&instances[0], &solids[0])];
        let opacity = Opacity::new([TRANS_CLEAR]);
        let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
        let placed = model.placed[0].as_ref().expect("an invertible placement");
        let fresh = || Coverers {
            model: &model,
            stud: STUD,
            directions: enclosure_directions(),
            enclosed: FxHashMap::default(),
            nearby: Vec::new(),
            blockers: Vec::new(),
        };
        let inside_wall = [20.0 - 4e-4, 2.0, 0.0];
        let outside_wall = [20.0 + 4e-4, 2.0, 0.0];
        let alone = [inside_wall, outside_wall].map(|probe| fresh().enclosure(placed, probe));
        assert_eq!(alone, [Some(CoverKind::AntiStud), None]);
        for order in [[0, 1], [1, 0]] {
            let mut coverers = fresh();
            for index in order {
                let probe = [inside_wall, outside_wall][index];
                assert_eq!(
                    coverers.probe(placed, probe),
                    alone[index],
                    "probe {probe:?}"
                );
            }
        }
    }

    #[test]
    fn every_column_matches_clipping_every_triangle_into_every_cell() {
        let solids = [
            solid([-20.0, 0.0, -20.0], [20.0, 24.0, 20.0], true, false, 4.0),
            solid([-20.0, 0.0, -40.0], [20.0, 8.0, 40.0], true, true, 4.0),
            solid([-10.0, 0.0, -10.0], [10.0, 24.0, 10.0], false, true, 12.0),
            tessellated([-40.0, 0.0, -40.0], [40.0, 8.0, 40.0], 4),
        ];
        let walked = solids.len() - 1;
        assert!(solids[walked].tree_points.len() >= TREE_WALK_TRIANGLES);
        let walls = [[-40.0, 2.0, -40.0], [40.0, 6.0, 40.0]];
        let mut draws = Draws(7);
        let mut inside_known_heights = 0;
        let mut walls_inside_known_heights = 0;
        for _ in 0..COLUMN_SCENES {
            let parts: Vec<(usize, u32, Affine)> = (0..PIECES_PER_COLUMN_SCENE)
                .map(|_| {
                    let part = draws.below(solids.len() as u64) as usize;
                    (part, OPAQUE, placed_piece(&mut draws))
                })
                .collect();
            let cells = cover_of(&solids, &parts, &[], Some([0, 0]))
                .cells
                .expect("a phase gives cells");
            let (lowest, highest) = columns_clipping_every_triangle(&solids, &parts, &cells);
            let plates = |y: f64| (y - cells.bottom_y) / PLATE_LDU;
            let slack = WELD_EPSILON_LDU / PLATE_LDU;
            for cell in 0..cells.width * cells.depth {
                let (bottom, top) = if lowest[cell] > highest[cell] {
                    (EMPTY_COLUMN, EMPTY_COLUMN)
                } else {
                    (
                        ((plates(lowest[cell]) + slack).floor() as i32).max(0),
                        (plates(highest[cell]) - slack).ceil() as i32,
                    )
                };
                assert_eq!(
                    (cells.column_bottom[cell], cells.column_top[cell]),
                    (bottom, top),
                    "cell {cell}"
                );
            }
            let inside = |[min, max]: [Vec3; 2]| {
                let (x0, x1) = overlapping_cells(min[0], max[0], cells.origin[0], cells.width);
                let (z0, z1) = overlapping_cells(min[2], max[2], cells.origin[1], cells.depth);
                (z0..z1).all(|j| {
                    (x0..x1).all(|i| {
                        let cell = j * cells.width + i;
                        lowest[cell] + CLIPPED_HEIGHT_ROUNDING_LDU <= min[1]
                            && max[1] <= highest[cell] - CLIPPED_HEIGHT_ROUNDING_LDU
                    })
                })
            };
            for (part, _, matrix) in &parts {
                let instance = CoverInstance {
                    matrix,
                    color: OPAQUE,
                    part: *part,
                    studs: &[],
                };
                inside_known_heights += usize::from(inside(world_box(&instance, &solids[*part])));
                if *part == walked {
                    walls_inside_known_heights +=
                        usize::from(inside(corner_box(matrix, walls[0], walls[1])));
                }
            }
        }
        assert!(
            inside_known_heights > 20,
            "{inside_known_heights} pieces lie strictly inside their columns' heights"
        );
        assert!(
            walls_inside_known_heights > 20,
            "{walls_inside_known_heights} tessellated pieces have walls strictly inside their columns' heights"
        );
    }

    #[test]
    fn a_box_within_rounding_of_an_unknown_cell_or_height_is_never_skipped() {
        let mut reach = ColumnReach::new([0.0, 0.0], 2, 1, true);
        reach.lowest[0] = 0.0;
        reach.highest[0] = 10.0;
        let next_square = STUD_LDU + WELD_EPSILON_LDU;
        let short_of_next = |gap: f64| {
            [
                [WELD_EPSILON_LDU + 1.0, 2.0, WELD_EPSILON_LDU + 1.0],
                [next_square - gap, 8.0, STUD_LDU - WELD_EPSILON_LDU - 1.0],
            ]
        };
        assert!(reach.brackets_box(short_of_next(10.0 * CLIPPED_HEIGHT_ROUNDING_LDU)));
        assert!(!reach.brackets_box(short_of_next(CLIPPED_HEIGHT_ROUNDING_LDU / 2.0)));
        let mut touching = short_of_next(10.0 * CLIPPED_HEIGHT_ROUNDING_LDU);
        touching[1][1] = reach.highest[0];
        assert!(!reach.brackets_box(touching));
    }

    #[test]
    fn a_stud_is_covered_only_when_one_opaque_part_encloses_it_and_it_is_closed_below() {
        let solids = [
            solid([-200.0, -16.0, -40.0], [0.0, -8.0, 40.0], true, true, -8.0),
            solid([-60.0, -8.0, -20.0], [-20.0, 0.0, 20.0], true, false, -4.0),
            solid([-20.0, -8.0, -20.0], [20.0, 0.0, 20.0], true, false, -4.0),
            solid(
                [-140.0, -8.0, -20.0],
                [-100.0, 0.0, 20.0],
                false,
                false,
                -4.0,
            ),
        ];
        let studs = [
            at(-50.0, -8.0, -10.0),
            at(-50.0, -16.0, -10.0),
            at(-23.0, -8.0, 10.0),
            at(-130.0, -8.0, 10.0),
            at(-10.0, -8.0, -10.0),
        ];
        let identity = Affine::IDENTITY;
        let parts = [
            (0, OPAQUE, identity),
            (1, OPAQUE, identity),
            (2, OPAQUE, identity),
            (3, OPAQUE, identity),
        ];
        assert_eq!(
            cover_of(&solids, &parts, &studs, None).visible,
            [false, true, true, true, true],
            "covered, one plate lower, rim outside the wall, open-sided arch, overhang open below"
        );
        let glass = [(0, OPAQUE, identity), (1, TRANS_CLEAR, identity)];
        assert_eq!(
            cover_of(&solids, &glass, &studs[..1], None).visible,
            [true],
            "a translucent part covers nothing"
        );
    }

    #[test]
    fn footprint_cells_tell_hollow_undersides_from_solid_bottoms() {
        let solids = [
            solid([-20.0, -8.0, -20.0], [20.0, 0.0, 20.0], true, false, -4.0),
            solid([20.0, -8.0, -20.0], [60.0, -4.0, 20.0], true, true, -4.0),
        ];
        let identity = Affine::IDENTITY;
        let parts = [(0, OPAQUE, identity), (1, OPAQUE, identity)];
        let cells = cover_of(&solids, &parts, &[], Some([10, 10]))
            .cells
            .expect("a phase gives cells");
        assert_eq!([cells.width, cells.depth], [4, 2]);
        assert_eq!(cells.footprint, [0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(cells.flat, [2, 3, 6, 7]);
        assert_eq!(cells.column_top, [1, 1, 1, 1, 1, 1, 1, 1]);
    }

    #[test]
    fn the_rest_plane_is_the_lowest_transformed_vertex_of_any_part() {
        let solids = [solid(
            [-20.0, -8.0, -20.0],
            [20.0, 0.0, 20.0],
            true,
            true,
            -8.0,
        )];
        let (sin, cos) = 30.0_f64.to_radians().sin_cos();
        let tilted = Affine {
            m: [
                1.0, 0.0, 0.0, 100.0, 0.0, cos, -sin, -10.0, 0.0, sin, cos, 0.0,
            ],
        };
        let parts = [(0, OPAQUE, Affine::IDENTITY), (0, OPAQUE, tilted)];
        let cells = cover_of(&solids, &parts, &[], Some([10, 10]))
            .cells
            .expect("a phase gives cells");
        let lowest = -10.0 - 8.0 * cos - 20.0 * sin;
        assert!((cells.bottom_y - lowest).abs() < 1e-9, "{}", cells.bottom_y);
    }

    fn closed_below_testing_every_instance(model: &ModelSolids, stud: StudFrame) -> bool {
        stud.radials().into_iter().all(|radial| {
            (0..BELOW_HEIGHT_STEPS).all(|level| {
                let fraction = (level as f64 + 0.5) / BELOW_HEIGHT_STEPS as f64;
                let origin = stud.at(
                    STUD.height * fraction,
                    radial,
                    STUD.radius * BELOW_START_OUTSIDE,
                );
                (1..=BELOW_ELEVATION_STEPS).all(|step| {
                    let (rise, run) = (-BELOW_ELEVATION_STEP_DEGREES * step as f64)
                        .to_radians()
                        .sin_cos();
                    let direction = [0, 1, 2].map(|axis| radial[axis] * run + stud.up[axis] * rise);
                    let segment = Segment::new(origin, direction, BELOW_REACH_LDU);
                    (0..model.placed.len())
                        .any(|instance| model.first_blocker(instance, &segment).is_some())
                })
            })
        })
    }

    #[test]
    fn the_certifier_closes_exactly_the_studs_casting_through_every_instance_closes() {
        let solids = [
            solid(
                [-120.0, -16.0, -120.0],
                [120.0, -8.0, 120.0],
                true,
                true,
                -8.0,
            ),
            solid([-20.0, -8.0, -20.0], [20.0, 0.0, 20.0], true, false, -4.0),
            solid([-40.0, -8.0, -20.0], [40.0, 0.0, 20.0], true, false, -4.0),
        ];
        let slab_studs: Vec<Affine> = (0..12)
            .flat_map(|i| (0..12).map(move |j| (i, j)))
            .map(|(i, j)| {
                at(
                    -110.0 + 20.0 * f64::from(i),
                    -8.0,
                    -110.0 + 20.0 * f64::from(j),
                )
            })
            .collect();
        let brick_studs = [-10.0, 10.0].map(|x| [-10.0, 10.0].map(|z| at(x, 0.0, z)));
        let brick_studs = brick_studs.as_flattened();
        let quarter_turn = Affine {
            m: [
                0.0, 0.0, 1.0, -20.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 40.0,
            ],
        };
        let placements = [
            (0, OPAQUE, Affine::IDENTITY, slab_studs.as_slice()),
            (1, OPAQUE, at(-60.0, 0.0, -60.0), brick_studs),
            (1, TRANS_CLEAR, at(-20.0, 0.0, -60.0), brick_studs),
            (1, OPAQUE, at(120.0, 0.0, 0.0), brick_studs),
            (2, OPAQUE, quarter_turn, &[]),
            (1, OPAQUE, at(-60.0, 8.0, -60.0), &[]),
            (1, OPAQUE, at(-40.0, 8.0, -60.0), &[]),
        ];
        let instances: Vec<CoverInstance> = placements
            .iter()
            .map(|(part, color, matrix, studs)| CoverInstance {
                matrix,
                color: *color,
                part: *part,
                studs,
            })
            .collect();
        let boxes: Vec<[Vec3; 2]> = instances
            .iter()
            .map(|instance| world_box(instance, &solids[instance.part]))
            .collect();
        let opacity = Opacity::new([TRANS_CLEAR]);
        let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
        let mut coverers = Coverers {
            model: &model,
            stud: STUD,
            directions: enclosure_directions(),
            enclosed: FxHashMap::default(),
            nearby: Vec::new(),
            blockers: Vec::new(),
        };
        let mut certifier = BelowCertifier::new(&model, STUD);
        let mut decided = [0, 0];
        for (owner, instance) in instances.iter().enumerate() {
            for stud in instance.studs {
                let world = instance.matrix.then(stud);
                let frame = StudFrame::of(&world);
                let Some((_, coverer)) = coverers.covers(frame, Some(owner)) else {
                    continue;
                };
                let below = BelowStud {
                    frame,
                    rotation: rotation_bits(&world),
                    owner,
                    coverer,
                };
                let closed = closed_below_testing_every_instance(&model, frame);
                assert_eq!(certifier.closed(&below), closed, "stud at {:?}", frame.base);
                decided[usize::from(closed)] += 1;
            }
        }
        assert!(
            decided[0] > 0 && decided[1] > 0,
            "the model has both open and closed covered studs: {decided:?}"
        );
    }
}
