use std::collections::{HashMap, HashSet};
use std::thread;

use crate::affine::{Affine, Vec3};
use crate::flatten::INHERIT_COLOR;
use crate::lattice::STUD_LDU;
use crate::mesh::{Mesh, WELD_EPSILON_LDU};
use crate::solid::{solid_samples, SolidGrid, SolidInstance, SolidSamples};

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
const PROBE_KEY_SCALE: f64 = 1_000.0;
const RIM_PROBE_FRACTION: f64 = 0.9;
const HIT_EPSILON: f64 = 1e-9;
const EDGE_TOLERANCE: f64 = 1e-9;
const LEAF_TRIANGLES: usize = 4;
const UP: Vec3 = [0.0, 1.0, 0.0];
const DOWN: Vec3 = [0.0, -1.0, 0.0];

pub struct Opacity {
    transparent: HashSet<u32>,
}

impl Opacity {
    pub fn new(transparent: impl IntoIterator<Item = u32>) -> Self {
        Opacity {
            transparent: transparent.into_iter().collect(),
        }
    }

    fn opaque(&self, code: u32, instance_color: u32) -> bool {
        let resolved = if code == INHERIT_COLOR {
            instance_color
        } else {
            code
        };
        !self.transparent.contains(&resolved)
    }
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn unit(v: Vec3) -> Vec3 {
    let length = dot(v, v).sqrt();
    v.map(|c| c / length)
}

fn ray_distance(origin: Vec3, direction: Vec3, points: &[Vec3; 3]) -> Option<f64> {
    let edge1 = sub(points[1], points[0]);
    let edge2 = sub(points[2], points[0]);
    let p = cross(direction, edge2);
    let determinant = dot(edge1, p);
    if determinant.abs() < HIT_EPSILON {
        return None;
    }
    let inverse = 1.0 / determinant;
    let s = sub(origin, points[0]);
    let u = dot(s, p) * inverse;
    if !(-EDGE_TOLERANCE..=1.0 + EDGE_TOLERANCE).contains(&u) {
        return None;
    }
    let q = cross(s, edge1);
    let v = dot(direction, q) * inverse;
    if v < -EDGE_TOLERANCE || u + v > 1.0 + EDGE_TOLERANCE {
        return None;
    }
    let t = dot(edge2, q) * inverse;
    (t > HIT_EPSILON).then_some(t)
}

#[derive(Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

impl Bounds {
    const EMPTY: Bounds = Bounds {
        min: [f64::INFINITY; 3],
        max: [f64::NEG_INFINITY; 3],
    };

    fn grow(self, p: Vec3) -> Self {
        Bounds {
            min: [0, 1, 2].map(|axis| self.min[axis].min(p[axis])),
            max: [0, 1, 2].map(|axis| self.max[axis].max(p[axis])),
        }
    }

    fn entry(&self, origin: Vec3, direction: Vec3, reach: f64) -> Option<f64> {
        let mut near = 0.0_f64;
        let mut far = reach;
        for axis in 0..3 {
            if direction[axis] == 0.0 {
                if origin[axis] < self.min[axis] || origin[axis] > self.max[axis] {
                    return None;
                }
                continue;
            }
            let a = (self.min[axis] - origin[axis]) / direction[axis];
            let b = (self.max[axis] - origin[axis]) / direction[axis];
            near = near.max(a.min(b));
            far = far.min(a.max(b));
            if near > far {
                return None;
            }
        }
        Some(near)
    }
}

enum Node {
    Leaf {
        bounds: Bounds,
        triangles: Vec<usize>,
    },
    Branch {
        bounds: Bounds,
        children: Box<[Node; 2]>,
    },
}

impl Node {
    fn build(mut triangles: Vec<usize>, points: &[[Vec3; 3]]) -> Node {
        let bounds = triangles
            .iter()
            .flat_map(|&t| points[t])
            .fold(Bounds::EMPTY, Bounds::grow);
        if triangles.len() <= LEAF_TRIANGLES {
            return Node::Leaf { bounds, triangles };
        }
        let extent = sub(bounds.max, bounds.min);
        let axis = (0..3)
            .max_by(|&a, &b| extent[a].total_cmp(&extent[b]))
            .unwrap_or(0);
        let centre = |t: usize| points[t].iter().map(|p| p[axis]).sum::<f64>();
        triangles.sort_by(|&a, &b| centre(a).total_cmp(&centre(b)));
        let upper = triangles.split_off(triangles.len() / 2);
        Node::Branch {
            bounds,
            children: Box::new([Node::build(triangles, points), Node::build(upper, points)]),
        }
    }

