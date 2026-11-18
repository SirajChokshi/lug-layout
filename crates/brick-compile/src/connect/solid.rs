use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::rc::Rc;

use super::depth_bands::DepthBands;
use super::profile::Point;
use crate::affine::Vec3;
use crate::flatten::Triangle;
use crate::lattice::STUD_LDU;

pub use crate::lattice::IDENTIFY_LDU;
const CELL_HASH_ROTATION: u32 = 26;
const CELL_HASH_MULTIPLIER: u64 = 0x9e37_79b9_7f4a_7c15;

#[derive(Default)]
struct CellHasher(u64);

impl Hasher for CellHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(u64::from(byte));
        }
    }

    fn write_i64(&mut self, value: i64) {
        self.write_u64(value as u64);
    }

    fn write_usize(&mut self, value: usize) {
        self.write_u64(value as u64);
    }

    fn write_u64(&mut self, value: u64) {
        self.0 =
            (self.0.rotate_left(CELL_HASH_ROTATION) ^ value).wrapping_mul(CELL_HASH_MULTIPLIER);
    }
}

type Cells<K, V> = HashMap<K, V, BuildHasherDefault<CellHasher>>;

pub const HALF_GRID_LDU: f64 = STUD_LDU / 2.0;
const TRAVEL_PRECISION_LDU: f64 = IDENTIFY_LDU / 64.0;

type Local = [f64; 3];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Probe {
    pub axis: usize,
    pub inward: f64,
    pub entrance: Vec3,
    pub radius: f64,
}

pub fn plan_axes(axis: usize) -> (usize, usize) {
    ((axis + 1) % 3, (axis + 2) % 3)
}

impl Probe {
    fn local(&self, p: Vec3) -> Local {
        let (i, j) = plan_axes(self.axis);
        [
            p[i] - self.entrance[i],
            p[j] - self.entrance[j],
            self.depth(p[self.axis]),
        ]
    }

    fn depth(&self, along: f64) -> f64 {
        (along - self.entrance[self.axis]) * self.inward
    }

