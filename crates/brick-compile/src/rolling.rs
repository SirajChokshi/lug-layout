use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::flatten::{Flattener, Library, Lod, Triangle};
use crate::sixteenths;

const IDENTIFY_LDU: f64 = 0.0005;
const HALF_STEP_LDU: f64 = 0.5 / sixteenths::PER_LDU as f64;
const AXES: [usize; 3] = [0, 1, 2];
const FOLD_MULTIPLIER: u64 = 0x517c_c1b7_2722_0a95;

#[derive(Default)]
struct FoldHasher(u64);

impl FoldHasher {
    fn mix(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(FOLD_MULTIPLIER);
    }
}

impl Hasher for FoldHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.mix(u64::from(byte));
        }
    }

    fn write_u32(&mut self, n: u32) {
        self.mix(u64::from(n));
    }

    fn write_u64(&mut self, n: u64) {
        self.mix(n);
    }

    fn write_usize(&mut self, n: usize) {
        self.mix(n as u64);
    }
}

type FoldMap<K, V> = HashMap<K, V, BuildHasherDefault<FoldHasher>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Roundness {
    pub standard_facets: usize,
    pub coarse_facets: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RollingSurface {
    pub axis: usize,
    pub at: [i32; 2],
    pub from: i32,
    pub to: i32,
    pub radii: [i32; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Unread {
    Unoriented,
    Centre,
    Radius,
    Faceted,
    Partial,
    Facing,
    Width,
}

impl Unread {
    pub fn name(self) -> &'static str {
        match self {
            Unread::Unoriented => "unoriented",
            Unread::Centre => "centre",
            Unread::Radius => "radius",
            Unread::Faceted => "faceted",
            Unread::Partial => "partial",
            Unread::Facing => "facing",
            Unread::Width => "width",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Diagnostic {
    pub direction: Vec3,
    pub from: f64,
    pub to: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnreadBand {
    pub reason: Unread,
    pub axis: Option<usize>,
    pub at: Option<[i32; 2]>,
    pub from: Option<i32>,
    pub to: Option<i32>,
    pub diagnostic: Diagnostic,
}

impl UnreadBand {
    fn on_axis(reason: Unread, axis: usize, centre: Option<[f64; 2]>, lo: f64, hi: f64) -> Self {
        let line_known = reason != Unread::Centre;
        let at = match centre.map(|c| c.map(sixteenths::identified)) {
            Some([Some(a), Some(b)]) if line_known => Some([a, b]),
            _ => None,
        };
        let along = |t: f64| sixteenths::identified(t).filter(|_| line_known);
        UnreadBand {
            reason,
            axis: Some(axis),
            at,
            from: along(lo),
            to: along(hi),
            diagnostic: Diagnostic {
                direction: axis_direction(axis),
                from: lo,
                to: hi,
            },
        }
    }

    fn json(self) -> Value {
        let mut out = json!({
            "reason": self.reason.name(),
            "diagnostic": {
                "direction": self.diagnostic.direction,
                "from": self.diagnostic.from,
                "to": self.diagnostic.to,
            },
        });
        if let Some(axis) = self.axis {
            out["axis"] = json!(axis);
        }
        if let Some(at) = self.at {
            out["at"] = json!(at);
        }
        if let Some(from) = self.from {
            out["from"] = json!(from);
        }
        if let Some(to) = self.to {
            out["to"] = json!(to);
        }
        out
    }

    fn order(&self, other: &UnreadBand) -> std::cmp::Ordering {
        let floats = |u: &UnreadBand| {
            [
                u.diagnostic.direction[0],
                u.diagnostic.direction[1],
                u.diagnostic.direction[2],
                u.diagnostic.from,
                u.diagnostic.to,
            ]
        };
        (self.reason, self.axis, self.at, self.from, self.to)
            .cmp(&(other.reason, other.axis, other.at, other.from, other.to))
            .then_with(|| {
                floats(self)
                    .iter()
                    .zip(floats(other).iter())
                    .map(|(a, b)| a.total_cmp(b))
                    .find(|o| o.is_ne())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rolling {
    pub surfaces: Vec<RollingSurface>,
    pub unread: Vec<UnreadBand>,
}

impl Rolling {
    pub fn to_json(&self) -> Value {
        let surfaces: Vec<Value> = self
            .surfaces
            .iter()
            .map(|s| {
                json!({
                    "source": "measured",
                    "axis": s.axis,
                    "at": s.at,
                    "from": s.from,
                    "to": s.to,
                    "radii": s.radii,
                })
            })
            .collect();
        let unread: Vec<Value> = self.unread.iter().map(|band| band.json()).collect();
        json!({
            "stepsPerLdu": sixteenths::PER_LDU,
            "surfaces": surfaces,
            "unread": unread,
        })
    }
}

impl Roundness {
    pub fn measured<L: Library>(library: &L, stud_primitives: &[String]) -> Option<Roundness> {
        let standard = finest_closed_ring(library, Lod::Standard, stud_primitives)?;
        let coarse = finest_closed_ring(library, Lod::Low, stud_primitives)?;
        Some(Roundness {
            standard_facets: standard,
            coarse_facets: coarse.min(standard),
        })
    }
}

fn finest_closed_ring<L: Library>(
    library: &L,
    lod: Lod,
    stud_primitives: &[String],
) -> Option<usize> {
    let mut flattener = Flattener::new(library, lod, &[]);
    let mut facets: Option<usize> = None;
    for name in stud_primitives {
        let Some(path) = flattener.resolve(name) else {
            continue;
        };
        let Ok(flattened) = flattener.flatten(&path) else {
            continue;
        };
        let mesh = Mesh::new(&flattened.triangles);
        for axis in AXES {
            for span in mesh.spans(axis) {
                for group in span.groups {
                    let strip = Strip::new(&mesh, axis, span.key, group);
                    if let Some(ring) = strip.closed_circle() {
                        facets = Some(facets.map_or(ring.facets, |f| f.min(ring.facets)));
                    }
                }
            }
        }
    }
    facets
}

pub fn read_rolling(triangles: &[Triangle], roundness: Roundness) -> Rolling {
    let mesh = Mesh::new(triangles);
    let mut unread = Vec::new();
    let mut read = Vec::new();
    for axis in AXES {
        for span in mesh.spans(axis) {
            let (closed, pooled) = span.strips(&mesh, roundness);
            for strip in closed.iter().chain(pooled.iter()) {
                match strip.reading(roundness) {
                    StripReading::NotRound | StripReading::Inward => {}
                    StripReading::Unread(reason, centre) => unread.push(UnreadBand::on_axis(
                        reason, strip.axis, centre, strip.lo, strip.hi,
                    )),
                    StripReading::Read(band) => read.push(band),
                }
            }
        }
    }
    let mut surfaces = Vec::new();
    for band in merged(read) {
        match band.identified() {
            Some(surface) => surfaces.push(surface),
            None => unread.push(band.unread_width()),
        }
    }
    unread.extend(mesh.unoriented(roundness));
    surfaces.sort_unstable();
    surfaces.dedup();
    unread.sort_by(UnreadBand::order);
    unread.dedup();
    Rolling { surfaces, unread }
}

pub fn read_standard_rolling<L: Library>(
    library: &L,
    path: &str,
    roundness: Roundness,
    stud_primitives: &[String],
) -> Option<Rolling> {
    let mut flattener = Flattener::new(library, Lod::Standard, stud_primitives);
    let flattened = flattener.flatten(path).ok()?;
    let triangles: Vec<Triangle> = flattened
        .triangles
        .into_iter()
        .map(|triangle| Triangle {
            points: triangle.points.map(y_up),
            ..triangle
        })
        .collect();
    Some(read_rolling(&triangles, roundness))
}

fn y_up(p: Vec3) -> Vec3 {
    Affine::LDRAW_TO_Y_UP.apply(p).map(|v| v + 0.0)
}

type Key = [u64; 3];

fn key(p: Vec3) -> Key {
    p.map(|v| (v + 0.0).to_bits())
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn length(v: Vec3) -> f64 {
    dot(v, v).sqrt()
}

fn unit(v: Vec3) -> Option<Vec3> {
    let l = length(v);
    (l > 0.0).then(|| v.map(|c| c / l))
}

fn across(axis: usize) -> [usize; 2] {
    match axis {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    }
}

fn axis_direction(axis: usize) -> Vec3 {
    let mut direction = [0.0; 3];
    direction[axis] = 1.0;
    direction
}

fn centroid(points: &[Vec3; 3]) -> Vec3 {
    [0, 1, 2].map(|k| (points[0][k] + points[1][k] + points[2][k]) / 3.0)
}

struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(size: usize) -> Self {
        UnionFind {
            parent: (0..size).collect(),
        }
    }

    fn root(&mut self, mut i: usize) -> usize {
        while self.parent[i] != i {
            self.parent[i] = self.parent[self.parent[i]];
            i = self.parent[i];
        }
        i
    }

    fn join(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.root(a), self.root(b));
        if ra != rb {
            self.parent[ra.max(rb)] = ra.min(rb);
        }
    }
}

struct Mesh<'a> {
    triangles: &'a [Triangle],
    normals: Vec<Option<Vec3>>,
    corners: Vec<[u32; 3]>,
    neighbours: Vec<(usize, usize)>,
}

fn edge_key(a: u32, b: u32) -> u64 {
    (u64::from(a.min(b)) << 32) | u64::from(a.max(b))
}

fn two_ring_span(triangle: &Triangle, axis: usize) -> Option<(u64, u64)> {
    let along = triangle.points.map(|p| p[axis]);
    let lo = along.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = along.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let two_rings = along
        .iter()
        .all(|&v| v.to_bits() == lo.to_bits() || v.to_bits() == hi.to_bits());
    (lo < hi && two_rings).then(|| ((lo + 0.0).to_bits(), (hi + 0.0).to_bits()))
}

fn flat_across_an_axis(triangle: &Triangle) -> bool {
    let [a, b, c] = triangle.points;
    AXES.iter()
        .any(|&k| a[k].to_bits() == b[k].to_bits() && b[k].to_bits() == c[k].to_bits())
}

impl<'a> Mesh<'a> {
    fn new(triangles: &'a [Triangle]) -> Self {
        let mut ids: FoldMap<Key, u32> =
            FoldMap::with_capacity_and_hasher(triangles.len(), BuildHasherDefault::default());
        let corners: Vec<[u32; 3]> = triangles
            .iter()
            .map(|t| {
                t.points.map(|p| {
                    let next = u32::try_from(ids.len()).unwrap_or(u32::MAX);
                    *ids.entry(key(p)).or_insert(next)
                })
            })
            .collect();
        let normals: Vec<Option<Vec3>> = triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.points;
                unit(cross(sub(b, a), sub(c, a)))
            })
            .collect();
        let mut edges: Vec<(u64, usize)> = Vec::with_capacity(triangles.len() * 3);
        for (t, c) in corners.iter().enumerate() {
            if normals[t].is_none() {
                continue;
            }
            for k in 0..3 {
                let (a, b) = (c[k], c[(k + 1) % 3]);
                if a != b {
                    edges.push((edge_key(a, b), t));
                }
            }
        }
        edges.sort_unstable();
        let neighbours = edges
            .windows(2)
            .filter(|w| w[0].0 == w[1].0 && w[0].1 != w[1].1)
            .map(|w| (w[0].1, w[1].1))
            .collect();
        Mesh {
            triangles,
            normals,
            corners,
            neighbours,
        }
    }

    fn components(
        &self,
        member: &[bool],
        linked: impl Fn(usize, usize) -> bool,
    ) -> Vec<Vec<usize>> {
        let mut sets = UnionFind::new(self.triangles.len());
        for &(a, b) in &self.neighbours {
            if member[a] && member[b] && linked(a, b) {
                sets.join(a, b);
            }
        }
        let mut slot: FoldMap<usize, usize> = FoldMap::default();
        let mut groups: Vec<Vec<usize>> = Vec::new();
        for t in (0..self.triangles.len()).filter(|&t| member[t]) {
            let root = sets.root(t);
            let index = *slot.entry(root).or_insert(groups.len());
            if index == groups.len() {
                groups.push(Vec::new());
            }
            groups[index].push(t);
        }
        groups
    }

    fn same_side(&self, a: usize, b: usize) -> bool {
        match (self.normals[a], self.normals[b]) {
            (Some(na), Some(nb)) => dot(na, nb) > 0.0,
            _ => false,
        }
    }

    fn spans(&self, axis: usize) -> Vec<Span> {
        let span: Vec<Option<(u64, u64)>> = self
            .triangles
            .iter()
            .enumerate()
            .map(|(t, triangle)| {
                self.normals[t]?;
                two_ring_span(triangle, axis)
            })
            .collect();
        let member: Vec<bool> = span.iter().map(Option::is_some).collect();
        let mut by_span: BTreeMap<(u64, u64), Vec<Vec<usize>>> = BTreeMap::new();
        for triangles in self.components(&member, |a, b| span[a] == span[b] && self.same_side(a, b))
        {
            if let Some(key) = span[triangles[0]] {
                by_span.entry(key).or_default().push(triangles);
            }
        }
        by_span
            .into_iter()
            .map(|(key, groups)| Span { axis, key, groups })
            .collect()
    }

    fn rings(&self, axis: usize, lo: f64, triangles: &[usize]) -> [Ring; 2] {
        let plane = across(axis);
        let mut rings = [0, 1].map(|_| Ring {
            points: Vec::new(),
            degree: Vec::new(),
            chords: Vec::new(),
        });
        let mut index: [FoldMap<u32, usize>; 2] = [FoldMap::default(), FoldMap::default()];
        for &t in triangles {
            let points = self.triangles[t].points;
            let corners = self.corners[t];
            let mut slots = [(0, 0); 3];
            for k in 0..3 {
                let p = points[k];
                let side = usize::from(p[axis].to_bits() != lo.to_bits());
                let next = rings[side].points.len();
                let slot = *index[side].entry(corners[k]).or_insert(next);
                if slot == next {
                    rings[side].points.push([p[plane[0]], p[plane[1]]]);
                    rings[side].degree.push(0);
                }
                slots[k] = (side, slot);
            }
            for k in 0..3 {
                let (sa, a) = slots[k];
                let (sb, b) = slots[(k + 1) % 3];
                if sa == sb && a != b {
                    rings[sa].chords.push((a.min(b), a.max(b)));
                }
            }
        }
        for ring in &mut rings {
            ring.chords.sort_unstable();
            ring.chords.dedup();
            for &(a, b) in &ring.chords {
                ring.degree[a] += 1;
                ring.degree[b] += 1;
            }
        }
        rings
    }

    fn unoriented(&self, roundness: Roundness) -> Vec<UnreadBand> {
        let smooth = (std::f64::consts::TAU / roundness.coarse_facets as f64).cos();
        let member: Vec<bool> = self
            .triangles
            .iter()
            .enumerate()
            .map(|(t, triangle)| self.normals[t].is_some() && !flat_across_an_axis(triangle))
            .collect();
        let normal = |t: usize| self.normals[t].unwrap_or([0.0; 3]);
        self.components(&member, |a, b| dot(normal(a), normal(b)) > smooth)
            .into_iter()
            .filter(|component| component.len() > 3)
            .filter_map(|component| self.unoriented_band(&component, &normal))
            .collect()
    }

    fn unoriented_band(
        &self,
        component: &[usize],
        normal: &impl Fn(usize) -> Vec3,
    ) -> Option<UnreadBand> {
        let direction = revolution_axis(component.iter().map(|&t| normal(t)).collect())?;
        if axis_aligned(direction) {
            return None;
        }
        let basis = plane_basis(direction);
        let projected = |p: Vec3| [dot(p, basis[0]), dot(p, basis[1])];
        let mut rings: Vec<(f64, [f64; 2])> = component
            .iter()
            .flat_map(|&t| self.triangles[t].points)
            .map(|p| (dot(p, direction), projected(p)))
            .collect();
        rings.sort_by(|a, b| a.0.total_cmp(&b.0));
        rings.dedup_by(|a, b| a.0.to_bits() == b.0.to_bits() && a.1 == b.1);
        let centre = coaxial_centre(&rings)?;
        let facing: Vec<f64> = component
            .iter()
            .filter_map(|&t| {
                let n = normal(t);
                let m = projected(centroid(&self.triangles[t].points));
                let radial = projected(n);
                let offset = (m[0] - centre[0]) * radial[0] + (m[1] - centre[1]) * radial[1];
                (offset != 0.0).then_some(offset)
            })
            .collect();
        let inward = facing.iter().all(|&o| o < 0.0)
            && component.iter().all(|&t| !self.triangles[t].double_sided);
        if inward {
            return None;
        }
        let along = component
            .iter()
            .flat_map(|&t| self.triangles[t].points)
            .map(|p| dot(p, direction));
        let (from, to) = along.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
            (lo.min(v), hi.max(v))
        });
        Some(UnreadBand {
            reason: Unread::Unoriented,
            axis: None,
            at: None,
            from: None,
            to: None,
            diagnostic: Diagnostic {
                direction,
                from,
                to,
            },
        })
    }
}

fn axis_aligned(direction: Vec3) -> bool {
    direction.iter().all(|c| {
        let magnitude = c.abs();
        magnitude <= IDENTIFY_LDU || (magnitude - 1.0).abs() <= IDENTIFY_LDU
    })
}

fn revolution_axis(normals: Vec<Vec3>) -> Option<Vec3> {
    let first = *normals.first()?;
    let distinct = |a: Vec3, b: Vec3| sub(a, b).iter().any(|c| c.abs() > IDENTIFY_LDU);
    let mut seen: Vec<Vec3> = Vec::new();
    for &n in &normals {
        if seen.iter().all(|&s| distinct(s, n)) {
            seen.push(n);
            if seen.len() > 3 {
                break;
            }
        }
    }
    if seen.len() <= 3 {
        return None;
    }
    let far = normals
        .iter()
        .copied()
        .min_by(|a, b| dot(*a, first).total_cmp(&dot(*b, first)))?;
    let spread = sub(far, first);
    let third = normals.iter().copied().max_by(|a, b| {
        length(cross(spread, sub(*a, first))).total_cmp(&length(cross(spread, sub(*b, first))))
    })?;
    let axis = unit(cross(spread, sub(third, first)))?;
    let level = dot(first, axis);
    if normals
        .iter()
        .any(|&n| (dot(n, axis) - level).abs() > IDENTIFY_LDU)
    {
        return None;
    }
    let leading = axis
        .iter()
        .copied()
        .find(|c| c.abs() > IDENTIFY_LDU)
        .unwrap_or(1.0);
    Some(if leading < 0.0 {
        axis.map(|c| -c + 0.0)
    } else {
        axis
    })
}

fn plane_basis(direction: Vec3) -> [Vec3; 2] {
    let seed = AXES
        .iter()
        .copied()
        .min_by(|&a, &b| direction[a].abs().total_cmp(&direction[b].abs()))
        .map(axis_direction)
        .unwrap_or([1.0, 0.0, 0.0]);
    let u = unit(cross(direction, seed)).unwrap_or([1.0, 0.0, 0.0]);
    [u, cross(direction, u)]
}

fn coaxial_centre(points: &[(f64, [f64; 2])]) -> Option<[f64; 2]> {
    let mut centre: Option<[f64; 2]> = None;
    let mut start = 0;
    while start < points.len() {
        let mut end = start + 1;
        while end < points.len() && points[end].0 - points[end - 1].0 <= HALF_STEP_LDU {
            end += 1;
        }
        let ring: Vec<[f64; 2]> = points[start..end].iter().map(|(_, p)| *p).collect();
        start = end;
        if ring.len() < 3 {
            continue;
        }
        let fitted = fitted_circle(&ring)?;
        let radius = planar_distance(ring[0], fitted);
        let round = ring
            .iter()
            .all(|p| (planar_distance(*p, fitted) - radius).abs() <= HALF_STEP_LDU);
        let agrees = centre.is_none_or(|c| planar_distance(c, fitted) <= HALF_STEP_LDU);
        if !round || !agrees {
            return None;
        }
        centre.get_or_insert(fitted);
    }
    centre
}

fn fitted_circle(points: &[[f64; 2]]) -> Option<[f64; 2]> {
    let n = points.len() as f64;
    let mean = points
        .iter()
        .fold([0.0; 2], |m, p| [m[0] + p[0] / n, m[1] + p[1] / n]);
    let mut suu = 0.0;
    let mut suv = 0.0;
    let mut svv = 0.0;
    let mut suuu_uvv = 0.0;
    let mut svvv_vuu = 0.0;
    for p in points {
        let (u, v) = (p[0] - mean[0], p[1] - mean[1]);
        suu += u * u;
        suv += u * v;
        svv += v * v;
        suuu_uvv += u * u * u + u * v * v;
        svvv_vuu += v * v * v + v * u * u;
    }
    let det = suu * svv - suv * suv;
    if det == 0.0 {
        return None;
    }
    let uc = (suuu_uvv * svv - svvv_vuu * suv) / (2.0 * det);
    let vc = (svvv_vuu * suu - suuu_uvv * suv) / (2.0 * det);
    Some([mean[0] + uc, mean[1] + vc])
}

struct Ring {
    points: Vec<[f64; 2]>,
    degree: Vec<usize>,
    chords: Vec<(usize, usize)>,
}

impl Ring {
    fn is_apex(&self) -> bool {
        self.points.len() == 1
    }

    fn is_closed(&self) -> bool {
        self.points.len() >= 3 && self.degree.iter().all(|&d| d == 2) && self.is_one_chain()
    }

    fn is_one_chain(&self) -> bool {
        let mut sets = UnionFind::new(self.points.len());
        for &(a, b) in &self.chords {
            sets.join(a, b);
        }
        let root = sets.root(0);
        (0..self.points.len()).all(|i| sets.root(i) == root)
    }

    fn extents_circle(&self) -> ([f64; 2], f64) {
        let mut min = [f64::INFINITY; 2];
        let mut max = [f64::NEG_INFINITY; 2];
        for p in &self.points {
            for k in 0..2 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        let centre = [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0];
        let radius = ((max[0] - min[0]) / 2.0).max((max[1] - min[1]) / 2.0);
        (centre, radius)
    }

    fn on_circle(&self, centre: [f64; 2], radius: f64) -> bool {
        self.points
            .iter()
            .all(|p| (planar_distance(*p, centre) - radius).abs() <= HALF_STEP_LDU)
    }

    fn circumradius(&self, centre: [f64; 2]) -> f64 {
        self.points
            .iter()
            .map(|p| planar_distance(*p, centre))
            .fold(0.0, f64::max)
    }
}

fn planar_distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

struct ClosedCircle {
    centre: [f64; 2],
    radii: [f64; 2],
    facets: usize,
    extents_meet_circle: bool,
}

enum StripReading {
    NotRound,
    Inward,
    Unread(Unread, Option<[f64; 2]>),
    Read(ReadBand),
}

struct Span {
    axis: usize,
    key: (u64, u64),
    groups: Vec<Vec<usize>>,
}

impl Span {
    fn strips<'a>(
        self,
        mesh: &'a Mesh<'a>,
        roundness: Roundness,
    ) -> (Vec<Strip<'a>>, Option<Strip<'a>>) {
        let mut closed = Vec::new();
        let mut fragments: Vec<usize> = Vec::new();
        for group in self.groups {
            if group.len() < roundness.coarse_facets {
                fragments.extend(group);
                continue;
            }
            let strip = Strip::new(mesh, self.axis, self.key, group);
            if strip.is_closed() {
                closed.push(strip);
            } else {
                fragments.extend(strip.triangles);
            }
        }
        fragments.sort_unstable();
        let pooled = (2 * fragments.len() >= roundness.coarse_facets)
            .then(|| Strip::new(mesh, self.axis, self.key, fragments));
        (closed, pooled)
    }
}

struct Strip<'a> {
    mesh: &'a Mesh<'a>,
    axis: usize,
    lo: f64,
    hi: f64,
    triangles: Vec<usize>,
    rings: [Ring; 2],
}

impl<'a> Strip<'a> {
    fn new(mesh: &'a Mesh<'a>, axis: usize, span: (u64, u64), triangles: Vec<usize>) -> Self {
        let lo = f64::from_bits(span.0);
        let rings = mesh.rings(axis, lo, &triangles);
        Strip {
            mesh,
            axis,
            lo,
            hi: f64::from_bits(span.1),
            triangles,
            rings,
        }
    }

    fn closed_circle(&self) -> Option<ClosedCircle> {
        let rings = &self.rings;
        if rings.iter().any(|r| !r.is_closed() && !r.is_apex()) || rings.iter().all(Ring::is_apex) {
            return None;
        }
        let shaped = rings.iter().find(|r| r.is_closed())?;
        let (centre, _) = shaped.extents_circle();
        let mut radii = [0.0; 2];
        let mut extents_meet_circle = true;
        for (side, ring) in rings.iter().enumerate() {
            if ring.is_apex() {
                if planar_distance(ring.points[0], centre) > HALF_STEP_LDU {
                    return None;
                }
                continue;
            }
            let (own_centre, extents_radius) = ring.extents_circle();
            let radius = ring.circumradius(centre);
            if planar_distance(own_centre, centre) > HALF_STEP_LDU
                || !ring.on_circle(centre, radius)
            {
                return None;
            }
            extents_meet_circle &= (extents_radius - radius).abs() <= HALF_STEP_LDU;
            radii[side] = extents_radius;
        }
        let facets = rings.iter().map(|r| r.points.len()).max().unwrap_or(0);
        Some(ClosedCircle {
            centre,
            radii,
            facets,
            extents_meet_circle,
        })
    }

    fn is_closed(&self) -> bool {
        let rings = &self.rings;
        rings.iter().all(|r| r.is_closed() || r.is_apex()) && !rings.iter().all(Ring::is_apex)
    }

    fn goes_around(&self, roundness: Roundness) -> Option<[f64; 2]> {
        let rings = &self.rings;
        let ring = rings.iter().max_by_key(|r| r.points.len())?;
        if ring.points.len() < roundness.coarse_facets {
            return None;
        }
        let (centre, _) = ring.extents_circle();
        let on_one_circle = rings
            .iter()
            .filter(|r| !r.points.is_empty())
            .all(|r| r.on_circle(centre, r.circumradius(centre)));
        if !on_one_circle {
            return None;
        }
        let mut angles: Vec<f64> = ring
            .points
            .iter()
            .map(|p| (p[1] - centre[1]).atan2(p[0] - centre[0]))
            .collect();
        angles.sort_by(f64::total_cmp);
        let wrap = angles.first()? + std::f64::consts::TAU - angles.last()?;
        let widest = angles.windows(2).map(|w| w[1] - w[0]).fold(wrap, f64::max);
        (widest <= std::f64::consts::TAU / roundness.coarse_facets as f64).then_some(centre)
    }

    fn facing(&self, centre: [f64; 2]) -> Option<bool> {
        let plane = across(self.axis);
        let mut outward = 0;
        let mut inward = 0;
        for &t in &self.triangles {
            let triangle = &self.mesh.triangles[t];
            if triangle.double_sided {
                return None;
            }
            let normal = self.mesh.normals[t]?;
            let m = centroid(&triangle.points);
            let radial = normal[plane[0]] * (m[plane[0]] - centre[0])
                + normal[plane[1]] * (m[plane[1]] - centre[1]);
            if radial > 0.0 {
                outward += 1;
            } else if radial < 0.0 {
                inward += 1;
            }
        }
        match (outward, inward) {
            (o, 0) if o > 0 => Some(true),
            (0, i) if i > 0 => Some(false),
            _ => None,
        }
    }

    fn reading(&self, roundness: Roundness) -> StripReading {
        if let Some(circle) = self.closed_circle() {
            if circle.facets < roundness.coarse_facets {
                return StripReading::NotRound;
            }
            let centre = Some(circle.centre);
            return match self.facing(circle.centre) {
                None => StripReading::Unread(Unread::Facing, centre),
                Some(false) => StripReading::Inward,
                Some(true) if circle.facets < roundness.standard_facets => {
                    StripReading::Unread(Unread::Faceted, centre)
                }
                Some(true) => self.identified(&circle),
            };
        }
        let Some(centre) = self.goes_around(roundness) else {
            return StripReading::NotRound;
        };
        match self.facing(centre) {
            None => StripReading::Unread(Unread::Facing, Some(centre)),
            Some(false) => StripReading::Inward,
            Some(true) => StripReading::Unread(Unread::Partial, Some(centre)),
        }
    }

    fn identified(&self, circle: &ClosedCircle) -> StripReading {
        let centre = Some(circle.centre);
        let at = circle.centre.map(sixteenths::identified);
        let radii = circle.radii.map(sixteenths::identified);
        match (at, radii) {
            ([None, _] | [_, None], _) => StripReading::Unread(Unread::Centre, centre),
            ([Some(a), Some(b)], [Some(r0), Some(r1)]) if circle.extents_meet_circle => {
                StripReading::Read(ReadBand {
                    axis: self.axis,
                    at: [a, b],
                    lo: self.lo,
                    hi: self.hi,
                    radii: [r0, r1],
                })
            }
            _ => StripReading::Unread(Unread::Radius, centre),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ReadBand {
    axis: usize,
    at: [i32; 2],
    lo: f64,
    hi: f64,
    radii: [i32; 2],
}

impl ReadBand {
    fn continues_into(&self, next: &ReadBand) -> bool {
        if self.axis != next.axis
            || self.at != next.at
            || self.hi.to_bits() != next.lo.to_bits()
            || self.radii[1] != next.radii[0]
        {
            return false;
        }
        let both_cylinders = self.radii[0] == self.radii[1] && next.radii[0] == next.radii[1];
        if both_cylinders {
            return true;
        }
        match [self.lo, self.hi, next.hi].map(sixteenths::identified) {
            [Some(t0), Some(t1), Some(t2)] => {
                let [r0, r1, r2] = [self.radii[0], self.radii[1], next.radii[1]].map(i64::from);
                let [t0, t1, t2] = [t0, t1, t2].map(i64::from);
                (r1 - r0) * (t2 - t1) == (r2 - r1) * (t1 - t0)
            }
            _ => false,
        }
    }

    fn identified(&self) -> Option<RollingSurface> {
        let from = sixteenths::identified(self.lo)?;
        let to = sixteenths::identified(self.hi)?;
        (from < to).then_some(RollingSurface {
            axis: self.axis,
            at: self.at,
            from,
            to,
            radii: self.radii,
        })
    }

    fn unread_width(&self) -> UnreadBand {
        let mut band = UnreadBand::on_axis(Unread::Width, self.axis, None, self.lo, self.hi);
        band.at = Some(self.at);
        band
    }
}

fn merged(mut bands: Vec<ReadBand>) -> Vec<ReadBand> {
    bands.sort_by(|a, b| {
        (a.axis, a.at)
            .cmp(&(b.axis, b.at))
            .then(a.lo.total_cmp(&b.lo))
            .then(a.radii.cmp(&b.radii))
            .then(a.hi.total_cmp(&b.hi))
    });
    bands.dedup();
    let mut out: Vec<ReadBand> = Vec::new();
    for band in bands {
        match out.iter_mut().rev().find(|open| open.continues_into(&band)) {
            Some(open) => {
                open.hi = band.hi;
                open.radii[1] = band.radii[1];
            }
            None => out.push(band),
        }
    }
    out
}