    fn hits(
        &self,
        origin: Vec3,
        direction: Vec3,
        reach: f64,
        solid: &PartSolid,
        counts: &dyn Fn(u32) -> bool,
    ) -> bool {
        match self {
            Node::Leaf { bounds, triangles } => {
                bounds.entry(origin, direction, reach).is_some()
                    && triangles.iter().any(|&t| {
                        counts(solid.colors[t])
                            && ray_distance(origin, direction, &solid.triangles[t])
                                .is_some_and(|d| d <= reach)
                    })
            }
            Node::Branch { bounds, children } => {
                bounds.entry(origin, direction, reach).is_some()
                    && children
                        .iter()
                        .any(|child| child.hits(origin, direction, reach, solid, counts))
            }
        }
    }
}

pub struct PartSolid {
    triangles: Vec<[Vec3; 3]>,
    colors: Vec<u32>,
    tree: Option<Node>,
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
        let tree = (!triangles.is_empty())
            .then(|| Node::build((0..triangles.len()).collect(), &triangles));
        let [min, max] = mesh
            .bounds()
            .unwrap_or([[0.0; 3]; 2])
            .map(|corner| corner.map(f64::from));
        PartSolid {
            triangles,
            colors,
            tree,
            min,
            max,
        }
    }

    fn hits(
        &self,
        origin: Vec3,
        direction: Vec3,
        reach: f64,
        counts: &dyn Fn(u32) -> bool,
    ) -> bool {
        self.tree
            .as_ref()
            .is_some_and(|tree| tree.hits(origin, direction, reach, self, counts))
    }

    pub(crate) fn triangles(&self) -> &[[Vec3; 3]] {
        &self.triangles
    }

    pub(crate) fn blocks(&self, origin: Vec3, direction: Vec3) -> bool {
        self.hits(origin, direction, f64::INFINITY, &|_| true)
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

    fn below_rays(&self, shape: StudShape) -> Vec<(Vec3, Vec3)> {
        let mut rays = Vec::new();
        for radial in self.radials() {
            for level in 0..BELOW_HEIGHT_STEPS {
                let fraction = (level as f64 + 0.5) / BELOW_HEIGHT_STEPS as f64;
                let origin = self.at(
                    shape.height * fraction,
                    radial,
                    shape.radius * BELOW_START_OUTSIDE,
                );
                for step in 1..=BELOW_ELEVATION_STEPS {
                    let elevation = -BELOW_ELEVATION_STEP_DEGREES * step as f64;
                    let (rise, run) = elevation.to_radians().sin_cos();
                    let direction = [0, 1, 2].map(|axis| radial[axis] * run + self.up[axis] * rise);
                    rays.push((origin, direction));
                }
            }
        }
        rays
    }
}

pub struct CoverInstance<'a> {
    pub matrix: &'a Affine,
    pub color: u32,
    pub part: usize,
    pub studs: &'a [Affine],
    pub baseplate: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCells {
    pub origin: [f64; 2],
    pub width: usize,
    pub depth: usize,
    pub bottom_y: f64,
    pub ground_y: Option<f64>,
    pub footprint: Vec<usize>,
    pub flat: Vec<usize>,
    pub column_bottom: Vec<i32>,
    pub column_top: Vec<i32>,
    pub solid: SolidSamples,
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

fn up_of(matrix: &Affine) -> Vec3 {
    unit([matrix.m[1], matrix.m[5], matrix.m[9]])
}

pub(crate) fn inverse(matrix: &Affine) -> Option<Affine> {
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
    let mut bounds = Bounds::EMPTY;
    for i in 0..8 {
        let pick = |bit: usize, axis: usize| {
            if i & bit == 0 {
                solid.min[axis]
            } else {
                solid.max[axis]
            }
        };
        bounds = bounds.grow(instance.matrix.apply([pick(1, 0), pick(2, 1), pick(4, 2)]));
    }
    [bounds.min, bounds.max]
}

type BroadKey = (i64, i64, i64);
type ProbeKey = (usize, u32, i64, i64, i64);

fn broad_cell(v: f64) -> i64 {
    (v / BROAD_CELL_LDU).floor() as i64
}

struct Placed {
    part: usize,
    color: u32,
    inverse: Affine,
    up: Vec3,
    min: Vec3,
    max: Vec3,
}

struct ModelSolids<'a> {
    solids: &'a [PartSolid],
    opacity: &'a Opacity,
    placed: Vec<Option<Placed>>,
    grid: HashMap<BroadKey, Vec<usize>>,
}

impl<'a> ModelSolids<'a> {
    fn new(
        instances: &[CoverInstance],
        boxes: &[[Vec3; 2]],
        solids: &'a [PartSolid],
        opacity: &'a Opacity,
    ) -> Self {
        let mut grid: HashMap<BroadKey, Vec<usize>> = HashMap::new();
        let placed = instances
            .iter()
            .zip(boxes)
            .enumerate()
            .map(|(i, (instance, [min, max]))| {
                let inverse = inverse(instance.matrix)?;
                let lo = min.map(|v| broad_cell(v - WELD_EPSILON_LDU));
                let hi = max.map(|v| broad_cell(v + WELD_EPSILON_LDU));
                for x in lo[0]..=hi[0] {
                    for y in lo[1]..=hi[1] {
                        for z in lo[2]..=hi[2] {
                            grid.entry((x, y, z)).or_default().push(i);
                        }
                    }
                }
                Some(Placed {
                    part: instance.part,
                    color: instance.color,
                    inverse,
                    up: up_of(instance.matrix),
                    min: *min,
                    max: *max,
                })
            })
            .collect();
        ModelSolids {
            solids,
            opacity,
            placed,
            grid,
        }
    }