    fn center(&self) -> [f64; 2] {
        let (i, j) = plan_axes(self.axis);
        [self.entrance[i], self.entrance[j]]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RoundShape {
    Wall { radius: f64, from: f64, to: f64 },
    Annulus { inner: f64, outer: f64, at: f64 },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoundSurface {
    pub axis: usize,
    pub center: [f64; 2],
    pub shape: RoundShape,
    pub full: bool,
    pub arcs: Vec<(f64, f64)>,
    pub facing: Option<f64>,
}

impl RoundSurface {
    fn depths(&self, probe: &Probe) -> (f64, f64) {
        let (a, b) = match self.shape {
            RoundShape::Wall { from, to, .. } => (probe.depth(from), probe.depth(to)),
            RoundShape::Annulus { at, .. } => (probe.depth(at), probe.depth(at)),
        };
        (a.min(b), a.max(b))
    }

    fn nearest(&self) -> f64 {
        match self.shape {
            RoundShape::Wall { radius, .. } => radius,
            RoundShape::Annulus { inner, .. } => inner,
        }
    }

    fn nearest_from(&self, center: [f64; 2]) -> f64 {
        let apart = (self.center[0] - center[0]).hypot(self.center[1] - center[1]);
        match self.shape {
            RoundShape::Wall { radius, .. } => (apart - radius).abs(),
            RoundShape::Annulus { inner, outer, .. } => {
                if apart <= IDENTIFY_LDU {
                    inner
                } else {
                    (inner - apart).max(apart - outer).max(0.0)
                }
            }
        }
    }

    fn radius_of(&self, p: Vec3) -> f64 {
        let (i, j) = plan_axes(self.axis);
        (p[i] - self.center[0]).hypot(p[j] - self.center[1])
    }

    fn holds(&self, p: Vec3) -> bool {
        let rho = self.radius_of(p);
        let along = p[self.axis];
        match self.shape {
            RoundShape::Wall { radius, from, to } => {
                (rho - radius).abs() <= IDENTIFY_LDU
                    && (from - IDENTIFY_LDU..=to + IDENTIFY_LDU).contains(&along)
            }
            RoundShape::Annulus { inner, outer, at } => {
                (along - at).abs() <= IDENTIFY_LDU
                    && (inner - IDENTIFY_LDU..=outer + IDENTIFY_LDU).contains(&rho)
            }
        }
    }

    fn on_circle(&self, p: Vec3) -> bool {
        let rho = self.radius_of(p);
        match self.shape {
            RoundShape::Wall { radius, .. } => (rho - radius).abs() <= IDENTIFY_LDU,
            RoundShape::Annulus { inner, outer, .. } => {
                (rho - inner).abs() <= IDENTIFY_LDU || (rho - outer).abs() <= IDENTIFY_LDU
            }
        }
    }

    fn reach(&self) -> f64 {
        match self.shape {
            RoundShape::Wall { radius, .. } => radius,
            RoundShape::Annulus { outer, .. } => outer,
        }
    }

    pub fn is_wall(&self) -> bool {
        matches!(self.shape, RoundShape::Wall { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Floor {
    pub depth: f64,
    pub faces_probe: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub axis: usize,
    pub outward: f64,
    pub at: f64,
    pub min: [f64; 2],
    pub max: [f64; 2],
}

struct Facet {
    points: [Vec3; 3],
    front: Option<Vec3>,
    low: Vec3,
    high: Vec3,
    owner: Option<usize>,
}

struct SlabPolygon {
    facet: usize,
    points: Ring,
}

pub struct Slab {
    axis: usize,
    inward: f64,
    at: f64,
    range: (f64, f64),
    polygons: Vec<SlabPolygon>,
    cells: Cells<(i64, i64), Vec<u32>>,
    extent: ([i64; 2], [i64; 2]),
}

#[derive(Clone)]
struct Patch {
    points: Vec<Local>,
    low: [f64; 2],
    high: [f64; 2],
}

impl Patch {
    fn new(points: Vec<Local>) -> Self {
        let low = [0, 1].map(|k| points.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min));
        let high = [0, 1].map(|k| {
            points
                .iter()
                .map(|p| p[k])
                .fold(f64::NEG_INFINITY, f64::max)
        });
        Patch { points, low, high }
    }

    fn near_path(&self, to: [f64; 2], reach: f64) -> bool {
        (0..2).all(|k| {
            self.low[k] <= to[k].max(0.0) + reach && self.high[k] >= to[k].min(0.0) - reach
        })
    }

    fn within(&self, to: [f64; 2], distance: f64) -> bool {
        self.near_path(to, distance + IDENTIFY_LDU)
            && polygon_segment_distance(&self.points, to) < distance
    }
}

struct Surroundings<'s> {
    polygons: Vec<Patch>,
    surfaces: Vec<&'s RoundSurface>,
    center: [f64; 2],
    clearance: f64,
}

impl<'s> Surroundings<'s> {
    fn along(&self, step: [f64; 2]) -> Surroundings<'s> {
        let reach = self.clearance + IDENTIFY_LDU;
        Surroundings {
            polygons: self
                .polygons
                .iter()
                .filter(|patch| patch.within(step, reach))
                .cloned()
                .collect(),
            surfaces: self.surfaces.clone(),
            center: self.center,
            clearance: self.clearance,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum LineUse {
    Floor,
    Profile,
    Within,
}

type LineKey = (LineUse, usize, [u64; 2], [u64; 2]);

type PlanBox = [[f64; 2]; 2];

pub struct Solid {
    facets: Vec<Facet>,
    depths: [OnceCell<DepthBands>; 3],
    lines: RefCell<Cells<LineKey, Rc<DepthBands>>>,
    no_line: Rc<DepthBands>,
    bounds: (Vec3, Vec3),
    columns: [OnceCell<Cells<(i64, i64), DepthBands>>; 3],
    surfaces: Vec<RoundSurface>,
    axes: Cells<(usize, i64, i64), Vec<usize>>,
    walls: [Cells<(i64, i64), Vec<usize>>; 3],
}

fn axis_key(value: f64) -> i64 {
    (value / IDENTIFY_LDU).floor() as i64
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

fn cell(value: f64) -> i64 {
    (value / HALF_GRID_LDU).floor() as i64
}

pub const SIXTEENTHS_PER_LDU: f64 = 16.0;

pub fn sixteenths(value: f64) -> Option<i64> {
    let steps = (value * SIXTEENTHS_PER_LDU).round();
    ((value - steps / SIXTEENTHS_PER_LDU).abs() <= IDENTIFY_LDU).then_some(steps as i64)
}

pub fn sixteenth(value: f64) -> Option<f64> {
    sixteenths(value).map(|steps| steps as f64 / SIXTEENTHS_PER_LDU + 0.0)
}

pub fn identified(value: f64) -> f64 {
    sixteenth(value).unwrap_or(value + 0.0)
}

fn plane_key(value: f64) -> i64 {
    (identified(value) / IDENTIFY_LDU).round() as i64
}

fn beyond_attaining(best: f64, swept: f64) -> bool {
    swept > best + 2.0 * IDENTIFY_LDU
}

fn crossing(p: Local, q: Local, at: f64) -> Local {
    let (a, b) = if p <= q { (p, q) } else { (q, p) };
    let t = (at - a[2]) / (b[2] - a[2]);
    [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), at]
}

const RING_CAPACITY: usize = 8;

#[derive(Clone, Copy)]
struct Ring {
    points: [Local; RING_CAPACITY],
    len: usize,
}

impl Ring {
    fn empty() -> Self {
        Ring {
            points: [[0.0; 3]; RING_CAPACITY],
            len: 0,
        }
    }

    fn push(&mut self, point: Local) {
        self.points[self.len] = point;
        self.len += 1;
    }
}

impl std::ops::Deref for Ring {
    type Target = [Local];

    fn deref(&self) -> &[Local] {
        &self.points[..self.len]
    }
}

fn clip(polygon: Ring, at: f64, keep_above: bool) -> Ring {
    let inside = |p: &Local| if keep_above { p[2] >= at } else { p[2] <= at };
    let mut out = Ring::empty();
    for (k, p) in polygon.iter().enumerate() {
        let q = polygon[(k + 1) % polygon.len()];
        if inside(p) {
            out.push(*p);
        }
        if inside(p) != inside(&q) {
            out.push(crossing(*p, q, at));
        }
    }
    out
}

fn slab_clip(polygon: Ring, from: f64, to: f64) -> Ring {
    clip(clip(polygon, from, true), to, false)
}

fn prism_clip(polygon: &[Local], piece: &[Point]) -> Vec<Local> {
    let mut out = polygon.to_vec();
    for k in 0..piece.len() {
        if out.is_empty() {
            break;
        }
        let (a, b) = (piece[k], piece[(k + 1) % piece.len()]);
        let side = |p: &Local| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        let mut kept = Vec::with_capacity(out.len() + 1);
        for (m, p) in out.iter().enumerate() {
            let q = out[(m + 1) % out.len()];
            let (sp, sq) = (side(p), side(&q));
            if sp >= 0.0 {
                kept.push(*p);
            }
            if (sp >= 0.0) != (sq >= 0.0) {
                let t = sp / (sp - sq);
                kept.push([0, 1, 2].map(|c| p[c] + t * (q[c] - p[c])));
            }
        }
        out = kept;
    }
    out
}

fn turn(a: Local, b: Local, c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn plan_area(polygon: &[Local]) -> f64 {
    let mut twice = 0.0;
    for (k, a) in polygon.iter().enumerate() {
        let b = polygon[(k + 1) % polygon.len()];
        twice += a[0] * b[1] - b[0] * a[1];
    }
    twice
}

fn bounds_reach(polygon: &[Local], point: [f64; 2]) -> bool {
    (0..2).all(|k| {
        polygon.iter().any(|p| p[k] <= point[k] + IDENTIFY_LDU)
            && polygon.iter().any(|p| p[k] >= point[k] - IDENTIFY_LDU)
    })
}

fn contains(polygon: &[Local], point: [f64; 2]) -> bool {
    let area = plan_area(polygon);
    if polygon.len() < 3 || area == 0.0 || !bounds_reach(polygon, point) {
        return false;
    }
    polygon.iter().enumerate().all(|(k, a)| {
        let side = turn(*a, polygon[(k + 1) % polygon.len()], point);
        side * area.signum() >= 0.0
    })
}

fn segment_radius(a: Local, b: Local) -> f64 {
    let du = b[0] - a[0];
    let dv = b[1] - a[1];
    let span = du * du + dv * dv;
    let t = if span == 0.0 {
        0.0
    } else {
        (-(a[0] * du + a[1] * dv) / span).clamp(0.0, 1.0)
    };
    (a[0] + t * du).hypot(a[1] + t * dv)
}

fn nearest_radius(polygon: &[Local]) -> f64 {
    if contains(polygon, [0.0, 0.0]) {
        return 0.0;
    }
    (0..polygon.len())
        .map(|k| segment_radius(polygon[k], polygon[(k + 1) % polygon.len()]))
        .fold(f64::INFINITY, f64::min)
}

fn point_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (du, dv) = (b[0] - a[0], b[1] - a[1]);
    let span = du * du + dv * dv;
    let t = if span == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * du + (p[1] - a[1]) * dv) / span).clamp(0.0, 1.0)
    };
    (p[0] - a[0] - t * du).hypot(p[1] - a[1] - t * dv)
}

fn segments_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let apart = |k: usize| {
        a[k].min(b[k]) > c[k].max(d[k]) + IDENTIFY_LDU
            || c[k].min(d[k]) > a[k].max(b[k]) + IDENTIFY_LDU
    };
    if apart(0) || apart(1) {
        return false;
    }
    let side = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| {
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    };
    let (d1, d2) = (side(c, d, a), side(c, d, b));
    let (d3, d4) = (side(a, b, c), side(a, b, d));
    d1 * d2 < 0.0 && d3 * d4 < 0.0
}

fn polygon_segment_distance(polygon: &[Local], to: [f64; 2]) -> f64 {
    let origin = [0.0, 0.0];
    if contains(polygon, origin) || contains(polygon, to) {
        return 0.0;
    }
    let mut nearest = f64::INFINITY;
    for (k, a) in polygon.iter().enumerate() {
        let b = polygon[(k + 1) % polygon.len()];
        let (a, b) = ([a[0], a[1]], [b[0], b[1]]);
        if segments_cross(a, b, origin, to) {
            return 0.0;
        }
        nearest = nearest
            .min(point_segment(a, origin, to))
            .min(point_segment(b, origin, to))
            .min(point_segment(origin, a, b))
            .min(point_segment(to, a, b));
    }
    nearest
}

fn farthest_radius(polygon: &[Local]) -> f64 {
    polygon.iter().map(|p| p[0].hypot(p[1])).fold(0.0, f64::max)
}

fn newell(polygon: &[Local]) -> Local {
    let mut n = [0.0; 3];
    for (k, a) in polygon.iter().enumerate() {
        let b = polygon[(k + 1) % polygon.len()];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

fn depth_span(polygon: &[Local]) -> (f64, f64) {
    polygon
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), p| {
            (low.min(p[2]), high.max(p[2]))
        })
}

fn first_depth(polygon: &[Local], inside: f64) -> Option<f64> {
    let squared = inside * inside;
    let mut best: Option<f64> = None;
    let mut take = |d: f64| best = Some(best.map_or(d, |b| b.min(d)));
    for p in polygon {
        if p[0] * p[0] + p[1] * p[1] <= squared {
            take(p[2]);
        }
    }
    for (k, a) in polygon.iter().enumerate() {
        let b = polygon[(k + 1) % polygon.len()];
        let (du, dv, dd) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let qa = du * du + dv * dv;
        if qa == 0.0 {
            continue;
        }
        let qb = 2.0 * (a[0] * du + a[1] * dv);
        let qc = a[0] * a[0] + a[1] * a[1] - squared;
        let discriminant = qb * qb - 4.0 * qa * qc;
        if discriminant < 0.0 {
            continue;
        }
        let root = discriminant.sqrt();
        for t in [(-qb - root) / (2.0 * qa), (-qb + root) / (2.0 * qa)] {
            if (0.0..=1.0).contains(&t) {
                take((a[2] + t * dd).clamp(a[2].min(b[2]), a[2].max(b[2])));
            }
        }
    }
    let n = newell(polygon);
    if polygon.len() >= 3 && n[2] != 0.0 {
        let origin = polygon[0];
        let gradient = [-n[0] / n[2], -n[1] / n[2]];
        let steep = gradient[0].hypot(gradient[1]);
        let lowest = if steep > 0.0 {
            [-inside * gradient[0] / steep, -inside * gradient[1] / steep]
        } else {
            [0.0, 0.0]
        };
        if contains(polygon, lowest) {
            let (shallowest, deepest) = depth_span(polygon);
            take(
                (origin[2]
                    + gradient[0] * (lowest[0] - origin[0])
                    + gradient[1] * (lowest[1] - origin[1]))
                    .clamp(shallowest, deepest),
            );
        }
    }
    best
}

pub fn span_of(angles: &[f64]) -> Option<(f64, f64)> {
    use std::f64::consts::{PI, TAU};
    let reference = *angles.first()?;
    let offset = |a: f64| {
        let mut d = a - reference;
        if d > PI {
            d -= TAU;
        } else if d <= -PI {
            d += TAU;
        }
        d
    };
    let low = angles
        .iter()
        .copied()
        .min_by(|a, b| offset(*a).total_cmp(&offset(*b)))?;
    let high = angles
        .iter()
        .copied()
        .max_by(|a, b| offset(*a).total_cmp(&offset(*b)))?;
    Some((low, high))
}

fn arc(polygon: &[Local]) -> Option<(f64, f64)> {
    let angles: Vec<f64> = polygon.iter().map(|p| p[1].atan2(p[0])).collect();
    span_of(&angles)
}

pub fn covers_circle(arcs: &[(f64, f64)], slack: f64) -> bool {
    use std::f64::consts::PI;
    let mut pieces: Vec<(f64, f64)> = Vec::with_capacity(arcs.len() + 1);
    for &(low, high) in arcs {
        if high >= low {
            pieces.push((low, high));
        } else {
            pieces.push((low, PI));
            pieces.push((-PI, high));
        }
    }
    pieces.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut reached = -PI;
    for (low, high) in pieces {
        if low > reached + slack {
            return false;
        }
        reached = reached.max(high);
    }
    reached + slack >= PI
}

struct Coverage {
    covered: Vec<(f64, f64)>,
    within_turn: bool,
}

impl Coverage {
    fn new(arcs: &[(f64, f64)]) -> Self {
        let mut coverage = Coverage {
            covered: Vec::new(),
            within_turn: true,
        };
        for &arc in arcs {
            coverage.add(arc);
        }
        coverage
    }

    fn add(&mut self, (low, high): (f64, f64)) {
        use std::f64::consts::PI;
        let turn = -PI..=PI;
        if !(turn.contains(&low) && turn.contains(&high)) {
            self.within_turn = false;
        }
        if !self.within_turn {
            return;
        }
        if high >= low {
            self.merge(low, high);
        } else {
            self.merge(low, PI);
            self.merge(-PI, high);
        }
    }

    fn merge(&mut self, mut low: f64, mut high: f64) {
        let start = self.covered.partition_point(|&(_, end)| end < low);
        let mut end = start;
        while end < self.covered.len() && self.covered[end].0 <= high {
            low = low.min(self.covered[end].0);
            high = high.max(self.covered[end].1);
            end += 1;
        }
        self.covered.splice(start..end, [(low, high)]);
    }

    fn complete(&self) -> bool {
        use std::f64::consts::PI;
        self.within_turn
            && matches!(self.covered.as_slice(), [(low, high)] if *low <= -PI && *high >= PI)
    }
}

fn axis_probe(axis: usize, center: [f64; 2], along: f64, inward: f64) -> Probe {
    let (i, j) = plan_axes(axis);
    let mut entrance = [0.0; 3];
    entrance[axis] = along;
    entrance[i] = center[0];
    entrance[j] = center[1];
    Probe {
        axis,
        inward,
        entrance,
        radius: 0.0,
    }
}

impl Solid {
    pub fn new(triangles: &[Triangle], surfaces: Vec<RoundSurface>) -> Self {
        let mut facets = Vec::with_capacity(triangles.len());
        for triangle in triangles {
            let [a, b, c] = triangle.points;
            let normal = cross(sub(b, a), sub(c, a));
            if normal == [0.0; 3] {
                continue;
            }
            let low = [0, 1, 2].map(|k| a[k].min(b[k]).min(c[k]));
            let high = [0, 1, 2].map(|k| a[k].max(b[k]).max(c[k]));
            facets.push(Facet {
                points: triangle.points,
                front: (!triangle.double_sided).then_some(normal),
                low,
                high,
                owner: None,
            });
        }
        let bounds = facets.iter().fold(
            ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]),
            |(low, high), facet: &Facet| {
                (
                    [0, 1, 2].map(|k| low[k].min(facet.low[k])),
                    [0, 1, 2].map(|k| high[k].max(facet.high[k])),
                )
            },
        );
        let mut solid = Solid {
            facets,
            depths: Default::default(),
            lines: RefCell::default(),
            no_line: Rc::new(DepthBands::new(Vec::new(), |_| 0.0, |_| 0.0)),
            bounds,
            columns: Default::default(),
            surfaces: Vec::new(),
            axes: Cells::default(),
            walls: Default::default(),
        };
        for (index, surface) in surfaces.iter().enumerate() {
            let probe = axis_probe(surface.axis, surface.center, 0.0, 1.0);
            let (from, to) = surface.depths(&probe);
            let held = (from - IDENTIFY_LDU, to + IDENTIFY_LDU);
            let reach = surface.reach() + IDENTIFY_LDU;
            for facet in solid.around(&probe, reach, held, reach) {
                let facet = &mut solid.facets[facet as usize];
                if facet.owner.is_none()
                    && facet.points.iter().all(|p| surface.holds(*p))
                    && facet.points.iter().any(|p| surface.on_circle(*p))
                {
                    facet.owner = Some(index);
                }
            }
        }
        for (index, surface) in surfaces.iter().enumerate() {
            if let RoundShape::Wall { radius, .. } = surface.shape {
                if surface.full {
                    for x in cell(surface.center[0] - radius)..=cell(surface.center[0] + radius) {
                        for y in cell(surface.center[1] - radius)..=cell(surface.center[1] + radius)
                        {
                            solid.walls[surface.axis]
                                .entry((x, y))
                                .or_default()
                                .push(index);
                        }
                    }
                }
            }
            solid
                .axes
                .entry((
                    surface.axis,
                    axis_key(surface.center[0]),
                    axis_key(surface.center[1]),
                ))
                .or_default()
                .push(index);
        }
        solid.surfaces = surfaces;
        solid
    }

    pub fn is_empty(&self) -> bool {
        self.facets.is_empty()
    }

    pub fn bounds(&self) -> (Vec3, Vec3) {
        self.bounds
    }

    fn bands(&self, axis: usize, facets: Vec<u32>) -> DepthBands {
        DepthBands::new(
            facets,
            |index| self.facets[index as usize].low[axis],
            |index| self.facets[index as usize].high[axis],
        )
    }

    fn column(&self, axis: usize) -> &Cells<(i64, i64), DepthBands> {
        self.columns[axis].get_or_init(|| {
            let (i, j) = plan_axes(axis);
            let mut cells: Cells<(i64, i64), Vec<u32>> = Cells::default();
            for (index, facet) in self.facets.iter().enumerate() {
                for x in cell(facet.low[i])..=cell(facet.high[i]) {
                    for y in cell(facet.low[j])..=cell(facet.high[j]) {
                        cells.entry((x, y)).or_default().push(index as u32);
                    }
                }
            }
            cells
                .into_iter()
                .map(|(key, facets)| (key, self.bands(axis, facets)))
                .collect()
        })
    }

    fn depth_index(&self, axis: usize) -> &DepthBands {
        self.depths[axis].get_or_init(|| self.bands(axis, (0..self.facets.len() as u32).collect()))
    }

    fn near(&self, probe: &Probe, reach: f64, depths: (f64, f64)) -> Vec<u32> {
        self.gather(probe, reach, depths, None)
    }

    fn around(&self, probe: &Probe, reach: f64, depths: (f64, f64), distance: f64) -> Vec<u32> {
        let mut out = Vec::new();
        self.each_around(probe, (reach, distance), depths, |index| {
            out.push(index);
            true
        });
        out.sort_unstable();
        out.dedup();
        out
    }

    fn each_around(
        &self,
        probe: &Probe,
        (reach, distance): (f64, f64),
        depths: (f64, f64),
        found: impl FnMut(u32) -> bool,
    ) -> bool {
        let (i, j) = plan_axes(probe.axis);
        let margin = distance + IDENTIFY_LDU;
        let plan = [
            [probe.entrance[i] - margin, probe.entrance[j] - margin],
            [probe.entrance[i] + margin, probe.entrance[j] + margin],
        ];
        self.each(probe, reach, depths, Some(&plan), found)
    }

    fn gather(
        &self,
        probe: &Probe,
        reach: f64,
        depths: (f64, f64),
        plan: Option<&PlanBox>,
    ) -> Vec<u32> {
        let mut out = Vec::new();
        self.each(probe, reach, depths, plan, |index| {
            out.push(index);
            true
        });
        out.sort_unstable();
        out.dedup();
        out
    }

    fn line(
        &self,
        probe: &Probe,
        purpose: LineUse,
        (reach, distance): (f64, f64),
        keep: impl Fn(usize, &Facet) -> bool,
    ) -> Rc<DepthBands> {
        let key = (
            purpose,
            probe.axis,
            probe.center().map(f64::to_bits),
            [reach.to_bits(), distance.to_bits()],
        );
        if let Some(found) = self.lines.borrow().get(&key) {
            return Rc::clone(found);
        }
        let mut indices = Vec::new();
        self.each_around(
            probe,
            (reach, distance),
            (f64::NEG_INFINITY, f64::INFINITY),
            |index| {
                indices.push(index);
                true
            },
        );
        indices.sort_unstable();
        indices.dedup();
        if indices.is_empty() {
            return Rc::clone(&self.no_line);
        }
        let kept: Vec<u32> = indices
            .into_iter()
            .filter(|&index| keep(index as usize, &self.facets[index as usize]))
            .collect();
        let bands = if kept.is_empty() {
            Rc::clone(&self.no_line)
        } else {
            Rc::new(self.bands(probe.axis, kept))
        };
        self.lines.borrow_mut().insert(key, Rc::clone(&bands));
        bands
    }

    fn meeting(
        &self,
        bands: &DepthBands,
        axis: usize,
        (from, to): (f64, f64),
        plan: Option<&PlanBox>,
        found: &mut impl FnMut(u32) -> bool,
    ) -> bool {
        let (i, j) = plan_axes(axis);
        let low_of = |index: u32| self.facets[index as usize].low[axis];
        bands.starting_before((from, to), low_of, &mut |index| {
            let facet = &self.facets[index as usize];
            let meets = |plan: &PlanBox| {
                plan[0][0] <= facet.high[i]
                    && facet.low[i] <= plan[1][0]
                    && plan[0][1] <= facet.high[j]
                    && facet.low[j] <= plan[1][1]
            };
            !(facet.high[axis] >= from && plan.is_none_or(meets)) || found(index)
        })
    }

    fn world_window(probe: &Probe, depths: (f64, f64)) -> (f64, f64) {
        let ends = [depths.0, depths.1].map(|d| probe.entrance[probe.axis] + probe.inward * d);
        (
            ends[0].min(ends[1]) - IDENTIFY_LDU,
            ends[0].max(ends[1]) + IDENTIFY_LDU,
        )
    }

    fn each(
        &self,
        probe: &Probe,
        reach: f64,
        depths: (f64, f64),
        plan: Option<&PlanBox>,
        mut found: impl FnMut(u32) -> bool,
    ) -> bool {
        let (i, j) = plan_axes(probe.axis);
        let (from, to) = Self::world_window(probe, depths);
        let column = self.column(probe.axis);
        for x in cell(probe.entrance[i] - reach)..=cell(probe.entrance[i] + reach) {
            for y in cell(probe.entrance[j] - reach)..=cell(probe.entrance[j] + reach) {
                if let Some(bands) = column.get(&(x, y)) {
                    if !self.meeting(bands, probe.axis, (from, to), plan, &mut found) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn deepest(&self, probe: &Probe) -> f64 {
        let (low, high) = self.bounds;
        probe
            .depth(low[probe.axis])
            .max(probe.depth(high[probe.axis]))
    }

    fn sweep(
        &self,
        probe: &Probe,
        line: &DepthBands,
        (mut best, limit): (f64, f64),
        mut visit: impl FnMut(&Facet) -> Option<f64>,
    ) -> f64 {
        if self.facets.is_empty() || best < limit {
            return best;
        }
        let deepest = self.deepest(probe);
        let mut swept = f64::NEG_INFINITY;
        let mut from = -IDENTIFY_LDU;
        let mut width = HALF_GRID_LDU;
        loop {
            let to = from + width;
            let (world_from, world_to) = Self::world_window(probe, (from, to));
            let window = (world_from, world_to);
            let finished = self.meeting(line, probe.axis, window, None, &mut |index| {
                let facet = &self.facets[index as usize];
                let (low, high) = self.depth_range(probe, facet);
                if high < -IDENTIFY_LDU || low > to || low <= swept {
                    return true;
                }
                if let Some(d) = visit(facet) {
                    best = best.min(d);
                }
                best >= limit
            });
            if !finished {
                return best;
            }
            if to >= deepest || beyond_attaining(best, to) {
                return best;
            }
            swept = to;
            from = to;
            width *= 2.0;
        }
    }

    fn polygon(&self, probe: &Probe, facet: &Facet) -> Ring {
        let mut ring = Ring::empty();
        for point in facet.points {
            ring.push(probe.local(point));
        }
        ring
    }

    fn plan_gap(&self, probe: &Probe, facet: &Facet) -> f64 {
        let (i, j) = plan_axes(probe.axis);
        let gap = |k: usize| {
            (facet.low[k] - probe.entrance[k])
                .max(probe.entrance[k] - facet.high[k])
                .max(0.0)
        };
        gap(i).hypot(gap(j))
    }

    fn apart(&self, probe: &Probe, facet: &Facet, distance: f64) -> bool {
        self.plan_gap(probe, facet) > distance + IDENTIFY_LDU
            || self.clear_of(probe, facet, distance)
    }

    fn clear_of(&self, probe: &Probe, facet: &Facet, distance: f64) -> bool {
        let (i, j) = plan_axes(probe.axis);
        let p = facet
            .points
            .map(|q| [q[i] - probe.entrance[i], q[j] - probe.entrance[j], 0.0]);
        let beyond = distance + IDENTIFY_LDU;
        if (0..3).any(|k| segment_radius(p[k], p[(k + 1) % 3]) <= beyond) {
            return false;
        }
        let area = turn(p[0], p[1], [p[2][0], p[2][1]]);
        (0..3).any(|k| turn(p[k], p[(k + 1) % 3], [0.0, 0.0]) * area < 0.0)
    }

    fn depth_range(&self, probe: &Probe, facet: &Facet) -> (f64, f64) {
        let a = probe.depth(facet.low[probe.axis]);
        let b = probe.depth(facet.high[probe.axis]);
        (a.min(b), a.max(b))
    }

    fn coaxial(&self, probe: &Probe) -> Vec<usize> {
        let center = probe.center();
        let (u, v) = (axis_key(center[0]), axis_key(center[1]));
        let mut out = Vec::new();
        for du in -1..=1 {
            for dv in -1..=1 {
                let Some(found) = self.axes.get(&(probe.axis, u + du, v + dv)) else {
                    continue;
                };
                out.extend(found.iter().copied().filter(|&index| {
                    let s = &self.surfaces[index];
                    (s.center[0] - center[0]).hypot(s.center[1] - center[1]) <= IDENTIFY_LDU
                }));
            }
        }
        out
    }

    fn exact(&self, probe: &Probe, reach: f64) -> Vec<usize> {
        let center = probe.center();
        let mut out = self.coaxial(probe);
        for x in cell(center[0] - reach)..=cell(center[0] + reach) {
            for y in cell(center[1] - reach)..=cell(center[1] + reach) {
                if let Some(found) = self.walls[probe.axis].get(&(x, y)) {
                    out.extend_from_slice(found);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    fn owned_by(&self, facet: usize, surfaces: &[usize]) -> bool {
        self.facets[facet]
            .owner
            .is_some_and(|owner| surfaces.contains(&owner))
    }

    pub fn floor(&self, probe: &Probe, inside: f64) -> Floor {
        self.floor_until(probe, inside, f64::NEG_INFINITY)
    }

    pub fn floor_beyond(&self, probe: &Probe, inside: f64, limit: f64) -> Option<Floor> {
        Some(self.floor_until(probe, inside, limit)).filter(|floor| floor.depth >= limit)
    }

    fn floor_until(&self, probe: &Probe, inside: f64, limit: f64) -> Floor {
        let coaxial = self.exact(probe, inside + IDENTIFY_LDU);
        let mut attaining: Vec<(f64, Option<f64>)> = Vec::new();
        for &index in &coaxial {
            let surface = &self.surfaces[index];
            let (low, high) = surface.depths(probe);
            if surface.nearest_from(probe.center()) >= inside || high < -IDENTIFY_LDU {
                continue;
            }
            let d = low.max(-IDENTIFY_LDU);
            let along = match surface.shape {
                RoundShape::Annulus { .. } => surface.facing.map(|f| f * probe.inward),
                RoundShape::Wall { .. } => Some(0.0),
            };
            attaining.push((d, along));
        }
        let analytic = attaining.iter().map(|a| a.0).fold(f64::INFINITY, f64::min);
        let window = (inside + IDENTIFY_LDU, inside);
        let line = self.line(probe, LineUse::Floor, window, |index, facet| {
            !self.apart(probe, facet, inside) && !self.owned_by(index, &coaxial)
        });
        let depth = self.sweep(probe, &line, (analytic, limit), |facet| {
            let polygon = clip(self.polygon(probe, facet), -IDENTIFY_LDU, true);
            if polygon.is_empty() {
                return None;
            }
            let d = first_depth(&polygon, inside)?;
            attaining.push((d, facet.front.map(|front| front[probe.axis] * probe.inward)));
            Some(d)
        });
        let mut faces_probe = None;
        for (d, along) in attaining {
            if d > depth + IDENTIFY_LDU {
                continue;
            }
            match along {
                Some(along) if along != 0.0 => {
                    faces_probe = Some(faces_probe.unwrap_or(true) && along < 0.0);
                }
                _ => {}
            }
        }
        Floor { depth, faces_probe }
    }

    pub fn cross_section(&self, probe: &Probe, range: (f64, f64), reach: f64) -> Vec<Vec<Point>> {
        self.near(probe, reach, range)
            .into_iter()
            .filter_map(|index| {
                let facet = &self.facets[index as usize];
                let (low, high) = self.depth_range(probe, facet);
                if high < range.0 || low > range.1 {
                    return None;
                }
                let clipped = slab_clip(self.polygon(probe, facet), range.0, range.1);
                (!clipped.is_empty()).then(|| clipped.iter().map(|p| [p[0], p[1]]).collect())
            })
            .collect()
    }

    pub fn section_reaches(
        &self,
        probe: &Probe,
        range: (f64, f64),
        reach: f64,
        beyond: f64,
    ) -> bool {
        !self.each(probe, reach, range, None, |index| {
            let facet = &self.facets[index as usize];
            let (low, high) = self.depth_range(probe, facet);
            if high < range.0 || low > range.1 {
                return true;
            }
            let clipped = slab_clip(self.polygon(probe, facet), range.0, range.1);
            clipped.iter().all(|p| p[0].hypot(p[1]) <= beyond)
        })
    }

    pub fn profile_floor(&self, probe: &Probe, pieces: &[Vec<Point>], reach: f64) -> Floor {
        let mut attaining: Vec<(f64, Option<f64>)> = Vec::new();
        let extent = pieces
            .iter()
            .flatten()
            .map(|p| p[0].hypot(p[1]))
            .fold(0.0, f64::max);
        let line = self.line(probe, LineUse::Profile, (reach, extent), |_, facet| {
            !self.apart(probe, facet, extent)
        });
        let depth = self.sweep(probe, &line, (f64::INFINITY, f64::NEG_INFINITY), |facet| {
            let polygon = clip(self.polygon(probe, facet), -IDENTIFY_LDU, true);
            let (low, high) = depth_span(&polygon);
            let mut shallowest: Option<f64> = None;
            for piece in pieces {
                let inside = prism_clip(&polygon, piece);
                if let Some(d) = inside.iter().map(|p| p[2]).reduce(f64::min) {
                    let d = d.clamp(low, high);
                    shallowest = Some(shallowest.map_or(d, |s| s.min(d)));
                    attaining.push((d, facet.front.map(|front| front[probe.axis] * probe.inward)));
                }
            }
            shallowest
        });
        let mut faces_probe = None;
        for (d, along) in attaining {
            if d > depth + IDENTIFY_LDU {
                continue;
            }
            if let Some(along) = along.filter(|a| *a != 0.0) {
                faces_probe = Some(faces_probe.unwrap_or(true) && along < 0.0);
            }
        }
        Floor { depth, faces_probe }
    }

    pub fn slab(
        &self,
        axis: usize,
        inward: f64,
        at: f64,
        range: (f64, f64),
        ignores: impl Fn(&RoundSurface) -> bool,
    ) -> Slab {
        let probe = axis_probe(axis, [at, at], at, inward);
        let (from, to) = Self::world_window(&probe, range);
        let mut meeting = Vec::new();
        self.meeting(
            self.depth_index(axis),
            axis,
            (from, to),
            None,
            &mut |index| {
                meeting.push(index as usize);
                true
            },
        );
        meeting.sort_unstable();
        let mut polygons = Vec::new();
        for index in meeting {
            let facet = &self.facets[index];
            let (low, high) = self.depth_range(&probe, facet);
            if high < range.0
                || low > range.1
                || facet.owner.is_some_and(|o| ignores(&self.surfaces[o]))
            {
                continue;
            }
            let clipped = slab_clip(self.polygon(&probe, facet), range.0, range.1);
            if clipped.is_empty() {
                continue;
            }
            let mut plan = Ring::empty();
            for p in clipped.iter() {
                plan.push([p[0] + at, p[1] + at, 0.0]);
            }
            polygons.push(SlabPolygon {
                facet: index,
                points: plan,
            });
        }
        let mut cells: Cells<(i64, i64), Vec<u32>> = Cells::default();
        let mut extent = ([i64::MAX; 2], [i64::MIN; 2]);
        for (index, polygon) in polygons.iter().enumerate() {
            let low = [0, 1].map(|k| {
                cell(
                    polygon
                        .points
                        .iter()
                        .map(|p| p[k])
                        .fold(f64::INFINITY, f64::min),
                )
            });
            let high = [0, 1].map(|k| {
                cell(
                    polygon
                        .points
                        .iter()
                        .map(|p| p[k])
                        .fold(f64::NEG_INFINITY, f64::max),
                )
            });
            for k in 0..2 {
                extent.0[k] = extent.0[k].min(low[k]);
                extent.1[k] = extent.1[k].max(high[k]);
            }
            for x in low[0]..=high[0] {
                for y in low[1]..=high[1] {
                    cells.entry((x, y)).or_default().push(index as u32);
                }
            }
        }
        Slab {
            axis,
            inward,
            at,
            range,
            polygons,
            cells,
            extent,
        }
    }

    fn shifted(polygon: &SlabPolygon, center: [f64; 2]) -> Ring {
        let mut shifted = Ring::empty();
        for p in polygon.points.iter() {
            shifted.push([p[0] - center[0], p[1] - center[1], 0.0]);
        }
        shifted
    }

    fn in_slab(slab: &Slab, surface: &RoundSurface, probe: &Probe) -> bool {
        let (low, high) = surface.depths(probe);
        high >= slab.range.0 && low <= slab.range.1
    }

    pub fn nearest(&self, probe: &Probe, range: (f64, f64), reach: f64) -> f64 {
        let coaxial = self.exact(probe, reach);
        let mut best = self.analytic_nearest(probe, range, &coaxial);
        let mut candidates: Vec<(f64, u32)> = self
            .near(probe, reach, range)
            .into_iter()
            .filter(|&index| !self.owned_by(index as usize, &coaxial))
            .map(|index| (self.plan_gap(probe, &self.facets[index as usize]), index))
            .collect();
        candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (gap, index) in candidates {
            if gap > best + IDENTIFY_LDU {
                break;
            }
            if let Some(radius) = self.slab_radius(probe, &self.facets[index as usize], range) {
                best = best.min(radius);
            }
        }
        best
    }

    pub fn comes_within(
        &self,
        probe: &Probe,
        range: (f64, f64),
        reach: f64,
        distance: f64,
    ) -> bool {
        let coaxial = self.exact(probe, reach);
        if self.analytic_nearest(probe, range, &coaxial) < distance {
            return true;
        }
        let line = self.line(probe, LineUse::Within, (reach, distance), |index, facet| {
            !self.apart(probe, facet, distance) && !self.owned_by(index, &coaxial)
        });
        let (from, to) = Self::world_window(probe, range);
        !self.meeting(&line, probe.axis, (from, to), None, &mut |index| {
            self.slab_radius(probe, &self.facets[index as usize], range)
                .is_none_or(|radius| radius >= distance)
        })
    }

    fn slab_radius(&self, probe: &Probe, facet: &Facet, range: (f64, f64)) -> Option<f64> {
        let (low, high) = self.depth_range(probe, facet);
        if high < range.0 || low > range.1 {
            return None;
        }
        let clipped = slab_clip(self.polygon(probe, facet), range.0, range.1);
        (!clipped.is_empty()).then(|| nearest_radius(&clipped))
    }

    fn analytic_nearest(&self, probe: &Probe, range: (f64, f64), coaxial: &[usize]) -> f64 {
        coaxial
            .iter()
            .map(|&index| &self.surfaces[index])
            .filter(|surface| {
                let (low, high) = surface.depths(probe);
                high >= range.0 && low <= range.1
            })
            .map(|surface| surface.nearest_from(probe.center()))
            .fold(f64::INFINITY, f64::min)
    }

    fn swept_reach(&self, surface: &RoundSurface, center: [f64; 2], to: [f64; 2]) -> f64 {
        let offset = [surface.center[0] - center[0], surface.center[1] - center[1]];
        let low = point_segment(offset, [0.0, 0.0], to);
        let high = offset[0]
            .hypot(offset[1])
            .max((offset[0] - to[0]).hypot(offset[1] - to[1]));
        let between = |radius: f64| {
            if (low..=high).contains(&radius) {
                0.0
            } else {
                (low - radius).abs().min((high - radius).abs())
            }
        };
        match surface.shape {
            RoundShape::Wall { radius, .. } => between(radius),
            RoundShape::Annulus { inner, outer, .. } => {
                if high < inner {
                    inner - high
                } else if low > outer {
                    low - outer
                } else {
                    0.0
                }
            }
        }
    }

    fn surroundings(
        &self,
        probe: &Probe,
        range: (f64, f64),
        steps: &[[f64; 2]],
        clearance: f64,
    ) -> Surroundings<'_> {
        let longest = steps.iter().map(|s| s[0].hypot(s[1])).fold(0.0, f64::max);
        let reach = probe.radius + longest + IDENTIFY_LDU;
        let exact = self.exact(probe, reach);
        let polygons: Vec<Patch> = self
            .around(probe, reach, range, reach)
            .into_iter()
            .filter(|&index| !self.owned_by(index as usize, &exact))
            .filter_map(|index| {
                let facet = &self.facets[index as usize];
                let (low, high) = self.depth_range(probe, facet);
                if high < range.0 || low > range.1 {
                    return None;
                }
                let clipped = slab_clip(self.polygon(probe, facet), range.0, range.1);
                (!clipped.is_empty()).then(|| Patch::new(clipped.to_vec()))
            })
            .collect();
        let surfaces: Vec<&RoundSurface> = exact
            .iter()
            .map(|&index| &self.surfaces[index])
            .filter(|surface| {
                let (low, high) = surface.depths(probe);
                high >= range.0 && low <= range.1
            })
            .collect();
        Surroundings {
            polygons,
            surfaces,
            center: probe.center(),
            clearance,
        }
    }

    fn sweep_collides(&self, around: &Surroundings, to: [f64; 2]) -> bool {
        around
            .polygons
            .iter()
            .any(|patch| patch.within(to, around.clearance))
            || around
                .surfaces
                .iter()
                .any(|surface| self.swept_reach(surface, around.center, to) < around.clearance)
    }

    pub fn confined(&self, probe: &Probe, range: (f64, f64), steps: &[[f64; 2]]) -> bool {
        let around = self.surroundings(probe, range, steps, probe.radius - IDENTIFY_LDU);
        steps.iter().all(|&to| self.sweep_collides(&around, to))
    }

    pub fn travel(&self, probe: &Probe, range: (f64, f64), steps: &[[f64; 2]]) -> Vec<f64> {
        let surroundings = self.surroundings(probe, range, steps, probe.radius);
        steps
            .iter()
            .map(|&step| {
                let around = surroundings.along(step);
                let length = step[0].hypot(step[1]);
                let contact = IDENTIFY_LDU / length;
                let (mut free, mut blocked) =
                    if self.sweep_collides(&around, [step[0] * contact, step[1] * contact]) {
                        (0.0, contact)
                    } else if self.sweep_collides(&around, step) {
                        (contact, 1.0)
                    } else {
                        return f64::INFINITY;
                    };
                while (blocked - free) * length > TRAVEL_PRECISION_LDU {
                    let middle = 0.5 * (free + blocked);
                    if self.sweep_collides(&around, [step[0] * middle, step[1] * middle]) {
                        blocked = middle;
                    } else {
                        free = middle;
                    }
                }
                free * length
            })
            .collect()
    }

    pub fn bore_continues_outward(&self, probe: &Probe) -> bool {
        self.coaxial(probe).into_iter().any(|index| {
            let surface = &self.surfaces[index];
            let (low, high) = surface.depths(probe);
            surface.is_wall()
                && (surface.nearest() - probe.radius).abs() <= IDENTIFY_LDU
                && low < -IDENTIFY_LDU
                && high > IDENTIFY_LDU
        })
    }

    fn coaxial_arcs(
        &self,
        slab: &Slab,
        probe: &Probe,
        coaxial: &[usize],
        ignores: &impl Fn(&RoundSurface) -> bool,
    ) -> Option<Vec<(f64, f64)>> {
        let mut arcs = Vec::new();
        for &index in coaxial {
            let surface = &self.surfaces[index];
            if ignores(surface) || !Self::in_slab(slab, surface, probe) {
                continue;
            }
            if surface.full || surface.nearest() == 0.0 {
                return None;
            }
            arcs.extend(surface.arcs.iter().copied());
        }
        Some(arcs)
    }

    pub fn blocked_on_axes(
        &self,
        slab: &Slab,
        center: [f64; 2],
        ignores: impl Fn(&RoundSurface) -> bool,
    ) -> bool {
        let probe = axis_probe(slab.axis, center, slab.at, slab.inward);
        let coaxial = self.coaxial(&probe);
        let Some(arcs) = self.coaxial_arcs(slab, &probe, &coaxial, &ignores) else {
            return true;
        };
        self.rays_blocked(slab, center, &coaxial, &arcs, &ignores)
    }

    fn rays_blocked(
        &self,
        slab: &Slab,
        center: [f64; 2],
        coaxial: &[usize],
        arcs: &[(f64, f64)],
        ignores: &impl Fn(&RoundSurface) -> bool,
    ) -> bool {
        if slab.polygons.is_empty() {
            return false;
        }
        let home = [cell(center[0]), cell(center[1])];
        let blocks = |polygon: &SlabPolygon| {
            !self.facets[polygon.facet]
                .owner
                .is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o]))
        };
        let covered_by_coaxial = |direction: [f64; 2]| {
            let angle = direction[1].atan2(direction[0]);
            arcs.iter().any(|&(low, high)| {
                if high >= low {
                    (low..=high).contains(&angle)
                } else {
                    angle >= low || angle <= high
                }
            })
        };
        [[1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0]]
            .into_iter()
            .all(|direction| {
                covered_by_coaxial(direction)
                    || Self::ray_hits(slab, home, center, direction, &blocks)
            })
    }

    pub fn enclosed(
        &self,
        slab: &Slab,
        center: [f64; 2],
        ignores: impl Fn(&RoundSurface) -> bool,
    ) -> bool {
        let probe = axis_probe(slab.axis, center, slab.at, slab.inward);
        let coaxial = self.coaxial(&probe);
        let Some(mut arcs) = self.coaxial_arcs(slab, &probe, &coaxial, &ignores) else {
            return true;
        };
        if slab.polygons.is_empty() {
            return covers_circle(&arcs, 0.0);
        }
        if !self.rays_blocked(slab, center, &coaxial, &arcs, &ignores) {
            return false;
        }
        let mut coverage = Coverage::new(&arcs);
        if coverage.complete() {
            return true;
        }
        let home = [cell(center[0]), cell(center[1])];
        let rings = (0..2)
            .map(|k| (home[k] - slab.extent.0[k]).max(slab.extent.1[k] - home[k]))
            .max()
            .unwrap_or(0)
            .max(0);
        let mut seen = vec![false; slab.polygons.len()];
        let mut checked = 0;
        let mut next_check = 0;
        for ring in 0..=rings {
            for x in home[0] - ring..=home[0] + ring {
                for y in home[1] - ring..=home[1] + ring {
                    if (x - home[0]).abs() != ring && (y - home[1]).abs() != ring {
                        continue;
                    }
                    let Some(found) = slab.cells.get(&(x, y)) else {
                        continue;
                    };
                    for &index in found {
                        let index = index as usize;
                        if std::mem::replace(&mut seen[index], true) {
                            continue;
                        }
                        let polygon = &slab.polygons[index];
                        let owner = self.facets[polygon.facet].owner;
                        if owner.is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o]))
                        {
                            continue;
                        }
                        let shifted = Self::shifted(polygon, center);
                        if nearest_radius(&shifted) == 0.0 {
                            return true;
                        }
                        if let Some(span) = arc(&shifted) {
                            arcs.push(span);
                            coverage.add(span);
                            if coverage.complete() {
                                return true;
                            }
                        }
                    }
                }
            }
            let due = ring == rings || ring == next_check;
            if !coverage.within_turn && due && arcs.len() > checked {
                if covers_circle(&arcs, 0.0) {
                    return true;
                }
                checked = arcs.len();
            }
            if ring == next_check {
                next_check = (next_check * 2).max(1);
            }
        }
        false
    }

    fn ray_hits(
        slab: &Slab,
        home: [i64; 2],
        center: [f64; 2],
        direction: [f64; 2],
        blocks: &impl Fn(&SlabPolygon) -> bool,
    ) -> bool {
        let (along, across) = if direction[0] != 0.0 { (0, 1) } else { (1, 0) };
        let sign = direction[along];
        let mut step = home;
        loop {
            if let Some(found) = slab.cells.get(&(step[0], step[1])) {
                for &index in found {
                    let polygon = &slab.polygons[index as usize];
                    if !blocks(polygon) {
                        continue;
                    }
                    let shifted = Self::shifted(polygon, center);
                    let hit = shifted.iter().enumerate().any(|(k, a)| {
                        let b = shifted[(k + 1) % shifted.len()];
                        let (a_across, b_across) = (a[across], b[across]);
                        if (a_across > 0.0 && b_across > 0.0) || (a_across < 0.0 && b_across < 0.0)
                        {
                            return false;
                        }
                        if a_across == b_across {
                            return a[along] * sign >= 0.0 || b[along] * sign >= 0.0;
                        }
                        let t = a_across / (a_across - b_across);
                        (a[along] + t * (b[along] - a[along])) * sign >= 0.0
                    });
                    if hit || nearest_radius(&shifted) == 0.0 {
                        return true;
                    }
                }
            }
            step[along] += sign as i64;
            let past = if sign > 0.0 {
                step[along] > slab.extent.1[along]
            } else {
                step[along] < slab.extent.0[along]
            };
            if past {
                return false;
            }
        }
    }

    pub fn stands_on(&self, probe: &Probe, at: f64, radius: f64, toward: f64) -> bool {
        let reach = radius + IDENTIFY_LDU;
        self.around(probe, reach, (at - IDENTIFY_LDU, at + IDENTIFY_LDU), reach)
            .into_iter()
            .any(|index| {
                let facet = &self.facets[index as usize];
                let (low, high) = self.depth_range(probe, facet);
                if (low - at).abs() > IDENTIFY_LDU || (high - at).abs() > IDENTIFY_LDU {
                    return false;
                }
                let facing = facet
                    .front
                    .is_none_or(|front| front[probe.axis] * probe.inward * toward > 0.0);
                let polygon = self.polygon(probe, facet);
                facing
                    && farthest_radius(&polygon) > radius + IDENTIFY_LDU
                    && nearest_radius(&polygon) <= radius + IDENTIFY_LDU
            })
    }

    pub fn planes(&self) -> Vec<Plane> {
        let mut found: HashMap<(usize, i8, i64), Plane> = HashMap::new();
        for facet in &self.facets {
            let [a, b, c] = facet.points;
            let Some(axis) = (0..3).find(|&k| {
                (a[k] - b[k]).abs() <= IDENTIFY_LDU && (a[k] - c[k]).abs() <= IDENTIFY_LDU
            }) else {
                continue;
            };
            let at = identified((a[axis] + b[axis] + c[axis]) / 3.0);
            let outwards: &[f64] = match facet.front {
                Some(front) if front[axis] > 0.0 => &[1.0],
                Some(front) if front[axis] < 0.0 => &[-1.0],
                Some(_) => &[],
                None => &[1.0, -1.0],
            };
            let (i, j) = plan_axes(axis);
            for &outward in outwards {
                let plane = found
                    .entry((axis, outward as i8, plane_key(at)))
                    .or_insert(Plane {
                        axis,
                        outward,
                        at,
                        min: [f64::INFINITY; 2],
                        max: [f64::NEG_INFINITY; 2],
                    });
                plane.min = [
                    plane.min[0].min(facet.low[i]),
                    plane.min[1].min(facet.low[j]),
                ];
                plane.max = [
                    plane.max[0].max(facet.high[i]),
                    plane.max[1].max(facet.high[j]),
                ];
            }
        }
        let mut planes: Vec<Plane> = found.into_values().collect();
        planes.sort_by(|p, q| {
            (p.axis, p.outward as i8, p.at)
                .partial_cmp(&(q.axis, q.outward as i8, q.at))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        planes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAR: f64 = 3.990524629937766e16;
    const NEAR: f64 = 9.999501;

    #[test]
    fn a_floor_never_lies_below_the_facet_that_holds_it() {
        let steep = [[1.0, -1.0, FAR], [1.0, 1.0, FAR], [-1.0, 0.0, NEAR]];
        let depth = first_depth(&steep, 1.0).expect("the facet reaches into the disc");
        assert!(depth >= NEAR, "{depth}");
    }

    #[test]
    fn a_profile_floor_never_lies_below_the_facet_that_holds_it() {
        let steep = Triangle {
            color: 16,
            points: [[1.0, -1.0, FAR], [1.0, 1.0, FAR], [-1.0, 0.0, NEAR]],
            double_sided: true,
        };
        let solid = Solid::new(&[steep], Vec::new());
        let probe = Probe {
            axis: 2,
            inward: 1.0,
            entrance: [0.0; 3],
            radius: 4.0,
        };
        let left_of_the_near_corner = vec![[-3.0, -2.0], [-1.0, -2.0], [-1.0, 2.0], [-3.0, 2.0]];
        let floor = solid.profile_floor(&probe, &[left_of_the_near_corner], 4.0);
        assert!(floor.depth >= NEAR, "{}", floor.depth);
    }
}
