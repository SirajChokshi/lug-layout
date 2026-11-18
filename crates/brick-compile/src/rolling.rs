use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};

use crate::affine::Vec3;
use crate::flatten::Triangle;
use crate::sixteenths;

const AXIS_RESIDUAL: f64 = 0.0005;
const AXES: [usize; 3] = [0, 1, 2];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Roundness {
    pub standard_facets: usize,
    pub coarse_facets: usize,
    pub coarse_turn_cosine: f64,
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
pub enum SurfaceReason {
    Faceted,
    Partial,
    Facing,
    Irregular,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Ends {
    pub from: Option<i32>,
    pub to: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UnreadBand {
    Unoriented,
    Centre {
        axis: usize,
    },
    Radius {
        axis: usize,
        at: [i32; 2],
        ends: Ends,
    },
    Width {
        axis: usize,
        at: [i32; 2],
        ends: Ends,
    },
    Surface {
        reason: SurfaceReason,
        axis: usize,
        at: Option<[i32; 2]>,
        ends: Ends,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PartRolling {
    pub surfaces: Vec<RollingSurface>,
    pub unread: Vec<UnreadBand>,
}

impl SurfaceReason {
    fn name(self) -> &'static str {
        match self {
            SurfaceReason::Faceted => "faceted",
            SurfaceReason::Partial => "partial",
            SurfaceReason::Facing => "facing",
            SurfaceReason::Irregular => "irregular",
        }
    }
}

impl Ends {
    fn of(lo: f64, hi: f64) -> Ends {
        Ends {
            from: sixteenths::identified(lo),
            to: sixteenths::identified(hi),
        }
    }

    fn write(self, out: &mut Value) {
        if let Some(from) = self.from {
            out["from"] = json!(from);
        }
        if let Some(to) = self.to {
            out["to"] = json!(to);
        }
    }
}

impl UnreadBand {
    fn json(self) -> Value {
        match self {
            UnreadBand::Unoriented => json!({ "reason": "unoriented" }),
            UnreadBand::Centre { axis } => json!({ "reason": "centre", "axis": axis }),
            UnreadBand::Radius { axis, at, ends } | UnreadBand::Width { axis, at, ends } => {
                let reason = if matches!(self, UnreadBand::Radius { .. }) {
                    "radius"
                } else {
                    "width"
                };
                let mut out = json!({ "reason": reason, "axis": axis, "at": at });
                ends.write(&mut out);
                out
            }
            UnreadBand::Surface {
                reason,
                axis,
                at,
                ends,
            } => {
                let mut out = json!({ "reason": reason.name(), "axis": axis });
                if let Some(at) = at {
                    out["at"] = json!(at);
                }
                ends.write(&mut out);
                out
            }
        }
    }
}

impl PartRolling {
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
    pub fn of_studs(standard: &[Vec<Triangle>], coarse: &[Vec<Triangle>]) -> Option<Roundness> {
        let standard_facets = coarsest_closed_ring(standard)?.facets;
        let coarse_ring = coarsest_closed_ring(coarse)?;
        Some(Roundness {
            standard_facets,
            coarse_facets: coarse_ring.facets.min(standard_facets),
            coarse_turn_cosine: coarse_ring.turn_cosine,
        })
    }
}

struct StudRing {
    facets: usize,
    turn_cosine: f64,
}

fn coarsest_closed_ring(studs: &[Vec<Triangle>]) -> Option<StudRing> {
    let mut coarsest: Option<StudRing> = None;
    for triangles in studs {
        let mesh = Mesh::new(triangles);
        for axis in AXES {
            for span in mesh.spans(axis) {
                for group in span.groups {
                    let strip = Strip::new(&mesh, axis, span.key, group);
                    let Some(circles) = strip.closed_circles() else {
                        continue;
                    };
                    let facets = strip.facets();
                    let turn_cosine = circles.turn_cosine(&strip.rings);
                    if coarsest.as_ref().is_none_or(|c| facets < c.facets) {
                        coarsest = Some(StudRing {
                            facets,
                            turn_cosine,
                        });
                    }
                }
            }
        }
    }
    coarsest
}

pub fn read_rolling(triangles: &[Triangle], roundness: Roundness) -> PartRolling {
    let mesh = Mesh::new(triangles);
    let mut unread = Vec::new();
    let mut read = Vec::new();
    let mut explained = vec![false; triangles.len()];
    for axis in AXES {
        for span in mesh.spans(axis) {
            let (closed, pooled) = span.strips(&mesh, roundness);
            for strip in closed.iter().chain(pooled.iter()) {
                let reading = strip.reading(roundness);
                if !matches!(reading, StripReading::NotRound) {
                    for &t in &strip.triangles {
                        explained[t] = true;
                    }
                }
                match reading {
                    StripReading::NotRound | StripReading::Inward => {}
                    StripReading::Unread(band) => unread.push(band),
                    StripReading::Read(band) => read.push(band),
                }
            }
        }
    }
    let mut surfaces = Vec::new();
    for band in merged(read) {
        match band.identified() {
            Some(surface) => surfaces.push(surface),
            None => unread.push(UnreadBand::Width {
                axis: band.axis,
                at: band.at,
                ends: Ends::of(band.lo, band.hi),
            }),
        }
    }
    unread.extend(mesh.smooth_surfaces(roundness, &explained));
    surfaces.sort_unstable();
    surfaces.dedup();
    unread.sort_unstable();
    unread.dedup();
    PartRolling { surfaces, unread }
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

fn planar_distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

fn offset(p: [f64; 2], centre: [f64; 2]) -> [f64; 2] {
    [p[0] - centre[0], p[1] - centre[1]]
}

fn upper_half(v: [f64; 2]) -> bool {
    v[1] > 0.0 || (v[1] == 0.0 && v[0] > 0.0)
}

fn by_angle(a: [f64; 2], b: [f64; 2]) -> Ordering {
    upper_half(b)
        .cmp(&upper_half(a))
        .then_with(|| (a[1] * b[0]).total_cmp(&(a[0] * b[1])))
}

fn turn_cosine(a: [f64; 2], b: [f64; 2]) -> f64 {
    let lengths = (a[0] * a[0] + a[1] * a[1]).sqrt() * (b[0] * b[0] + b[1] * b[1]).sqrt();
    (a[0] * b[0] + a[1] * b[1]) / lengths
}

fn fitted_centre(points: &[[f64; 2]]) -> Option<[f64; 2]> {
    let n = points.len() as f64;
    let mean = points
        .iter()
        .fold([0.0; 2], |m, p| [m[0] + p[0] / n, m[1] + p[1] / n]);
    let (mut suu, mut suv, mut svv, mut su, mut sv) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for p in points {
        let (u, v) = (p[0] - mean[0], p[1] - mean[1]);
        suu += u * u;
        suv += u * v;
        svv += v * v;
        su += u * u * u + u * v * v;
        sv += v * v * v + v * u * u;
    }
    let det = suu * svv - suv * suv;
    (det != 0.0).then(|| {
        [
            mean[0] + (su * svv - sv * suv) / (2.0 * det),
            mean[1] + (sv * suu - su * suv) / (2.0 * det),
        ]
    })
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Facing {
    Outward,
    Inward,
    Unknown,
}

struct Mesh<'a> {
    triangles: &'a [Triangle],
    normals: Vec<Option<Vec3>>,
    corners: Vec<[u32; 3]>,
    neighbours: Vec<(usize, usize)>,
}

impl<'a> Mesh<'a> {
    fn new(triangles: &'a [Triangle]) -> Self {
        let mut ids: HashMap<Key, u32> = HashMap::with_capacity(triangles.len());
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
        let mut slot: HashMap<usize, usize> = HashMap::new();
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
        let mut index: [HashMap<u32, usize>; 2] = [HashMap::new(), HashMap::new()];
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

    fn facing(&self, triangles: &[usize], radial: impl Fn(Vec3, Vec3) -> f64) -> Facing {
        let mut outward = false;
        let mut inward = false;
        for &t in triangles {
            let triangle = &self.triangles[t];
            let Some(normal) = self.normals[t] else {
                continue;
            };
            if triangle.double_sided {
                return Facing::Unknown;
            }
            let along = radial(normal, centroid(&triangle.points));
            outward |= along > 0.0;
            inward |= along < 0.0;
        }
        match (outward, inward) {
            (true, false) => Facing::Outward,
            (false, true) => Facing::Inward,
            _ => Facing::Unknown,
        }
    }

    fn smooth_surfaces(&self, roundness: Roundness, explained: &[bool]) -> Vec<UnreadBand> {
        let member: Vec<bool> = self
            .triangles
            .iter()
            .enumerate()
            .map(|(t, triangle)| self.normals[t].is_some() && !flat_across_an_axis(triangle))
            .collect();
        let normal = |t: usize| self.normals[t].unwrap_or([0.0; 3]);
        self.components(&member, |a, b| {
            dot(normal(a), normal(b)) >= roundness.coarse_turn_cosine
        })
        .into_iter()
        .filter(|component| component.len() >= roundness.coarse_facets)
        .filter_map(|component| self.smooth_surface(&component, explained))
        .collect()
    }

    fn smooth_surface(&self, component: &[usize], explained: &[bool]) -> Option<UnreadBand> {
        let normals: Vec<Vec3> = component.iter().filter_map(|&t| self.normals[t]).collect();
        let direction = revolution_axis(&normals)?;
        let aligned = aligned_axis(direction);
        if aligned.is_some() && component.iter().any(|&t| explained[t]) {
            return None;
        }
        let basis = plane_basis(direction);
        let projected = |p: Vec3| [dot(p, basis[0]), dot(p, basis[1])];
        let corners: Vec<Vec3> = component
            .iter()
            .flat_map(|&t| self.triangles[t].points)
            .collect();
        let count = corners.len() as f64;
        let middle = corners.iter().fold([0.0; 3], |m, p| {
            [
                m[0] + p[0] / count,
                m[1] + p[1] / count,
                m[2] + p[2] / count,
            ]
        });
        let size = corners
            .iter()
            .map(|p| length(sub(*p, middle)))
            .fold(0.0, f64::max);
        let mut points: Vec<(f64, [f64; 2])> = corners
            .iter()
            .map(|&p| (dot(sub(p, middle), direction), projected(p)))
            .collect();
        points.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then(a.1[0].total_cmp(&b.1[0]))
                .then(a.1[1].total_cmp(&b.1[1]))
        });
        points.dedup();
        let centre =
            coaxial_centre(&points, AXIS_RESIDUAL * size).or_else(|| one_circle(&points))?;
        let facing = self.facing(component, |normal, at| {
            let r = offset(projected(at), centre);
            let n = projected(normal);
            n[0] * r[0] + n[1] * r[1]
        });
        if facing == Facing::Inward {
            return None;
        }
        let Some(axis) = aligned else {
            return Some(UnreadBand::Unoriented);
        };
        let along_middle = dot(middle, direction);
        let lo = points.first().map_or(0.0, |p| p.0) + along_middle;
        let hi = points.last().map_or(0.0, |p| p.0) + along_middle;
        let line = across(axis).map(|k| {
            let p = basis[0].map(|c| c * centre[0]);
            let q = basis[1].map(|c| c * centre[1]);
            p[k] + q[k]
        });
        let at = match line.map(sixteenths::identified) {
            [Some(a), Some(b)] => Some([a, b]),
            _ => None,
        };
        let sign = direction[axis].signum();
        let (from, to) = if sign < 0.0 { (-hi, -lo) } else { (lo, hi) };
        Some(UnreadBand::Surface {
            reason: SurfaceReason::Irregular,
            axis,
            at,
            ends: Ends::of(from, to),
        })
    }
}

fn aligned_axis(direction: Vec3) -> Option<usize> {
    let mut found = None;
    for (k, &c) in direction.iter().enumerate() {
        let magnitude = c.abs();
        if (magnitude - 1.0).abs() <= AXIS_RESIDUAL {
            found = Some(k);
        } else if magnitude > AXIS_RESIDUAL {
            return None;
        }
    }
    found
}

fn revolution_axis(normals: &[Vec3]) -> Option<Vec3> {
    let first = *normals.first()?;
    let distinct = |a: Vec3, b: Vec3| sub(a, b).iter().any(|c| c.abs() > AXIS_RESIDUAL);
    let mut seen: Vec<Vec3> = Vec::new();
    for &n in normals {
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
        .any(|&n| (dot(n, axis) - level).abs() > AXIS_RESIDUAL)
    {
        return None;
    }
    let leading = axis
        .iter()
        .copied()
        .find(|c| c.abs() > AXIS_RESIDUAL)
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

fn coaxial_centre(points: &[(f64, [f64; 2])], ring_spread: f64) -> Option<[f64; 2]> {
    let mut centre: Option<[f64; 2]> = None;
    let mut start = 0;
    while start < points.len() {
        let mut end = start + 1;
        while end < points.len() && points[end].0 - points[end - 1].0 <= ring_spread {
            end += 1;
        }
        let ring: Vec<[f64; 2]> = points[start..end].iter().map(|(_, p)| *p).collect();
        start = end;
        if ring.len() < 3 {
            continue;
        }
        let fitted = fitted_centre(&ring)?;
        let mut around = ring.clone();
        around.sort_by(|a, b| by_angle(offset(*a, fitted), offset(*b, fitted)));
        let chords: Vec<(usize, usize)> = (0..around.len())
            .map(|i| (i, (i + 1) % around.len()))
            .collect();
        let circle = Circle::fitted(&around, &chords, fitted)?;
        if centre.is_some_and(|c| planar_distance(c, fitted) >= circle.bend) {
            return None;
        }
        centre.get_or_insert(fitted);
    }
    centre
}

fn one_circle(points: &[(f64, [f64; 2])]) -> Option<[f64; 2]> {
    let mut across: Vec<[f64; 2]> = points.iter().map(|(_, p)| *p).collect();
    across.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    across.dedup();
    let fitted = fitted_centre(&across)?;
    across.sort_by(|a, b| by_angle(offset(*a, fitted), offset(*b, fitted)));
    let chords: Vec<(usize, usize)> = (0..across.len())
        .map(|i| (i, (i + 1) % across.len()))
        .collect();
    Circle::fitted(&across, &chords, fitted).map(|circle| circle.centre)
}

struct Circle {
    centre: [f64; 2],
    radius: f64,
    bend: f64,
}

impl Circle {
    fn about(
        points: &[[f64; 2]],
        chords: &[(usize, usize)],
        centre: [f64; 2],
        radius: f64,
    ) -> Option<Circle> {
        let bend = chords
            .iter()
            .map(|&(a, b)| {
                let middle = [
                    (points[a][0] + points[b][0]) / 2.0,
                    (points[a][1] + points[b][1]) / 2.0,
                ];
                radius - planar_distance(middle, centre)
            })
            .fold(f64::INFINITY, f64::min);
        let on_circle = bend > 0.0
            && bend.is_finite()
            && points
                .iter()
                .all(|p| (planar_distance(*p, centre) - radius).abs() < bend);
        on_circle.then_some(Circle {
            centre,
            radius,
            bend,
        })
    }

    fn fitted(points: &[[f64; 2]], chords: &[(usize, usize)], centre: [f64; 2]) -> Option<Circle> {
        let radius = points
            .iter()
            .map(|p| planar_distance(*p, centre))
            .sum::<f64>()
            / points.len() as f64;
        Circle::about(points, chords, centre, radius)
    }
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

    fn extents(&self) -> ([f64; 2], f64) {
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

    fn circumradius(&self, centre: [f64; 2]) -> f64 {
        self.points
            .iter()
            .map(|p| planar_distance(*p, centre))
            .fold(0.0, f64::max)
    }

    fn circle(&self) -> Option<(Circle, bool)> {
        let (centre, extents_radius) = self.extents();
        let circumradius = self.circumradius(centre);
        let by_extents = Circle::about(&self.points, &self.chords, centre, circumradius)
            .filter(|c| (extents_radius - c.radius).abs() < c.bend);
        if let Some(circle) = by_extents {
            return Some((
                Circle {
                    radius: extents_radius,
                    ..circle
                },
                true,
            ));
        }
        let fitted = fitted_centre(&self.points)?;
        Circle::fitted(&self.points, &self.chords, fitted).map(|c| (c, false))
    }

    fn around(&self, centre: [f64; 2]) -> Vec<[f64; 2]> {
        let mut around: Vec<[f64; 2]> = self.points.iter().map(|p| offset(*p, centre)).collect();
        around.sort_by(|a, b| by_angle(*a, *b));
        around
    }
}

struct ClosedCircles {
    centre: [f64; 2],
    radii: [f64; 2],
    shaped: usize,
}

impl ClosedCircles {
    fn turn_cosine(&self, rings: &[Ring; 2]) -> f64 {
        let ring = &rings[self.shaped];
        ring.chords
            .iter()
            .map(|&(a, b)| {
                turn_cosine(
                    offset(ring.points[a], self.centre),
                    offset(ring.points[b], self.centre),
                )
            })
            .fold(f64::INFINITY, f64::min)
    }
}

enum StripReading {
    NotRound,
    Inward,
    Unread(UnreadBand),
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

    fn is_closed(&self) -> bool {
        let rings = &self.rings;
        rings.iter().all(|r| r.is_closed() || r.is_apex()) && !rings.iter().all(Ring::is_apex)
    }

    fn facets(&self) -> usize {
        self.rings.iter().map(|r| r.points.len()).max().unwrap_or(0)
    }

    fn closed_circles(&self) -> Option<ClosedCircles> {
        if !self.is_closed() {
            return None;
        }
        let shaped = usize::from(self.rings[1].points.len() > self.rings[0].points.len());
        let (circle, _) = self.rings[shaped].circle()?;
        let mut radii = [0.0; 2];
        radii[shaped] = circle.radius;
        let other = &self.rings[1 - shaped];
        if other.is_apex() {
            if planar_distance(other.points[0], circle.centre) >= circle.bend {
                return None;
            }
        } else {
            let (own, _) = other.circle()?;
            if planar_distance(own.centre, circle.centre) >= circle.bend.min(own.bend) {
                return None;
            }
            radii[1 - shaped] = own.radius;
        }
        Some(ClosedCircles {
            centre: circle.centre,
            radii,
            shaped,
        })
    }

    fn facing_about(&self, centre: [f64; 2]) -> Facing {
        let plane = across(self.axis);
        self.mesh.facing(&self.triangles, |normal, at| {
            normal[plane[0]] * (at[plane[0]] - centre[0])
                + normal[plane[1]] * (at[plane[1]] - centre[1])
        })
    }

    fn goes_around(&self, roundness: Roundness) -> Option<[f64; 2]> {
        let ring = self.rings.iter().max_by_key(|r| r.points.len())?;
        if ring.points.len() < roundness.coarse_facets {
            return None;
        }
        let (circle, _) = ring.circle()?;
        let other = &self.rings[usize::from(std::ptr::eq(ring, &self.rings[0]))];
        let other_on_circle = other.points.is_empty()
            || other.chords.is_empty()
            || Circle::about(
                &other.points,
                &other.chords,
                circle.centre,
                other.circumradius(circle.centre),
            )
            .is_some();
        let around = ring.around(circle.centre);
        let goes_round = (0..around.len()).all(|i| {
            let (a, b) = (around[i], around[(i + 1) % around.len()]);
            a[0] * b[1] - a[1] * b[0] > 0.0 && turn_cosine(a, b) >= roundness.coarse_turn_cosine
        });
        (other_on_circle && goes_round).then_some(circle.centre)
    }

    fn on_line(&self, centre: [f64; 2]) -> Option<[i32; 2]> {
        match centre.map(sixteenths::identified) {
            [Some(a), Some(b)] => Some([a, b]),
            _ => None,
        }
    }

    fn surface(&self, reason: SurfaceReason, centre: [f64; 2]) -> StripReading {
        StripReading::Unread(UnreadBand::Surface {
            reason,
            axis: self.axis,
            at: self.on_line(centre),
            ends: Ends::of(self.lo, self.hi),
        })
    }

    fn reading(&self, roundness: Roundness) -> StripReading {
        if self.is_closed() {
            return self.closed_reading(roundness);
        }
        let Some(centre) = self.goes_around(roundness) else {
            return StripReading::NotRound;
        };
        match self.facing_about(centre) {
            Facing::Unknown => self.surface(SurfaceReason::Facing, centre),
            Facing::Inward => StripReading::Inward,
            Facing::Outward => self.surface(SurfaceReason::Partial, centre),
        }
    }

    fn closed_reading(&self, roundness: Roundness) -> StripReading {
        if self.facets() < roundness.coarse_facets {
            return StripReading::NotRound;
        }
        let Some(circles) = self.closed_circles() else {
            let shaped = self.rings.iter().max_by_key(|r| r.points.len());
            let centre = shaped.map_or([0.0; 2], |r| r.extents().0);
            return match self.facing_about(centre) {
                Facing::Inward => StripReading::Inward,
                Facing::Unknown => StripReading::Unread(UnreadBand::Surface {
                    reason: SurfaceReason::Facing,
                    axis: self.axis,
                    at: None,
                    ends: Ends::of(self.lo, self.hi),
                }),
                Facing::Outward => StripReading::Unread(UnreadBand::Centre { axis: self.axis }),
            };
        };
        match self.facing_about(circles.centre) {
            Facing::Unknown => self.surface(SurfaceReason::Facing, circles.centre),
            Facing::Inward => StripReading::Inward,
            Facing::Outward if self.facets() < roundness.standard_facets => {
                self.surface(SurfaceReason::Faceted, circles.centre)
            }
            Facing::Outward => self.identified(&circles),
        }
    }

    fn identified(&self, circles: &ClosedCircles) -> StripReading {
        let Some(at) = self.on_line(circles.centre) else {
            return StripReading::Unread(UnreadBand::Centre { axis: self.axis });
        };
        match circles.radii.map(sixteenths::identified) {
            [Some(r0), Some(r1)] => StripReading::Read(ReadBand {
                axis: self.axis,
                at,
                lo: self.lo,
                hi: self.hi,
                radii: [r0, r1],
            }),
            _ => StripReading::Unread(UnreadBand::Radius {
                axis: self.axis,
                at,
                ends: Ends::of(self.lo, self.hi),
            }),
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