    fn hits(&self, i: usize, origin: Vec3, direction: Vec3, reach: f64) -> bool {
        let Some(placed) = &self.placed[i] else {
            return false;
        };
        let local_origin = placed.inverse.apply(origin);
        let local_end = placed
            .inverse
            .apply([0, 1, 2].map(|axis| origin[axis] + direction[axis] * reach));
        let span = sub(local_end, local_origin);
        let length = dot(span, span).sqrt();
        if length == 0.0 {
            return false;
        }
        let local_direction = span.map(|v| v / length);
        let color = placed.color;
        self.solids[placed.part].hits(local_origin, local_direction, length, &|code| {
            self.opacity.opaque(code, color)
        })
    }

    fn blocked_within(
        &self,
        origin: Vec3,
        direction: Vec3,
        reach: f64,
        seen: &mut Vec<usize>,
    ) -> bool {
        let end = [0, 1, 2].map(|axis| origin[axis] + direction[axis] * reach);
        let lo = [0, 1, 2].map(|axis| broad_cell(origin[axis].min(end[axis])));
        let hi = [0, 1, 2].map(|axis| broad_cell(origin[axis].max(end[axis])));
        seen.clear();
        let mut cells = Vec::new();
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    cells.push((x, y, z));
                }
            }
        }
        let start = (
            broad_cell(origin[0]),
            broad_cell(origin[1]),
            broad_cell(origin[2]),
        );
        cells.sort_by_key(|&(x, y, z)| {
            (x - start.0).abs() + (y - start.1).abs() + (z - start.2).abs()
        });
        for cell in cells {
            for &i in self.grid.get(&cell).map(Vec::as_slice).unwrap_or(&[]) {
                if seen.contains(&i) {
                    continue;
                }
                seen.push(i);
                if self.hits(i, origin, direction, reach) {
                    return true;
                }
            }
        }
        false
    }

    fn closed_below(&self, stud: StudFrame, shape: StudShape) -> bool {
        let mut seen = Vec::new();
        stud.below_rays(shape)
            .into_iter()
            .all(|(origin, direction)| {
                self.blocked_within(origin, direction, BELOW_REACH_LDU, &mut seen)
            })
    }
}

struct Coverers<'a, 'b> {
    model: &'b ModelSolids<'a>,
    stud: StudShape,
    directions: Vec<Vec3>,
    enclosed: HashMap<ProbeKey, Option<CoverKind>>,
}

impl Coverers<'_, '_> {
    fn enclosure(&self, placed: &Placed, probe: Vec3) -> Option<CoverKind> {
        let solid = &self.model.solids[placed.part];
        let opacity = self.model.opacity;
        let counts = |code: u32| opacity.opaque(code, placed.color);
        let enclosed = self
            .directions
            .iter()
            .all(|direction| solid.hits(probe, *direction, f64::INFINITY, &counts));
        match (enclosed, solid.hits(probe, DOWN, f64::INFINITY, &counts)) {
            (false, _) => None,
            (true, false) => Some(CoverKind::AntiStud),
            (true, true) => Some(CoverKind::Flat),
        }
    }

    fn covers(&mut self, stud: StudFrame, owner: Option<usize>) -> Option<CoverKind> {
        let StudFrame { base, up, .. } = stud;
        let probes = stud.probes(self.stud);
        let key = (
            broad_cell(base[0]),
            broad_cell(base[1]),
            broad_cell(base[2]),
        );
        let model = self.model;
        let candidates = model.grid.get(&key)?;
        for &i in candidates {
            if Some(i) == owner {
                continue;
            }
            let Some(placed) = &model.placed[i] else {
                continue;
            };
            let inside = (0..3).all(|axis| {
                base[axis] >= placed.min[axis] - WELD_EPSILON_LDU
                    && base[axis] <= placed.max[axis] + WELD_EPSILON_LDU
            });
            if !inside || dot(up, placed.up) < UPRIGHT_COSINE {
                continue;
            }
            let solid = &model.solids[placed.part];
            let local_base = placed.inverse.apply(base);
            if (local_base[1] - solid.min[1]).abs() > WELD_EPSILON_LDU {
                continue;
            }
            let mut centre = None;
            for (k, probe) in probes.iter().enumerate() {
                let local = placed.inverse.apply(*probe);
                let probe_key = (
                    placed.part,
                    placed.color,
                    (local[0] * PROBE_KEY_SCALE).round() as i64,
                    (local[1] * PROBE_KEY_SCALE).round() as i64,
                    (local[2] * PROBE_KEY_SCALE).round() as i64,
                );
                let enclosure = match self.enclosed.get(&probe_key) {
                    Some(known) => *known,
                    None => {
                        let found = self.enclosure(placed, local);
                        self.enclosed.insert(probe_key, found);
                        found
                    }
                };
                if enclosure.is_none() {
                    centre = None;
                    break;
                }
                if k == 0 {
                    centre = enclosure;
                }
            }
            if centre.is_some() {
                return centre;
            }
        }
        None
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

fn closed_below_all(
    model: &ModelSolids,
    candidates: &[(usize, StudFrame)],
    shape: StudShape,
) -> Vec<bool> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let workers = thread::available_parallelism().map_or(1, |n| n.get());
    let chunk = candidates.len().div_ceil(workers);
    let mut closed = vec![false; candidates.len()];
    thread::scope(|scope| {
        for (slice, out) in candidates.chunks(chunk).zip(closed.chunks_mut(chunk)) {
            scope.spawn(move || {
                for ((_, stud), result) in slice.iter().zip(out.iter_mut()) {
                    *result = model.closed_below(*stud, shape);
                }
            });
        }
    });
    closed
}

fn ground_top(instances: &[CoverInstance], boxes: &[[Vec3; 2]], rest_y: f64) -> Option<f64> {
    let upright = |instance: &CoverInstance| dot(up_of(instance.matrix), UP) >= UPRIGHT_COSINE;
    let lowest = instances
        .iter()
        .zip(boxes)
        .filter(|(instance, _)| upright(instance))
        .map(|(_, [min, _])| min[1])
        .fold(f64::INFINITY, f64::min);
    if rest_y < lowest - WELD_EPSILON_LDU {
        return None;
    }
    let mut top: Option<f64> = None;
    for (instance, [min, max]) in instances.iter().zip(boxes) {
        if !upright(instance) || (min[1] - lowest).abs() > WELD_EPSILON_LDU {
            continue;
        }
        if !instance.baseplate {
            return None;
        }
        match top {
            None => top = Some(max[1]),
            Some(level) if (level - max[1]).abs() <= WELD_EPSILON_LDU => {}
            Some(_) => return None,
        }
    }
    top
}

pub fn model_cover(
    instances: &[CoverInstance],
    solids: &[PartSolid],
    with_studs: &[PartSolid],
    opacity: &Opacity,
    phase: Option<[u32; 2]>,
    stud: StudShape,
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
        enclosed: HashMap::new(),
    };

    let mut visible = Vec::new();
    let mut candidates = Vec::new();
    for (owner, instance) in instances.iter().enumerate() {
        for stud_matrix in instance.studs {
            let frame = StudFrame::of(&instance.matrix.then(stud_matrix));
            if coverers.covers(frame, Some(owner)).is_some() {
                candidates.push((visible.len(), frame));
            }
            visible.push(true);
        }
    }
    let closed = closed_below_all(&model, &candidates, stud);
    let mut open_below = 0;
    for ((index, _), closed) in candidates.iter().zip(closed) {
        if closed {
            visible[*index] = false;
        } else {
            open_below += 1;
        }
    }
    let rest_y = instances
        .iter()
        .map(|instance| solids[instance.part].lowest_y(instance.matrix))
        .fold(f64::INFINITY, f64::min);
    let ground_y = ground_top(instances, &boxes, rest_y);
    let placed: Vec<SolidInstance> = instances
        .iter()
        .map(|instance| SolidInstance {
            matrix: instance.matrix,
            part: instance.part,
        })
        .collect();
    let cells = phase.map(|phase| {
        model_cells(
            &boxes,
            &mut coverers,
            SolidModel {
                instances: &placed,
                parts: with_studs,
            },
            aabb,
            rest_y,
            ground_y,
            phase,
        )
    });
    ModelCover {
        visible,
        open_below,
        cells,
    }
}

struct SolidModel<'a> {
    instances: &'a [SolidInstance<'a>],
    parts: &'a [PartSolid],
}

fn model_cells(
    boxes: &[[Vec3; 2]],
    coverers: &mut Coverers,
    solid: SolidModel,
    aabb: Bounds,
    bottom_y: f64,
    ground_y: Option<f64>,
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
                Some(CoverKind::AntiStud) => footprint.push(cell),
                Some(CoverKind::Flat) => {
                    footprint.push(cell);
                    flat.push(cell);
                }
            }
        }
    }

    let mut column_bottom = vec![EMPTY_COLUMN; width * depth];
    let mut column_top = vec![EMPTY_COLUMN; width * depth];
    let datum_y = ground_y.unwrap_or(bottom_y);
    let plates = |y: f64| (y - datum_y) / PLATE_LDU;
    let slack = WELD_EPSILON_LDU / PLATE_LDU;
    for [min, max] in boxes {
        let (x0, x1) = overlapping_cells(min[0], max[0], origin[0], width);
        let (z0, z1) = overlapping_cells(min[2], max[2], origin[1], depth);
        let bottom = ((plates(min[1]) + slack).floor() as i32).max(0);
        let top = (plates(max[1]) - slack).ceil() as i32;
        for j in z0..z1 {
            for i in x0..x1 {
                let cell = j * width + i;
                column_bottom[cell] = if column_bottom[cell] == EMPTY_COLUMN {
                    bottom
                } else {
                    column_bottom[cell].min(bottom)
                };
                column_top[cell] = column_top[cell].max(top);
            }
        }
    }

    ModelCells {
        origin,
        width,
        depth,
        bottom_y,
        ground_y,
        footprint,
        flat,
        column_bottom,
        column_top,
        solid: solid_samples(
            solid.instances,
            solid.parts,
            SolidGrid {
                origin,
                width,
                depth,
                datum_y,
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                baseplate: false,
            })
            .collect();
        model_cover(
            &instances,
            solids,
            solids,
            &Opacity::new([TRANS_CLEAR]),
            phase,
            STUD,
        )
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

    #[test]
    fn a_model_standing_on_its_own_baseplates_measures_columns_from_their_top() {
        let solids = [
            solid([-20.0, -4.0, -20.0], [60.0, 0.0, 20.0], true, true, -4.0),
            solid([-20.0, 0.0, -20.0], [20.0, 24.0, 20.0], true, false, 20.0),
            solid([60.0, -4.0, -20.0], [100.0, 20.0, 20.0], true, true, 16.0),
        ];
        let identity = Affine::IDENTITY;
        let (sin, cos) = 30.0_f64.to_radians().sin_cos();
        let tilted = Affine {
            m: [
                1.0, 0.0, 0.0, 0.0, 0.0, cos, -sin, -10.0, 0.0, sin, cos, 0.0,
            ],
        };
        let cover = |parts: &[(usize, bool, &Affine)]| {
            let instances: Vec<CoverInstance> = parts
                .iter()
                .map(|&(part, baseplate, matrix)| CoverInstance {
                    matrix,
                    color: OPAQUE,
                    part,
                    studs: &[],
                    baseplate,
                })
                .collect();
            model_cover(
                &instances,
                &solids,
                &solids,
                &Opacity::new([TRANS_CLEAR]),
                Some([10, 10]),
                STUD,
            )
            .cells
            .expect("a phase gives cells")
        };
        let on_baseplate = cover(&[(0, true, &identity), (1, false, &identity)]);
        assert_eq!(on_baseplate.ground_y, Some(0.0));
        assert_eq!(on_baseplate.bottom_y, -4.0);
        assert_eq!(on_baseplate.column_top, [3, 3, 0, 0, 3, 3, 0, 0]);
        let beside_a_brick = cover(&[
            (0, true, &identity),
            (1, false, &identity),
            (2, false, &identity),
        ]);
        assert_eq!(
            beside_a_brick.ground_y, None,
            "a brick also stands on the rest plane"
        );
        let over_a_tilted_part = cover(&[(0, true, &identity), (1, false, &tilted)]);
        assert_eq!(
            over_a_tilted_part.ground_y, None,
            "a tilted part reaches below the baseplate"
        );
    }
}
