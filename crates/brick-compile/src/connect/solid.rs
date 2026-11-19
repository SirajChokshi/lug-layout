use std::cell::{OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::f64::consts::{FRAC_PI_2, SQRT_2, TAU};
use std::hash::{BuildHasherDefault, Hasher};
use std::rc::Rc;

use super::depth_bands::DepthBands;
use super::profile::Point;
use crate::affine::Vec3;
use crate::circle::{
    approximate_span, certainly_uncovered, contains as arc_contains,
    covers_circle as covers_exactly, covers_circle_filtered, inner_complete, inner_turns, span,
    wraps as arc_wraps, Approximate, ApproximateSpan, ArcSpan, Bearing, Direction, Junction,
    ATAN2_SLACK, TURNS,
};
use crate::exact::{Decimal, Exact, ExactVec3};
use crate::flatten::{ExactTriangle, Triangle};
use crate::homogeneous::{clip_between, ray_crosses, touches_origin, Homogeneous};
use crate::lattice::STUD_LDU;
use crate::trig::planar_length;

pub use crate::identify::IDENTIFY_LDU;
use crate::identify::{identified, sixteenths, IDENTIFY_REPRESENTATION_GUARD_LDU};
const CERTAIN_LDU: f64 = 1e-6;
const FLOAT_ERROR_LDU: f64 = 1e-9;
const IDENTIFICATION_REACH_LDU: f64 = IDENTIFY_LDU + IDENTIFY_REPRESENTATION_GUARD_LDU;
const FLOAT_RELATIVE_ERROR: f64 = f64::EPSILON * 65_536.0;
const ANY_DEPTH: (f64, f64) = (f64::NEG_INFINITY, f64::INFINITY);
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
    pub arcs: Option<Vec<ArcSpan>>,
    pub facing: Option<f64>,
    pub piece: u16,
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
        let apart = planar_length(self.center[0] - center[0], self.center[1] - center[1]);
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
        planar_length(p[i] - self.center[0], p[j] - self.center[1])
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

struct Attainer {
    inner: f64,
    rim: f64,
    along: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Plane {
    pub axis: usize,
    pub outward: f64,
    pub at: f64,
    pub exact_at: Option<Exact>,
    pub min: [f64; 2],
    pub max: [f64; 2],
}

struct Facet {
    points: [Vec3; 3],
    exact: Option<ExactTriangle>,
    front: Option<Vec3>,
    low: Vec3,
    high: Vec3,
    owner: Option<usize>,
    piece: u16,
}

struct SlabPolygon {
    facet: usize,
    reach: PlanBounds,
    finite: bool,
    float_clip: OnceCell<Option<FloatClip>>,
}

type ListedCell = ((i64, i64), PlanBounds);

#[derive(Clone, Copy)]
enum ArcEnd {
    Known(usize),
    Polygon(usize, bool),
}

struct FloatClip {
    points: Ring,
    error: f64,
}

#[derive(Clone, Copy)]
struct PlanBounds {
    low: [f64; 2],
    high: [f64; 2],
}

impl PlanBounds {
    fn empty() -> Self {
        PlanBounds {
            low: [f64::INFINITY; 2],
            high: [f64::NEG_INFINITY; 2],
        }
    }

    fn everywhere() -> Self {
        PlanBounds {
            low: [f64::NEG_INFINITY; 2],
            high: [f64::INFINITY; 2],
        }
    }

    fn within(self, outer: PlanBounds) -> Self {
        PlanBounds {
            low: [0, 1].map(|k| self.low[k].max(outer.low[k])),
            high: [0, 1].map(|k| self.high[k].min(outer.high[k])),
        }
    }

    fn padded(self, by: f64) -> Self {
        PlanBounds {
            low: self.low.map(|v| v - by),
            high: self.high.map(|v| v + by),
        }
    }

    fn widen(&mut self, other: PlanBounds) {
        for k in 0..2 {
            self.low[k] = self.low[k].min(other.low[k]);
            self.high[k] = self.high[k].max(other.high[k]);
        }
    }
}

struct CellGroup {
    bounds: PlanBounds,
    cells: Vec<((i64, i64), PlanBounds)>,
}

pub struct UnanchoredBoundary {
    pub origin: Vec3,
    pub distance: f64,
}

pub struct Slab {
    pub unanchored_boundary: Option<UnanchoredBoundary>,
    visits: RefCell<(u32, Vec<u32>)>,
    axis: usize,
    inward: f64,
    at: f64,
    range: (f64, f64),
    planes: (Exact, Exact),
    polygons: Vec<SlabPolygon>,
    clipped: Vec<OnceCell<Vec<Homogeneous>>>,
    cells: Cells<(i64, i64), Vec<u32>>,
    groups: OnceCell<Vec<((i64, i64), CellGroup)>>,
    oversized: Vec<u32>,
    extent: ([i64; 2], [i64; 2]),
}

impl Slab {
    fn groups(&self) -> &[((i64, i64), CellGroup)] {
        self.groups.get_or_init(|| {
            let mut groups: Cells<(i64, i64), CellGroup> = Cells::default();
            for (&(x, y), found) in &self.cells {
                let mut bounds = self.polygons[found[0] as usize].reach;
                for &index in found {
                    let polygon = &self.polygons[index as usize];
                    bounds.widen(if polygon.finite {
                        polygon.reach
                    } else {
                        PlanBounds::everywhere()
                    });
                }
                groups
                    .entry((group_of(x), group_of(y)))
                    .and_modify(|group| group.bounds.widen(bounds))
                    .or_insert_with(|| CellGroup {
                        bounds,
                        cells: Vec::new(),
                    })
                    .cells
                    .push(((x, y), bounds));
            }
            groups.into_iter().collect()
        })
    }
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
}

impl<'s> Surroundings<'s> {
    fn along(&self, step: [f64; 2], clearance: f64) -> Surroundings<'s> {
        let reach = clearance + IDENTIFY_LDU;
        Surroundings {
            polygons: self
                .polygons
                .iter()
                .filter(|patch| patch.within(step, reach))
                .cloned()
                .collect(),
            surfaces: self.surfaces.clone(),
            center: self.center,
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

fn reach_box(center: [f64; 2], reach: f64) -> PlanBox {
    [center.map(|c| c - reach), center.map(|c| c + reach)]
}

fn intersection(a: &PlanBox, b: &PlanBox) -> PlanBox {
    [
        [0, 1].map(|k| a[0][k].max(b[0][k])),
        [0, 1].map(|k| a[1][k].min(b[1][k])),
    ]
}

fn meets(low: [f64; 2], high: [f64; 2], query: &PlanBox) -> bool {
    (0..2).all(|k| query[0][k] <= high[k] && low[k] <= query[1][k])
}

struct Column {
    cells: Cells<(i64, i64), DepthBands>,
    oversized: DepthBands,
    has_oversized: bool,
}

struct Around<'a> {
    slab: &'a Slab,
    center: [f64; 2],
    exact_center: &'a Direction,
}

pub struct Solid {
    cell: CellSize,
    facets: Vec<Facet>,
    world: Vec<OnceCell<[ExactVec3; 3]>>,
    depths: [OnceCell<DepthBands>; 3],
    lines: RefCell<Cells<LineKey, Rc<DepthBands>>>,
    no_line: Rc<DepthBands>,
    bounds: (Vec3, Vec3),
    columns: [OnceCell<Column>; 3],
    occupied: [OnceCell<SquareSet>; 3],
    surfaces: Vec<RoundSurface>,
    axes: Cells<(usize, i64, i64), Vec<usize>>,
    walls: [Cells<(i64, i64), Vec<usize>>; 3],
    oversized_walls: [Vec<usize>; 3],
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

const PLAN_BUDGET: f64 = 65_536.0;

type SquareSet = HashSet<(i64, i64), BuildHasherDefault<CellHasher>>;

fn square(value: f64) -> i64 {
    (value / HALF_GRID_LDU).floor() as i64
}

fn squares_across(low: [f64; 2], high: [f64; 2]) -> f64 {
    (0..2)
        .map(|k| (high[k] / HALF_GRID_LDU).floor() - (low[k] / HALF_GRID_LDU).floor() + 1.0)
        .product()
}

fn beyond_budget(low: [f64; 2], high: [f64; 2]) -> bool {
    !matches!(
        squares_across(low, high).partial_cmp(&PLAN_BUDGET),
        Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
    )
}

#[derive(Clone, Copy)]
struct CellSize(f64);

impl CellSize {
    const CANONICAL: CellSize = CellSize(HALF_GRID_LDU);

    fn key(self, value: f64) -> i64 {
        (value / self.0).floor() as i64
    }

    fn window(self, center: [f64; 2], reach: f64) -> [[i64; 2]; 2] {
        center.map(|c| [self.key(c - reach), self.key(c + reach)])
    }
}

fn window_cells(window: [[i64; 2]; 2]) -> f64 {
    (0..2)
        .map(|k| (window[k][1] - window[k][0] + 1).max(0) as f64)
        .product()
}

fn sparser_than<V>(cells: &Cells<(i64, i64), V>, span: f64) -> bool {
    span > (cells.len() as f64).max(PLAN_BUDGET)
}

fn in_window<'a, V>(
    cells: &'a Cells<(i64, i64), V>,
    window: [[i64; 2]; 2],
    mut visit: impl FnMut(&'a V) -> bool,
) -> bool {
    if !sparser_than(cells, window_cells(window)) {
        for x in window[0][0]..=window[0][1] {
            for y in window[1][0]..=window[1][1] {
                if let Some(value) = cells.get(&(x, y)) {
                    if !visit(value) {
                        return false;
                    }
                }
            }
        }
        return true;
    }
    let inside = |key: &(i64, i64)| {
        (window[0][0]..=window[0][1]).contains(&key.0)
            && (window[1][0]..=window[1][1]).contains(&key.1)
    };
    let mut keys: Vec<(i64, i64)> = cells.keys().copied().filter(inside).collect();
    keys.sort_unstable();
    keys.into_iter().all(|key| visit(&cells[&key]))
}

const GROUP_CELLS: i64 = 8;

fn group_of(cell: i64) -> i64 {
    cell.div_euclid(GROUP_CELLS)
}

fn ring((x, y): (i64, i64), home: [i64; 2]) -> i64 {
    (x - home[0]).abs().max((y - home[1]).abs())
}

type Nearness = (i64, (i64, i64));

fn nearness(key: (i64, i64), home: [i64; 2]) -> Nearness {
    (ring(key, home), key)
}

fn box_span(center: &Direction, bounds: PlanBounds) -> Option<(f64, f64)> {
    let finite = bounds.low.iter().chain(&bounds.high).all(|v| v.is_finite());
    if !finite {
        return None;
    }
    let low = bounds.low.map(Exact::from_f64);
    let high = bounds.high.map(Exact::from_f64);
    let inside = (0..2).all(|k| {
        low[k].compare(&center[k]) != std::cmp::Ordering::Greater
            && high[k].compare(&center[k]) != std::cmp::Ordering::Less
    });
    if inside {
        return None;
    }
    let corner =
        |x: &Exact, y: &Exact| Bearing::Raw([x.sub(&center[0]), y.sub(&center[1])]).angle();
    let corners = [
        corner(&low[0], &low[1]),
        corner(&high[0], &low[1]),
        corner(&high[0], &high[1]),
        corner(&low[0], &high[1]),
    ];
    span_of(&corners).filter(|&(from, to)| (to - from).rem_euclid(TAU) < FRAC_PI_2)
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

fn lies_on(points: &[Homogeneous], axis: usize, plane: &Exact) -> bool {
    points
        .iter()
        .all(|p| p.point[axis].sub(&plane.mul(&p.weight)).is_zero())
}

fn magnitude(value: Exact) -> Exact {
    if value.sign() == std::cmp::Ordering::Less {
        value.neg()
    } else {
        value
    }
}

fn identification_inset() -> Exact {
    Decimal::parse(&IDENTIFY_LDU.to_string())
        .expect("the identification residual prints as a decimal")
        .exact()
}

fn ordered(a: Exact, b: Exact) -> (Exact, Exact) {
    if a.compare(&b) == std::cmp::Ordering::Greater {
        (b, a)
    } else {
        (a, b)
    }
}

fn clip_error(unclipped: &Ring, range: (f64, f64), margin: f64) -> f64 {
    let mut worst = 1.0_f64;
    for k in 0..unclipped.len() {
        let (p, q) = (unclipped[k], unclipped[(k + 1) % unclipped.len()]);
        let (low, high) = (p[2].min(q[2]), p[2].max(q[2]));
        for plane in [range.0, range.1] {
            if plane < low - margin || plane > high + margin {
                continue;
            }
            let rise = high - low - 2.0 * margin;
            if rise <= 0.0 {
                return f64::INFINITY;
            }
            let run = planar_length(q[0] - p[0], q[1] - p[1]) + 2.0 * SQRT_2 * margin;
            worst = worst.max(1.0 + 2.0 * run / rise);
        }
    }
    SQRT_2 * margin * worst
}

fn float_margin(points: &[Vec3; 3]) -> f64 {
    let magnitude = points.iter().flatten().fold(0.0_f64, |m, v| m.max(v.abs()));
    FLOAT_ERROR_LDU + magnitude * FLOAT_RELATIVE_ERROR
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
    planar_length(a[0] + t * du, a[1] + t * dv)
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
    planar_length(p[0] - a[0] - t * du, p[1] - a[1] - t * dv)
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
    polygon
        .iter()
        .map(|p| planar_length(p[0], p[1]))
        .fold(0.0, f64::max)
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
        let steep = planar_length(gradient[0], gradient[1]);
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

fn float_box_turns(center: [f64; 2], bounds: PlanBounds) -> Option<(f64, f64)> {
    let PlanBounds { low, high } = bounds.padded(IDENTIFICATION_REACH_LDU + CERTAIN_LDU);
    if !low.iter().chain(&high).all(|v| v.is_finite())
        || (0..2).all(|k| low[k] <= center[k] && center[k] <= high[k])
    {
        return None;
    }
    let corner = |x: f64, y: f64| crate::trig::atan2(y - center[1], x - center[0]);
    let corners = [
        corner(low[0], low[1]),
        corner(high[0], low[1]),
        corner(high[0], high[1]),
        corner(low[0], high[1]),
    ];
    let per_turn = f64::from(TURNS) / TAU;
    span_of(&corners)
        .filter(|&(from, to)| (to - from).rem_euclid(TAU) < FRAC_PI_2)
        .map(|(from, to)| (from * per_turn, to * per_turn))
}

fn inner_covers_turns(inner: &[(f64, f64)], (low, high): (f64, f64)) -> bool {
    let half = f64::from(TURNS / 2);
    let slack = ATAN2_SLACK * f64::from(TURNS) / TAU;
    let covers = |from: f64, to: f64| {
        let at = inner.partition_point(|&(_, end)| end < to);
        inner.get(at).is_some_and(|&(start, _)| start <= from)
    };
    let (from, to) = (low - slack, high + slack);
    if high < low {
        covers(from, half) && covers(-half, to)
    } else if from < -half {
        covers(-half, to) && covers(from + 2.0 * half, half)
    } else if to > half {
        covers(from, half) && covers(-half, to - 2.0 * half)
    } else {
        covers(from, to)
    }
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

fn merge_interval(covered: &mut Vec<(f64, f64)>, mut low: f64, mut high: f64) {
    let start = covered.partition_point(|&(_, end)| end < low);
    let mut end = start;
    while end < covered.len() && covered[end].0 <= high {
        low = low.min(covered[end].0);
        high = high.max(covered[end].1);
        end += 1;
    }
    covered.splice(start..end, [(low, high)]);
}

struct Coverage {
    covered: Vec<(f64, f64)>,
    within_turn: bool,
}

impl Coverage {
    fn new(arcs: &[ArcSpan]) -> Self {
        let mut coverage = Coverage {
            covered: Vec::new(),
            within_turn: true,
        };
        for arc in arcs {
            coverage.add(arc);
        }
        coverage
    }

    fn add(&mut self, arc: &ArcSpan) {
        use std::f64::consts::PI;
        let (low, high) = (arc.0.angle(), arc.1.angle());
        if (high < low) != arc_wraps(arc) {
            return;
        }
        if (high - low).rem_euclid(TAU) <= 2.0 * ATAN2_SLACK {
            return;
        }
        let wrapped = |angle: f64| {
            if angle > PI {
                angle - TAU
            } else if angle <= -PI {
                angle + TAU
            } else {
                angle
            }
        };
        let (low, high) = (wrapped(low + ATAN2_SLACK), wrapped(high - ATAN2_SLACK));
        if high >= low {
            self.merge(low, high);
        } else {
            self.merge(low, PI);
            self.merge(-PI, high);
        }
    }

    fn merge(&mut self, low: f64, high: f64) {
        merge_interval(&mut self.covered, low, high);
    }

    fn complete(&self) -> bool {
        use std::f64::consts::PI;
        self.within_turn
            && matches!(self.covered.as_slice(), [(low, high)] if *low <= -PI && *high >= PI)
    }

    fn covers_box(&self, center: &Direction, bounds: PlanBounds) -> bool {
        self.within_turn
            && box_span(center, bounds.padded(IDENTIFICATION_REACH_LDU))
                .is_some_and(|span| self.covers_span(span))
    }

    fn covers_span(&self, (low, high): (f64, f64)) -> bool {
        use std::f64::consts::PI;
        let covers = |from: f64, to: f64| {
            let at = self.covered.partition_point(|&(_, end)| end < to);
            self.covered
                .get(at)
                .is_some_and(|&(start, _)| start <= from)
        };
        let (from, to) = (low - ATAN2_SLACK, high + ATAN2_SLACK);
        if high < low {
            covers(from, PI) && covers(-PI, to)
        } else if from < -PI {
            covers(-PI, to) && covers(from + TAU, PI)
        } else if to > PI {
            covers(from, PI) && covers(-PI, to - TAU)
        } else {
            covers(from, to)
        }
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
    pub fn new(
        triangles: &[Triangle],
        pieces: &[u16],
        exact: &[Option<ExactTriangle>],
        surfaces: Vec<RoundSurface>,
    ) -> Self {
        Self::indexed(triangles, pieces, exact, surfaces, CellSize::CANONICAL)
    }

    #[cfg(test)]
    pub(super) fn unpieced(triangles: &[Triangle], surfaces: Vec<RoundSurface>) -> Self {
        Self::with_cell_size(triangles, surfaces, CellSize::CANONICAL.0)
    }

    #[cfg(test)]
    pub(super) fn with_cell_size(
        triangles: &[Triangle],
        surfaces: Vec<RoundSurface>,
        size: f64,
    ) -> Self {
        let pieces = vec![crate::pieces::NO_PIECE; triangles.len()];
        Self::indexed(triangles, &pieces, &[], surfaces, CellSize(size))
    }

    fn indexed(
        triangles: &[Triangle],
        pieces: &[u16],
        exact: &[Option<ExactTriangle>],
        surfaces: Vec<RoundSurface>,
        cell: CellSize,
    ) -> Self {
        let mut facets = Vec::with_capacity(triangles.len());
        for (source, (triangle, &piece)) in triangles.iter().zip(pieces).enumerate() {
            let [a, b, c] = triangle.points;
            let normal = cross(sub(b, a), sub(c, a));
            if normal == [0.0; 3] {
                continue;
            }
            let low = [0, 1, 2].map(|k| a[k].min(b[k]).min(c[k]));
            let high = [0, 1, 2].map(|k| a[k].max(b[k]).max(c[k]));
            facets.push(Facet {
                points: triangle.points,
                exact: exact.get(source).cloned().flatten(),
                front: (!triangle.double_sided).then_some(normal),
                low,
                high,
                owner: None,
                piece,
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
            cell,
            world: facets.iter().map(|_| OnceCell::new()).collect(),
            facets,
            depths: Default::default(),
            lines: RefCell::default(),
            no_line: Rc::new(DepthBands::new(Vec::new(), |_| 0.0, |_| 0.0)),
            bounds,
            columns: Default::default(),
            occupied: Default::default(),
            surfaces: Vec::new(),
            axes: Cells::default(),
            walls: Default::default(),
            oversized_walls: Default::default(),
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
                let low = surface.center.map(|c| c - radius);
                let high = surface.center.map(|c| c + radius);
                if surface.full && beyond_budget(low, high) {
                    solid.oversized_walls[surface.axis].push(index);
                } else if surface.full {
                    let window = cell.window(surface.center, radius);
                    for x in window[0][0]..=window[0][1] {
                        for y in window[1][0]..=window[1][1] {
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

    fn plan_box(&self, facet: &Facet, axis: usize) -> ([f64; 2], [f64; 2]) {
        let (i, j) = plan_axes(axis);
        ([facet.low[i], facet.low[j]], [facet.high[i], facet.high[j]])
    }

    fn oversized_on(&self, facet: &Facet, axis: usize) -> bool {
        let (low, high) = self.plan_box(facet, axis);
        beyond_budget(low, high)
    }

    pub fn largest_oversized(&self) -> Option<(Vec3, f64)> {
        let facets = self.facets.iter().filter_map(|facet| {
            let squares = (0..3)
                .map(|axis| {
                    let (low, high) = self.plan_box(facet, axis);
                    squares_across(low, high)
                })
                .fold(0.0, f64::max);
            (0..3).any(|axis| self.oversized_on(facet, axis)).then(|| {
                let centroid =
                    [0, 1, 2].map(|k| facet.points.iter().map(|p| p[k]).sum::<f64>() / 3.0);
                (centroid, squares)
            })
        });
        let walls = self.oversized_walls.iter().flatten().filter_map(|&index| {
            let surface = &self.surfaces[index];
            let RoundShape::Wall { radius, from, .. } = surface.shape else {
                return None;
            };
            let low = surface.center.map(|c| c - radius);
            let high = surface.center.map(|c| c + radius);
            let origin = axis_probe(surface.axis, surface.center, from, 1.0).entrance;
            Some((origin, squares_across(low, high)))
        });
        facets
            .chain(walls)
            .fold(None, |largest: Option<(Vec3, f64)>, found| match largest {
                Some(kept) if kept.1 >= found.1 => Some(kept),
                _ => Some(found),
            })
    }

    fn column(&self, axis: usize) -> &Column {
        self.columns[axis].get_or_init(|| {
            let (i, j) = plan_axes(axis);
            let mut cells: Cells<(i64, i64), Vec<u32>> = Cells::default();
            let mut oversized = Vec::new();
            for (index, facet) in self.facets.iter().enumerate() {
                if self.oversized_on(facet, axis) {
                    oversized.push(index as u32);
                    continue;
                }
                for x in self.cell.key(facet.low[i])..=self.cell.key(facet.high[i]) {
                    for y in self.cell.key(facet.low[j])..=self.cell.key(facet.high[j]) {
                        cells.entry((x, y)).or_default().push(index as u32);
                    }
                }
            }
            Column {
                cells: cells
                    .into_iter()
                    .map(|(key, facets)| (key, self.bands(axis, facets)))
                    .collect(),
                has_oversized: !oversized.is_empty(),
                oversized: self.bands(axis, oversized),
            }
        })
    }

    fn occupied(&self, axis: usize) -> &SquareSet {
        self.occupied[axis].get_or_init(|| {
            let mut occupied = SquareSet::default();
            let mut cover = |low: [f64; 2], high: [f64; 2]| {
                for x in square(low[0])..=square(high[0]) {
                    for y in square(low[1])..=square(high[1]) {
                        occupied.insert((x, y));
                    }
                }
            };
            for facet in &self.facets {
                if !self.oversized_on(facet, axis) {
                    let (low, high) = self.plan_box(facet, axis);
                    cover(low, high);
                }
            }
            let oversized_walls = &self.oversized_walls[axis];
            for (index, surface) in self.surfaces.iter().enumerate() {
                if surface.axis != axis || oversized_walls.contains(&index) {
                    continue;
                }
                cover(surface.center, surface.center);
                if let (true, RoundShape::Wall { radius, .. }) = (surface.full, surface.shape) {
                    cover(
                        surface.center.map(|c| c - radius),
                        surface.center.map(|c| c + radius),
                    );
                }
            }
            occupied
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
        let low_of = |index: u32| self.facets[index as usize].low[axis];
        bands.starting_before((from, to), low_of, &mut |index| {
            let facet = &self.facets[index as usize];
            let (low, high) = self.plan_box(facet, axis);
            !(facet.high[axis] >= from && plan.is_none_or(|plan| meets(low, high, plan)))
                || found(index)
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
        let (from, to) = Self::world_window(probe, depths);
        let column = self.column(probe.axis);
        let center = probe.center();
        let within = reach_box(center, reach);
        let query = plan.map_or(within, |plan| intersection(plan, &within));
        let window = self.cell.window(center, reach);
        let indexed = in_window(&column.cells, window, |bands| {
            self.meeting(bands, probe.axis, (from, to), Some(&query), &mut found)
        });
        indexed
            && self.meeting(
                &column.oversized,
                probe.axis,
                (from, to),
                Some(&query),
                &mut found,
            )
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
        planar_length(gap(i), gap(j))
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
                    planar_length(s.center[0] - center[0], s.center[1] - center[1]) <= IDENTIFY_LDU
                }));
            }
        }
        out
    }

    fn exact(&self, probe: &Probe, reach: f64) -> Vec<usize> {
        let center = probe.center();
        let mut out = self.coaxial(probe);
        let query = reach_box(center, reach);
        let near = |&index: &usize| {
            let surface = &self.surfaces[index];
            let radius = surface.reach();
            meets(
                surface.center.map(|c| c - radius),
                surface.center.map(|c| c + radius),
                &query,
            )
        };
        let window = self.cell.window(center, reach);
        in_window(&self.walls[probe.axis], window, |found| {
            out.extend(found.iter().copied().filter(near));
            true
        });
        out.extend(
            self.oversized_walls[probe.axis]
                .iter()
                .copied()
                .filter(near),
        );
        out.sort_unstable();
        out.dedup();
        out
    }

    fn owned_by(&self, facet: usize, surfaces: &[usize]) -> bool {
        self.facets[facet]
            .owner
            .is_some_and(|owner| surfaces.contains(&owner))
    }

    pub fn contributors(&self, probe: &Probe, range: (f64, f64), floor: Option<f64>) -> Vec<u16> {
        let reach = probe.radius + IDENTIFY_LDU;
        let coaxial = self.exact(probe, reach);
        let mut pieces: Vec<u16> = Vec::new();
        let walls = (-IDENTIFY_LDU, range.1);
        for index in self.near(probe, reach, ANY_DEPTH) {
            if self.owned_by(index as usize, &coaxial) {
                continue;
            }
            let facet = &self.facets[index as usize];
            let (low, high) = self.depth_range(probe, facet);
            if high < walls.0 || low > walls.1 {
                continue;
            }
            let clipped = slab_clip(self.polygon(probe, facet), walls.0, walls.1);
            if !clipped.is_empty() && nearest_radius(&clipped) <= reach {
                pieces.push(facet.piece);
            }
        }
        for &index in &coaxial {
            let surface = &self.surfaces[index];
            let (low, high) = surface.depths(probe);
            if high >= walls.0 && low <= walls.1 && surface.nearest_from(probe.center()) <= reach {
                pieces.push(surface.piece);
            }
        }
        if let Some(depth) = floor {
            pieces.extend(self.floor_pieces(probe, probe.radius, depth));
        }
        pieces.sort_unstable();
        pieces.dedup();
        pieces
    }

    fn floor_pieces(&self, probe: &Probe, contact: f64, depth: f64) -> Vec<u16> {
        let inside = contact - IDENTIFICATION_REACH_LDU;
        let coaxial = self.exact(probe, inside + IDENTIFY_LDU);
        let mut pieces = Vec::new();
        let mut rim_only = Vec::new();
        for index in self.near(probe, inside + IDENTIFY_LDU, ANY_DEPTH) {
            if self.owned_by(index as usize, &coaxial) {
                continue;
            }
            let facet = &self.facets[index as usize];
            if self.depth_range(probe, facet).1 < -IDENTIFY_LDU {
                continue;
            }
            let polygon = clip(self.polygon(probe, facet), -IDENTIFY_LDU, true);
            let Some(inner) = first_depth(&polygon, inside) else {
                continue;
            };
            if inner <= depth + IDENTIFY_LDU {
                pieces.push(facet.piece);
            } else if first_depth(&polygon, contact).is_some_and(|rim| rim <= depth + IDENTIFY_LDU)
            {
                rim_only.push(facet.piece);
            }
        }
        for &index in &coaxial {
            let surface = &self.surfaces[index];
            let (low, high) = surface.depths(probe);
            if surface.nearest_from(probe.center()) < inside
                && high >= -IDENTIFY_LDU
                && low.max(-IDENTIFY_LDU) <= depth + IDENTIFY_LDU
            {
                pieces.push(surface.piece);
            }
        }
        if pieces.is_empty() {
            rim_only
        } else {
            pieces
        }
    }

    pub fn floor(&self, probe: &Probe, contact: f64) -> Floor {
        self.floor_until(probe, contact, f64::NEG_INFINITY)
    }

    pub fn floor_beyond(&self, probe: &Probe, contact: f64, limit: f64) -> Option<Floor> {
        Some(self.floor_until(probe, contact, limit)).filter(|floor| floor.depth >= limit)
    }

    fn floor_until(&self, probe: &Probe, contact: f64, limit: f64) -> Floor {
        let inside = contact - IDENTIFICATION_REACH_LDU;
        let coaxial = self.exact(probe, inside + IDENTIFY_LDU);
        let mut attaining: Vec<Attainer> = Vec::new();
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
            attaining.push(Attainer {
                inner: d,
                rim: d,
                along,
            });
        }
        let analytic = attaining
            .iter()
            .map(|a| a.inner)
            .fold(f64::INFINITY, f64::min);
        let window = (inside + IDENTIFY_LDU, inside);
        let line = self.line(probe, LineUse::Floor, window, |index, facet| {
            !self.apart(probe, facet, inside) && !self.owned_by(index, &coaxial)
        });
        let band = self.sweep(probe, &line, (analytic, limit), |facet| {
            let polygon = clip(self.polygon(probe, facet), -IDENTIFY_LDU, true);
            if polygon.is_empty() {
                return None;
            }
            let inner = first_depth(&polygon, inside)?;
            let rim = first_depth(&polygon, contact).unwrap_or(inner);
            attaining.push(Attainer {
                inner,
                rim,
                along: facet.front.map(|front| front[probe.axis] * probe.inward),
            });
            Some(inner)
        });
        let depth = attaining.iter().map(|a| a.rim).fold(band, f64::min);
        let interior = band <= depth + IDENTIFY_LDU;
        let mut faces_probe = None;
        for attainer in attaining {
            let (reading, floor) = if interior {
                (attainer.inner, band)
            } else {
                (attainer.rim, depth)
            };
            if reading > floor + IDENTIFY_LDU {
                continue;
            }
            match attainer.along {
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
            clipped.is_empty()
                || nearest_radius(&clipped) > reach
                || clipped.iter().all(|p| planar_length(p[0], p[1]) <= beyond)
        })
    }

    pub fn profile_floor(&self, probe: &Probe, pieces: &[Vec<Point>], reach: f64) -> Floor {
        let mut attaining: Vec<(f64, Option<f64>)> = Vec::new();
        let extent = pieces
            .iter()
            .flatten()
            .map(|p| planar_length(p[0], p[1]))
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
        ends: Option<(Exact, Exact)>,
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
            let margin = float_margin(&facet.points);
            let (low, high) = self.depth_range(&probe, facet);
            if high < range.0 - margin
                || low > range.1 + margin
                || facet.owner.is_some_and(|o| ignores(&self.surfaces[o]))
            {
                continue;
            }
            let unclipped = self.polygon(&probe, facet);
            let widened = (range.0 - margin, range.1 + margin);
            let reached = slab_clip(unclipped, widened.0, widened.1);
            let plan_bounds = |ring: &Ring| {
                let mut bounds = PlanBounds::empty();
                for p in ring.iter() {
                    bounds.widen(PlanBounds {
                        low: [p[0] + at, p[1] + at],
                        high: [p[0] + at, p[1] + at],
                    });
                }
                bounds
            };
            let outline = plan_bounds(&unclipped).padded(margin);
            let error = clip_error(&unclipped, widened, margin);
            let reach = if reached.is_empty() || !error.is_finite() {
                outline
            } else {
                plan_bounds(&reached).padded(error).within(outline)
            };
            polygons.push(SlabPolygon {
                facet: index,
                finite: unclipped
                    .iter()
                    .all(|p| p[0].is_finite() && p[1].is_finite()),
                reach,
                float_clip: OnceCell::new(),
            });
        }
        let mut cells: Cells<(i64, i64), Vec<u32>> = Cells::default();
        let mut oversized_polygons = Vec::new();
        let mut extent = ([i64::MAX; 2], [i64::MIN; 2]);
        for (index, polygon) in polygons.iter().enumerate() {
            let PlanBounds { low, high } = polygon.reach;
            if beyond_budget(low, high) {
                oversized_polygons.push(index as u32);
                continue;
            }
            let low = low.map(|v| self.cell.key(v));
            let high = high.map(|v| self.cell.key(v));
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
        let anchored = ends.is_some();
        let planes = match ends {
            Some((near, far)) => {
                let inset = identification_inset();
                let (into, back) = if inward > 0.0 {
                    (near.add(&inset), far.sub(&inset))
                } else {
                    (near.sub(&inset), far.add(&inset))
                };
                ordered(into, back)
            }
            None => {
                let along = |depth: f64| Exact::from_f64(at).add(&Exact::from_f64(inward * depth));
                ordered(along(range.0), along(range.1))
            }
        };
        let unanchored_boundary = if anchored {
            None
        } else {
            self.unanchored_boundary(&probe, range, axis, &planes, &polygons)
        };
        Slab {
            visits: RefCell::new((0, vec![0; polygons.len()])),
            unanchored_boundary,
            axis,
            inward,
            at,
            range,
            planes,
            clipped: polygons.iter().map(|_| OnceCell::new()).collect(),
            polygons,
            cells,
            groups: OnceCell::new(),
            oversized: oversized_polygons,
            extent,
        }
    }

    fn unanchored_boundary(
        &self,
        probe: &Probe,
        range: (f64, f64),
        axis: usize,
        planes: &(Exact, Exact),
        polygons: &[SlabPolygon],
    ) -> Option<UnanchoredBoundary> {
        let guard = Exact::from_f64(IDENTIFY_REPRESENTATION_GUARD_LDU);
        let mut nearest: Option<UnanchoredBoundary> = None;
        for polygon in polygons {
            let facet = &self.facets[polygon.facet];
            let margin = float_margin(&facet.points) + IDENTIFY_REPRESENTATION_GUARD_LDU;
            let (low, high) = self.depth_range(probe, facet);
            let touches = |end: f64| low <= end + margin && high >= end - margin;
            if !touches(range.0) && !touches(range.1) {
                continue;
            }
            let clipped = clip_between(
                self.world_points(polygon.facet)
                    .iter()
                    .cloned()
                    .map(Homogeneous::of)
                    .collect(),
                axis,
                &planes.0,
                &planes.1,
            );
            for plane in [&planes.0, &planes.1] {
                let offsets: Vec<Exact> = clipped
                    .iter()
                    .map(|p| p.point[axis].sub(&plane.mul(&p.weight)))
                    .collect();
                let within = clipped.iter().zip(&offsets).all(|(p, offset)| {
                    magnitude(offset.clone()).compare(&magnitude(guard.mul(&p.weight)))
                        != std::cmp::Ordering::Greater
                });
                if clipped.is_empty() || !within || offsets.iter().all(Exact::is_zero) {
                    continue;
                }
                let residuals = clipped
                    .iter()
                    .zip(&offsets)
                    .map(|(p, offset)| (offset.to_f64() / p.weight.to_f64()).abs());
                let Some((farthest, distance)) = residuals.enumerate().fold(
                    None,
                    |best: Option<(usize, f64)>, (k, d)| match best {
                        Some((_, b)) if b >= d => best,
                        _ => Some((k, d)),
                    },
                ) else {
                    continue;
                };
                if nearest.as_ref().is_none_or(|n| distance < n.distance) {
                    let vertex = &clipped[farthest];
                    let weight = vertex.weight.to_f64();
                    nearest = Some(UnanchoredBoundary {
                        origin: vertex.point.clone().map(|c| c.to_f64() / weight),
                        distance,
                    });
                }
            }
        }
        nearest
    }

    fn shared_coordinate(&self, axis: usize, facets: &[usize]) -> Option<Exact> {
        let mut shared: Option<Exact> = None;
        for &facet in facets {
            self.facets[facet].exact.as_ref()?;
            for point in self.world_points(facet) {
                match &shared {
                    Some(value) if value.compare(&point[axis]) != std::cmp::Ordering::Equal => {
                        return None;
                    }
                    Some(_) => {}
                    None => shared = Some(point[axis].clone()),
                }
            }
        }
        shared
    }

    fn world_points(&self, facet: usize) -> &[ExactVec3; 3] {
        self.world[facet].get_or_init(|| match &self.facets[facet].exact {
            Some(exact) => exact.points(),
            None => self.facets[facet].points.map(|p| p.map(Exact::from_f64)),
        })
    }

    fn exact_polygon(
        &self,
        slab: &Slab,
        index: usize,
        center: &Direction,
    ) -> Option<Vec<Direction>> {
        let facet = slab.polygons[index].facet;
        let clipped = slab.clipped[index].get_or_init(|| {
            let clipped = clip_between(
                self.world_points(facet)
                    .iter()
                    .cloned()
                    .map(Homogeneous::of)
                    .collect(),
                slab.axis,
                &slab.planes.0,
                &slab.planes.1,
            );
            let identified = |plane: &Exact| lies_on(&clipped, slab.axis, plane);
            if identified(&slab.planes.0) || identified(&slab.planes.1) {
                Vec::new()
            } else {
                clipped
            }
        });
        let axes = plan_axes(slab.axis);
        (!clipped.is_empty()).then(|| clipped.iter().map(|p| p.relative(axes, center)).collect())
    }

    fn polygon_arc(
        &self,
        slab: &Slab,
        index: usize,
        directions: Vec<Direction>,
    ) -> Option<ArcSpan> {
        let weights = slab.clipped[index].get()?;
        span(
            directions
                .into_iter()
                .zip(weights)
                .map(|(direction, point)| Bearing::identify(direction, point.weight.to_f64()))
                .collect(),
        )
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
            if gap > best.min(reach) + IDENTIFY_LDU {
                break;
            }
            if let Some(radius) = self.slab_radius(probe, &self.facets[index as usize], range) {
                best = best.min(radius);
            }
        }
        if best <= reach {
            best
        } else {
            f64::INFINITY
        }
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
        let high = planar_length(offset[0], offset[1])
            .max(planar_length(offset[0] - to[0], offset[1] - to[1]));
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
    ) -> Surroundings<'_> {
        let longest = steps
            .iter()
            .map(|s| planar_length(s[0], s[1]))
            .fold(0.0, f64::max);
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
        }
    }

    fn sweep_collides(&self, around: &Surroundings, to: [f64; 2], clearance: f64) -> bool {
        around
            .polygons
            .iter()
            .any(|patch| patch.within(to, clearance))
            || around
                .surfaces
                .iter()
                .any(|surface| self.swept_reach(surface, around.center, to) < clearance)
    }

    pub fn confined_travel(
        &self,
        probe: &Probe,
        range: (f64, f64),
        steps: &[[f64; 2]],
    ) -> Option<Vec<f64>> {
        let surroundings = self.surroundings(probe, range, steps);
        let confining = probe.radius - IDENTIFY_LDU;
        if !steps
            .iter()
            .all(|&to| self.sweep_collides(&surroundings, to, confining))
        {
            return None;
        }
        let clearance = probe.radius;
        let travel = steps
            .iter()
            .map(|&step| {
                let around = surroundings.along(step, clearance);
                let length = planar_length(step[0], step[1]);
                let contact = IDENTIFY_LDU / length;
                let (mut free, mut blocked) = if self.sweep_collides(
                    &around,
                    [step[0] * contact, step[1] * contact],
                    clearance,
                ) {
                    (0.0, contact)
                } else if self.sweep_collides(&around, step, clearance) {
                    (contact, 1.0)
                } else {
                    return f64::INFINITY;
                };
                while (blocked - free) * length > TRAVEL_PRECISION_LDU {
                    let middle = 0.5 * (free + blocked);
                    if self.sweep_collides(&around, [step[0] * middle, step[1] * middle], clearance)
                    {
                        blocked = middle;
                    } else {
                        free = middle;
                    }
                }
                free * length
            })
            .collect();
        Some(travel)
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
    ) -> Option<Vec<ArcSpan>> {
        let mut arcs = Vec::new();
        for &index in coaxial {
            let surface = &self.surfaces[index];
            if ignores(surface) || !Self::in_slab(slab, surface, probe) {
                continue;
            }
            if surface.full || surface.nearest() == 0.0 {
                return None;
            }
            arcs.extend(surface.arcs.iter().flatten().cloned());
        }
        Some(arcs)
    }

    pub fn blocked_on_axes(
        &self,
        slab: &Slab,
        center: [f64; 2],
        exact_center: &Direction,
        ignores: impl Fn(&RoundSurface) -> bool,
    ) -> bool {
        let probe = axis_probe(slab.axis, center, slab.at, slab.inward);
        let coaxial = self.coaxial(&probe);
        let Some(arcs) = self.coaxial_arcs(slab, &probe, &coaxial, &ignores) else {
            return true;
        };
        let around = Around {
            slab,
            center,
            exact_center,
        };
        self.rays_blocked(&around, &coaxial, &arcs, &ignores)
    }

    fn rays_blocked(
        &self,
        around: &Around,
        coaxial: &[usize],
        arcs: &[ArcSpan],
        ignores: &impl Fn(&RoundSurface) -> bool,
    ) -> bool {
        let Around { slab, center, .. } = *around;
        if slab.polygons.is_empty() {
            return false;
        }
        let home = [self.cell.key(center[0]), self.cell.key(center[1])];
        let blocks = |polygon: &SlabPolygon| {
            !self.facets[polygon.facet]
                .owner
                .is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o]))
        };
        [(0, 1), (0, -1), (1, 1), (1, -1)]
            .into_iter()
            .all(|(along, sign)| {
                let mut direction = [Exact::integer(0), Exact::integer(0)];
                direction[along] = Exact::integer(sign);
                arcs.iter()
                    .any(|arc| arc_contains(arc, &Bearing::Raw(direction.clone())))
                    || self.ray_hits(around, home, along, sign, &blocks)
            })
    }

    pub fn enclosed(
        &self,
        slab: &Slab,
        center: [f64; 2],
        exact_center: &Direction,
        ignores: impl Fn(&RoundSurface) -> bool,
    ) -> bool {
        let probe = axis_probe(slab.axis, center, slab.at, slab.inward);
        let coaxial = self.coaxial(&probe);
        let Some(mut arcs) = self.coaxial_arcs(slab, &probe, &coaxial, &ignores) else {
            return true;
        };
        if slab.polygons.is_empty() {
            return covers_exactly(&arcs);
        }
        let around = Around {
            slab,
            center,
            exact_center,
        };
        if !self.rays_blocked(&around, &coaxial, &arcs, &ignores) {
            return false;
        }
        if let Some(decided) = self.approximately_enclosed(&around, &coaxial, &arcs, &ignores) {
            return decided;
        }
        let mut coverage = Coverage::new(&arcs);
        if coverage.complete() && covers_exactly(&arcs) {
            return true;
        }
        for &index in &slab.oversized {
            if self.encloses(
                &around,
                index as usize,
                (&coaxial, &ignores),
                (&mut arcs, &mut coverage),
            ) {
                return true;
            }
        }
        let home = [self.cell.key(center[0]), self.cell.key(center[1])];
        let home_group = home.map(group_of);
        let mut groups: Vec<(Nearness, &CellGroup)> = slab
            .groups()
            .iter()
            .map(|(key, group)| (nearness(*key, home_group), group))
            .collect();
        groups.sort_unstable_by_key(|(order, _)| *order);
        let mut seen = vec![false; slab.polygons.len()];
        let mut cells: Vec<(Nearness, PlanBounds)> = Vec::new();
        let (mut checked, mut next_check) = (0, 1);
        for (visited, (_, group)) in groups.into_iter().enumerate() {
            if !coverage.covers_box(exact_center, group.bounds) {
                cells.clear();
                cells.extend(
                    group
                        .cells
                        .iter()
                        .map(|&(key, bounds)| (nearness(key, home), bounds)),
                );
                cells.sort_unstable_by_key(|(order, _)| *order);
                for &((_, key), bounds) in &cells {
                    if coverage.covers_box(exact_center, bounds) {
                        continue;
                    }
                    for &index in &slab.cells[&key] {
                        let index = index as usize;
                        if !std::mem::replace(&mut seen[index], true)
                            && self.encloses(
                                &around,
                                index,
                                (&coaxial, &ignores),
                                (&mut arcs, &mut coverage),
                            )
                        {
                            return true;
                        }
                    }
                }
            }
            if visited + 1 == next_check {
                if arcs.len() > checked && covers_exactly(&arcs) {
                    return true;
                }
                checked = arcs.len();
                next_check *= 2;
            }
        }
        covers_exactly(&arcs)
    }

    fn approximately_enclosed(
        &self,
        around: &Around,
        coaxial: &[usize],
        arcs: &[ArcSpan],
        ignores: &impl Fn(&RoundSurface) -> bool,
    ) -> Option<bool> {
        let slab = around.slab;
        let probe = axis_probe(slab.axis, around.center, slab.at, slab.inward);
        let mut known: Vec<Bearing> = Vec::new();
        let mut junctions: Vec<(Junction<ArcEnd>, Junction<ArcEnd>)> = Vec::new();
        let mut inner: Vec<(f64, f64)> = Vec::new();
        let record =
            |span: ApproximateSpan,
             keys: (ArcEnd, ArcEnd),
             inner: &mut Vec<(f64, f64)>,
             junctions: &mut Vec<(Junction<ArcEnd>, Junction<ArcEnd>)>| {
                if let Some(pieces) = inner_turns(&span) {
                    for (from, to) in pieces {
                        merge_interval(inner, from, to);
                    }
                }
                junctions.push((
                    Junction {
                        approximate: span.0,
                        key: keys.0,
                    },
                    Junction {
                        approximate: span.1,
                        key: keys.1,
                    },
                ));
                inner_complete(inner)
            };
        let exactly = |known: &mut Vec<Bearing>, (low, high): ArcSpan| {
            let keys = (ArcEnd::Known(known.len()), ArcEnd::Known(known.len() + 1));
            let span = (low.approximate(0.0), high.approximate(0.0));
            known.push(low);
            known.push(high);
            (span, keys)
        };
        for arc in arcs {
            let (span, keys) = exactly(&mut known, arc.clone());
            if record(span, keys, &mut inner, &mut junctions) {
                return Some(true);
            }
        }
        let mut visits = slab.visits.borrow_mut();
        let (generation, marks) = &mut *visits;
        if *generation == u32::MAX {
            marks.fill(0);
            *generation = 0;
        }
        *generation += 1;
        let visit = *generation;
        let mut uncertified: Vec<usize> = Vec::new();
        let mut cell_skipped: Option<((i64, i64), bool)> = None;
        for (index, cell) in self.nearest_first(slab, around.center) {
            if let Some((key, bounds)) = cell {
                let skipped = match cell_skipped {
                    Some((last, skipped)) if last == key => skipped,
                    _ => {
                        let skipped = float_box_turns(around.center, bounds)
                            .is_some_and(|span| inner_covers_turns(&inner, span));
                        cell_skipped = Some((key, skipped));
                        skipped
                    }
                };
                if skipped {
                    continue;
                }
            }
            if std::mem::replace(&mut marks[index], visit) == visit {
                continue;
            }
            let polygon = &slab.polygons[index];
            let facet = &self.facets[polygon.facet];
            if facet
                .owner
                .is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o]))
            {
                continue;
            }
            let margin = float_margin(&facet.points) + CERTAIN_LDU;
            let (low, high) = self.depth_range(&probe, facet);
            if high < slab.range.0 - margin || low > slab.range.1 + margin {
                continue;
            }
            let certified = if high - slab.range.0 <= margin || slab.range.1 - low <= margin {
                None
            } else {
                self.float_clip(slab, polygon).as_ref().and_then(|clip| {
                    let uncertainty = clip.error + CERTAIN_LDU;
                    let mut shifted = Ring::empty();
                    for p in clip.points.iter() {
                        shifted.push([p[0] - around.center[0], p[1] - around.center[1], 0.0]);
                    }
                    let edge = (0..shifted.len())
                        .map(|k| segment_radius(shifted[k], shifted[(k + 1) % shifted.len()]))
                        .fold(f64::INFINITY, f64::min);
                    if edge.partial_cmp(&uncertainty) != Some(std::cmp::Ordering::Greater) {
                        return None;
                    }
                    if contains(&shifted, [0.0, 0.0]) {
                        return Some(Err(()));
                    }
                    let ends: Option<Vec<Approximate>> = shifted
                        .iter()
                        .map(|p| Approximate::of(p[0], p[1], uncertainty))
                        .collect();
                    approximate_span(ends?).map(Ok)
                })
            };
            match certified {
                Some(Err(())) => return Some(true),
                Some(Ok(span)) => {
                    let keys = (ArcEnd::Polygon(index, false), ArcEnd::Polygon(index, true));
                    if record(span, keys, &mut inner, &mut junctions) {
                        return Some(true);
                    }
                }
                None => uncertified.push(index),
            }
        }
        for index in uncertified {
            let Some(directions) = self.exact_polygon(slab, index, around.exact_center) else {
                continue;
            };
            if touches_origin(&directions) {
                return Some(true);
            }
            let Some(arc) = self.polygon_arc(slab, index, directions) else {
                continue;
            };
            let (span, keys) = exactly(&mut known, arc);
            if record(span, keys, &mut inner, &mut junctions) {
                return Some(true);
            }
        }
        if certainly_uncovered(&junctions) {
            return Some(false);
        }
        let mut polygon_arcs: HashMap<usize, Option<ArcSpan>> = HashMap::new();
        covers_circle_filtered(&junctions, &mut |key| match key {
            ArcEnd::Known(at) => known.get(at).cloned(),
            ArcEnd::Polygon(index, high) => {
                let arc = polygon_arcs
                    .entry(index)
                    .or_insert_with(|| {
                        let directions = self.exact_polygon(slab, index, around.exact_center)?;
                        self.polygon_arc(slab, index, directions)
                    })
                    .clone()?;
                Some(if high { arc.1 } else { arc.0 })
            }
        })
    }

    fn ray_decided(
        &self,
        slab: &Slab,
        polygon: &SlabPolygon,
        center: [f64; 2],
        along: usize,
        sign: i64,
    ) -> Option<bool> {
        let clip = self.float_clip(slab, polygon).as_ref()?;
        let uncertainty = clip.error + CERTAIN_LDU;
        let across = 1 - along;
        let forward = sign as f64;
        let mut shifted = Ring::empty();
        for p in clip.points.iter() {
            shifted.push([p[0] - center[0], p[1] - center[1], 0.0]);
        }
        if !uncertainty.is_finite()
            || shifted
                .iter()
                .any(|p| !p[0].is_finite() || !p[1].is_finite())
        {
            return None;
        }
        let all = |test: &dyn Fn(&Local) -> bool| shifted.iter().all(test);
        if all(&|p| p[across] > uncertainty)
            || all(&|p| p[across] < -uncertainty)
            || all(&|p| p[along] * forward < -uncertainty)
        {
            return Some(false);
        }
        let mut uncertain = false;
        for k in 0..shifted.len() {
            let (a, b) = (shifted[k], shifted[(k + 1) % shifted.len()]);
            let (from, to) = (a[across], b[across]);
            if (from > uncertainty && to > uncertainty)
                || (from < -uncertainty && to < -uncertainty)
            {
                continue;
            }
            let rise = (to - from).abs();
            if from.abs() <= uncertainty || to.abs() <= uncertainty || rise <= 4.0 * uncertainty {
                uncertain = true;
                continue;
            }
            let run = b[along] - a[along];
            let crossing = (a[along] + run * (-from) / (to - from)) * forward;
            let error = 2.0 * uncertainty * (2.0 + run.abs() / (rise - 2.0 * uncertainty));
            if crossing > error {
                return Some(true);
            }
            if crossing >= -error {
                uncertain = true;
            }
        }
        (!uncertain).then_some(false)
    }

    fn float_clip<'p>(&self, slab: &Slab, polygon: &'p SlabPolygon) -> &'p Option<FloatClip> {
        polygon.float_clip.get_or_init(|| {
            let facet = &self.facets[polygon.facet];
            let margin = float_margin(&facet.points);
            let probe = axis_probe(slab.axis, [slab.at, slab.at], slab.at, slab.inward);
            let unclipped = self.polygon(&probe, facet);
            let clipped = slab_clip(unclipped, slab.range.0, slab.range.1);
            (!clipped.is_empty()).then(|| {
                let mut points = Ring::empty();
                for p in clipped.iter() {
                    points.push([p[0] + slab.at, p[1] + slab.at, 0.0]);
                }
                FloatClip {
                    points,
                    error: clip_error(&unclipped, slab.range, margin),
                }
            })
        })
    }

    fn nearest_first<'s>(
        &self,
        slab: &'s Slab,
        center: [f64; 2],
    ) -> impl Iterator<Item = (usize, Option<ListedCell>)> + 's {
        let home = [self.cell.key(center[0]), self.cell.key(center[1])];
        let home_group = home.map(group_of);
        let mut groups: Vec<(Nearness, &CellGroup)> = slab
            .groups()
            .iter()
            .map(|(key, group)| (nearness(*key, home_group), group))
            .collect();
        groups.sort_unstable_by_key(|(order, _)| *order);
        let oversized = slab.oversized.iter().map(|&index| (index as usize, None));
        let listed = groups.into_iter().flat_map(move |(_, group)| {
            let mut cells: Vec<(Nearness, (i64, i64), PlanBounds)> = group
                .cells
                .iter()
                .map(|&(key, bounds)| (nearness(key, home), key, bounds))
                .collect();
            cells.sort_unstable_by_key(|(order, _, _)| *order);
            cells.into_iter().flat_map(move |(_, key, bounds)| {
                slab.cells[&key]
                    .iter()
                    .map(move |&index| (index as usize, Some((key, bounds))))
            })
        });
        oversized.chain(listed)
    }

    fn encloses(
        &self,
        around: &Around,
        index: usize,
        (coaxial, ignores): (&[usize], &impl Fn(&RoundSurface) -> bool),
        (arcs, coverage): (&mut Vec<ArcSpan>, &mut Coverage),
    ) -> bool {
        let polygon = &around.slab.polygons[index];
        let owner = self.facets[polygon.facet].owner;
        if owner.is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o])) {
            return false;
        }
        let Some(directions) = self.exact_polygon(around.slab, index, around.exact_center) else {
            return false;
        };
        if touches_origin(&directions) {
            return true;
        }
        if let Some(arc) = self.polygon_arc(around.slab, index, directions) {
            coverage.add(&arc);
            arcs.push(arc);
            return coverage.complete() && covers_exactly(arcs);
        }
        false
    }

    fn ray_hits(
        &self,
        around: &Around,
        home: [i64; 2],
        along: usize,
        sign: i64,
        blocks: &impl Fn(&SlabPolygon) -> bool,
    ) -> bool {
        let slab = around.slab;
        let across = 1 - along;
        let forward = if sign > 0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
        let clears = |polygon: &SlabPolygon| {
            let PlanBounds { low, high } = polygon.reach;
            let center = around.center;
            let behind = if sign > 0 {
                high[along] < center[along] - CERTAIN_LDU
            } else {
                low[along] > center[along] + CERTAIN_LDU
            };
            low[across] > center[across] + CERTAIN_LDU
                || high[across] < center[across] - CERTAIN_LDU
                || behind
        };
        let mut seen = vec![false; slab.polygons.len()];
        let mut stops = |index: u32| {
            let index = index as usize;
            if std::mem::replace(&mut seen[index], true) {
                return false;
            }
            let polygon = &slab.polygons[index];
            if !blocks(polygon) || clears(polygon) {
                return false;
            }
            if let Some(decided) = self.ray_decided(slab, polygon, around.center, along, sign) {
                return decided;
            }
            self.exact_polygon(slab, index, around.exact_center)
                .is_some_and(|directions| {
                    touches_origin(&directions) || ray_crosses(&directions, along, forward)
                })
        };
        if slab.oversized.iter().any(|&index| stops(index)) {
            return true;
        }
        if slab.cells.is_empty() {
            return false;
        }
        let near_row = |key: [i64; 2]| {
            (key[across] - home[across]).abs() <= 1 && (key[along] - home[along]) * sign >= -1
        };
        let ahead = if sign > 0 {
            slab.extent.1[along].saturating_sub(home[along])
        } else {
            home[along].saturating_sub(slab.extent.0[along])
        };
        if sparser_than(&slab.cells, ahead.max(0) as f64 + 2.0) {
            let mut keys: Vec<(i64, i64)> = slab
                .cells
                .keys()
                .copied()
                .filter(|&(x, y)| near_row([x, y]))
                .collect();
            keys.sort_unstable_by_key(|&(x, y)| ([x, y][along] * sign, [x, y][across]));
            return keys
                .into_iter()
                .any(|key| slab.cells[&key].iter().any(|&index| stops(index)));
        }
        let mut step = home;
        step[along] -= sign;
        loop {
            for row in [-1, 0, 1] {
                let mut at = step;
                at[across] += row;
                if let Some(found) = slab.cells.get(&(at[0], at[1])) {
                    if found.iter().any(|&index| stops(index)) {
                        return true;
                    }
                }
            }
            step[along] += sign;
            let past = if sign > 0 {
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

    pub fn grid(&self, plane: &Plane, reach: f64) -> Vec<[f64; 2]> {
        let steps = |low: f64, high: f64| {
            [
                ((low - IDENTIFY_LDU) / HALF_GRID_LDU).ceil() as i64,
                ((high + IDENTIFY_LDU) / HALF_GRID_LDU).floor() as i64,
            ]
        };
        let range = [
            steps(plane.min[0], plane.max[0]),
            steps(plane.min[1], plane.max[1]),
        ];
        let point = |(a, b): (i64, i64)| [a as f64 * HALF_GRID_LDU, b as f64 * HALF_GRID_LDU];
        let column = self.column(plane.axis);
        let oversized_walls = &self.oversized_walls[plane.axis];
        let seeded_everywhere = !column.has_oversized && oversized_walls.is_empty();
        if seeded_everywhere && !sparser_than(&column.cells, window_cells(range)) {
            return (range[0][0]..=range[0][1])
                .flat_map(|a| (range[1][0]..=range[1][1]).map(move |b| point((a, b))))
                .collect();
        }
        let pad = (reach / HALF_GRID_LDU).ceil() as i64 + 1;
        let mut live = SquareSet::default();
        for &(x, y) in self.occupied(plane.axis) {
            for a in x.saturating_sub(pad).max(range[0][0])..=x.saturating_add(pad).min(range[0][1])
            {
                for b in
                    y.saturating_sub(pad).max(range[1][0])..=y.saturating_add(pad).min(range[1][1])
                {
                    live.insert((a, b));
                }
            }
        }
        let mut live: Vec<(i64, i64)> = live.into_iter().collect();
        live.sort_unstable();
        live.into_iter().map(point).collect()
    }

    pub fn planes(&self) -> Vec<Plane> {
        let mut found: HashMap<(usize, i8, i64), Plane> = HashMap::new();
        let mut members: HashMap<(usize, i8, i64), Vec<usize>> = HashMap::new();
        for (index, facet) in self.facets.iter().enumerate() {
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
                let key = (axis, outward as i8, plane_key(at));
                members.entry(key).or_default().push(index);
                let plane = found.entry(key).or_insert(Plane {
                    axis,
                    outward,
                    at,
                    exact_at: None,
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
        for (key, plane) in found.iter_mut() {
            plane.exact_at = match sixteenths(plane.at) {
                Some(_) => Some(Exact::from_f64(plane.at)),
                None => self.shared_coordinate(plane.axis, &members[key]),
            };
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

    fn origin() -> Direction {
        [Exact::integer(0), Exact::integer(0)]
    }

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
        let solid = Solid::unpieced(&[steep], Vec::new());
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

    #[test]
    fn a_query_wider_than_the_index_visits_its_cells_in_the_nested_loop_order() {
        let at = |x: f64, z: f64| Triangle {
            color: 16,
            points: [
                [x - 1.0, 5.0, z - 1.0],
                [x + 1.0, 5.0, z - 1.0],
                [x, 5.0, z + 1.0],
            ],
            double_sided: true,
        };
        let solid = Solid::unpieced(
            &[
                at(905.0, 905.0),
                at(-895.0, 905.0),
                at(5.0, 5.0),
                at(-895.0, -895.0),
                at(905.0, -895.0),
                at(5005.0, 5.0),
            ],
            Vec::new(),
        );
        let probe = Probe {
            axis: 1,
            inward: 1.0,
            entrance: [0.0; 3],
            radius: 1.0,
        };
        let reach = 1500.0;
        let window = 2.0 * reach / HALF_GRID_LDU + 1.0;
        assert!(window * window > PLAN_BUDGET);
        let mut visited = Vec::new();
        solid.each(&probe, reach, (0.0, 10.0), None, |facet| {
            visited.push(facet);
            true
        });
        assert_eq!(visited, vec![3, 4, 2, 1, 0]);
    }

    fn flat(x: f64, z: f64, half: f64) -> Triangle {
        Triangle {
            color: 16,
            points: [
                [x - half, 5.0, z - half],
                [x + half, 5.0, z - half],
                [x, 5.0, z + half],
            ],
            double_sided: true,
        }
    }

    fn huge_ring() -> RoundSurface {
        RoundSurface {
            axis: 1,
            center: [0.0, 0.0],
            shape: RoundShape::Wall {
                radius: 1500.0,
                from: 0.0,
                to: 10.0,
            },
            full: true,
            arcs: None,
            facing: Some(1.0),
            piece: crate::pieces::NO_PIECE,
        }
    }

    fn vertical_probe(x: f64) -> Probe {
        Probe {
            axis: 1,
            inward: 1.0,
            entrance: [x, 0.0, 0.0],
            radius: 6.0,
        }
    }

    #[test]
    fn an_oversized_wall_is_still_found_by_queries_whose_window_meets_it() {
        let solid = Solid::unpieced(&[], vec![huge_ring()]);
        assert_eq!(solid.exact(&vertical_probe(1495.0), 20.0), vec![0]);
        assert!(solid.exact(&vertical_probe(5000.0), 20.0).is_empty());
    }

    #[test]
    fn an_oversized_slab_polygon_still_encloses_and_blocks_rays() {
        let solid = Solid::unpieced(&[flat(0.0, 0.0, 1_000_000.0)], Vec::new());
        let slab = solid.slab(1, 1.0, 0.0, (0.0, 10.0), None, |_| false);
        assert!(solid.blocked_on_axes(&slab, [0.0, 0.0], &origin(), |_| false));
        assert!(solid.enclosed(&slab, [0.0, 0.0], &origin(), |_| false));
    }

    #[test]
    fn oversized_geometry_seeds_no_probes_of_its_own() {
        let solid = Solid::unpieced(
            &[flat(-800.0, 0.0, 1.0), flat(800.0, 0.0, 1.0)],
            vec![huge_ring()],
        );
        let plane = solid
            .planes()
            .into_iter()
            .find(|plane| plane.axis == 1)
            .expect("the two flats share a plane");
        let seeded = solid.grid(&plane, 25.0);
        assert!(!seeded.is_empty());
        assert!(seeded.iter().all(|point| point[1].abs() > 700.0));
    }

    #[test]
    fn probes_are_seeded_where_geometry_lies_whatever_the_index_cell_size() {
        let flats = [(-800.0, 1.0), (0.0, 400.0), (800.0, 1.0)];
        let triangles = flats.map(|(x, half)| flat(x, 0.0, half));
        let boxes = flats.map(|(x, half)| [[-half, x - half], [half, x + half]]);
        let reach = 25.0;
        let gap = |point: [f64; 2]| {
            boxes
                .iter()
                .map(|plan| {
                    (0..2)
                        .map(|k| (plan[0][k] - point[k]).max(point[k] - plan[1][k]).max(0.0))
                        .fold(0.0, f64::max)
                })
                .fold(f64::INFINITY, f64::min)
        };
        let seeded = |size: f64| {
            let solid = Solid::with_cell_size(&triangles, vec![huge_ring()], size);
            let plane = solid
                .planes()
                .into_iter()
                .find(|plane| plane.axis == 1)
                .expect("the flats share a plane");
            let lattice = |low: f64, high: f64| {
                (low / HALF_GRID_LDU).ceil() as i64..=(high / HALF_GRID_LDU).floor() as i64
            };
            let near: Vec<[f64; 2]> = lattice(plane.min[0], plane.max[0])
                .flat_map(|a| {
                    lattice(plane.min[1], plane.max[1])
                        .map(move |b| [a as f64 * HALF_GRID_LDU, b as f64 * HALF_GRID_LDU])
                })
                .filter(|&point| gap(point) <= reach)
                .collect();
            (solid.grid(&plane, reach), near)
        };
        let (canonical, _) = seeded(HALF_GRID_LDU);
        for size in [2.5, 5.0, HALF_GRID_LDU, 20.0, 40.0] {
            let (found, near) = seeded(size);
            assert!(
                near.iter().all(|point| found.contains(point)),
                "cell size {size}"
            );
            assert!(
                found
                    .iter()
                    .all(|&point| gap(point) <= reach + 3.0 * HALF_GRID_LDU),
                "cell size {size}"
            );
            assert_eq!(found, canonical, "cell size {size}");
        }
    }

    fn toward(degrees: f64, radius: f64) -> [f64; 2] {
        let angle = degrees.to_radians();
        [
            radius * crate::trig::cos(angle),
            radius * crate::trig::sin(angle),
        ]
    }

    fn upright(a: [f64; 2], b: [f64; 2]) -> [Triangle; 2] {
        let low = |p: [f64; 2]| [p[0], 0.0, p[1]];
        let high = |p: [f64; 2]| [p[0], 10.0, p[1]];
        [
            Triangle {
                color: 16,
                points: [low(a), low(b), high(b)],
                double_sided: true,
            },
            Triangle {
                color: 16,
                points: [low(a), high(b), high(a)],
                double_sided: true,
            },
        ]
    }

    fn ring_of(segments: usize, missing: &[usize]) -> Vec<Triangle> {
        let step = 360.0 / segments as f64;
        (0..segments)
            .filter(|k| !missing.contains(k))
            .flat_map(|k| {
                upright(
                    toward(k as f64 * step, 30.0),
                    toward(((k + 1) % segments) as f64 * step, 30.0),
                )
            })
            .collect()
    }

    fn ring_without(missing: &[usize]) -> Vec<Triangle> {
        ring_of(16, missing)
    }

    fn encloses_centre(walls: &[Triangle]) -> bool {
        let solid = Solid::unpieced(walls, Vec::new());
        let slab = solid.slab(1, 1.0, 0.0, (0.0, 10.0), None, |_| false);
        solid.blocked_on_axes(&slab, [0.0, 0.0], &origin(), |_| false)
            && solid.enclosed(&slab, [0.0, 0.0], &origin(), |_| false)
    }

    #[test]
    fn a_far_wall_closes_the_one_gap_a_near_ring_leaves() {
        let gap = ring_without(&[2]);
        let far = |from: f64, to: f64| upright(toward(from, 600.0), toward(to, 600.0));
        let elsewhere = upright(toward(190.0, 600.0), toward(230.0, 600.0));
        let closed: Vec<Triangle> = [gap.as_slice(), &far(40.0, 72.0), &elsewhere].concat();
        assert!(encloses_centre(&closed));
        let in_two: Vec<Triangle> = [gap.as_slice(), &far(40.0, 57.0), &far(56.0, 72.0)].concat();
        assert!(encloses_centre(&in_two));
        let sliver_open: Vec<Triangle> = [gap.as_slice(), &far(46.0, 72.0)].concat();
        assert!(!encloses_centre(&sliver_open));
        assert!(!encloses_centre(&[gap.as_slice(), &elsewhere].concat()));
    }

    #[test]
    fn a_covered_wall_beside_the_closing_wall_does_not_hide_it() {
        let gap = ring_of(128, &[16]);
        let far = |from: f64, to: f64| upright(toward(from, 620.0), toward(to, 620.0));
        let decoy = far(41.0, 43.0);
        let closer = far(44.5, 48.5);
        assert!(encloses_centre(&[gap.as_slice(), &decoy, &closer].concat()));
        assert!(!encloses_centre(&[gap.as_slice(), &decoy].concat()));
    }

    #[test]
    fn every_group_and_cell_bounds_each_vertex_it_lists() {
        let unreadable = Triangle {
            color: 16,
            points: [
                [300.0, 0.0, 300.0],
                [f64::NAN, 10.0, 310.0],
                [310.0, 10.0, 300.0],
            ],
            double_sided: true,
        };
        let walls: Vec<Triangle> = [
            ring_of(128, &[16]),
            upright(toward(41.0, 620.0), toward(43.0, 620.0)).to_vec(),
            upright(toward(44.5, 620.0), toward(48.5, 620.0)).to_vec(),
            upright(toward(200.0, 90.0), toward(260.0, 140.0)).to_vec(),
            vec![unreadable],
        ]
        .concat();
        let solid = Solid::unpieced(&walls, Vec::new());
        let slab = solid.slab(1, 1.0, 0.0, (0.0, 10.0), None, |_| false);
        let holds = |bounds: PlanBounds, point: [f64; 2]| {
            (0..2).all(|k| {
                (bounds.low[k] <= point[k] && point[k] <= bounds.high[k])
                    || (bounds.low[k] == f64::NEG_INFINITY && bounds.high[k] == f64::INFINITY)
            })
        };
        let mut listed = 0;
        for (_, group) in slab.groups() {
            for &(key, bounds) in &group.cells {
                for &index in &slab.cells[&key] {
                    let polygon = &slab.polygons[index as usize];
                    if polygon.finite {
                        for corner in [polygon.reach.low, polygon.reach.high] {
                            assert!(holds(bounds, corner));
                            assert!(holds(group.bounds, corner));
                        }
                    }
                    listed += 1;
                }
            }
        }
        assert!(listed > slab.polygons.len());
        assert!(slab.polygons.iter().any(|polygon| !polygon.finite));
    }

    #[test]
    fn a_gap_across_the_back_of_the_turn_is_closed_by_a_far_wall() {
        let gap = ring_without(&[7, 8]);
        let behind = upright(toward(150.0, 600.0), toward(210.0, 600.0));
        assert!(encloses_centre(&[gap.as_slice(), &behind].concat()));
        let short = upright(toward(150.0, 600.0), toward(200.0, 600.0));
        assert!(!encloses_centre(&[gap.as_slice(), &short].concat()));
    }

    fn level_triangle(points: [[f64; 2]; 3], y: f64) -> Triangle {
        Triangle {
            color: 16,
            points: points.map(|p| [p[0], y, p[1]]),
            double_sided: true,
        }
    }

    const CELL_SIZES: [f64; 4] = [2.5, 5.0, HALF_GRID_LDU, 20.0];

    #[test]
    fn a_query_finds_what_meets_its_reach_whatever_the_index_cell_size() {
        let near = level_triangle([[3.0, 0.0], [4.0, 0.0], [3.0, 1.0]], 5.0);
        let past_the_reach = level_triangle([[8.0, 0.0], [9.0, 0.0], [8.0, 1.0]], 5.0);
        let ring = RoundSurface {
            center: [8.5, 0.0],
            shape: RoundShape::Wall {
                radius: 2.0,
                from: 0.0,
                to: 10.0,
            },
            ..huge_ring()
        };
        for size in CELL_SIZES {
            let solid = Solid::with_cell_size(
                &[near.clone(), past_the_reach.clone()],
                vec![ring.clone()],
                size,
            );
            let mut found = Vec::new();
            solid.each(&vertical_probe(0.0), 6.0, (0.0, 10.0), None, |facet| {
                found.push(solid.facets[facet as usize].points);
                true
            });
            assert_eq!(found, vec![near.points], "cell size {size}");
            let walls = |reach: f64| -> Vec<[f64; 2]> {
                solid
                    .exact(&vertical_probe(0.0), reach)
                    .into_iter()
                    .map(|index| solid.surfaces[index].center)
                    .collect()
            };
            assert!(walls(6.0).is_empty(), "cell size {size}");
            assert_eq!(walls(7.0), vec![ring.center], "cell size {size}");
        }
    }

    #[test]
    fn a_coplanar_face_that_never_reaches_the_axle_leaves_its_end_free() {
        let reach = 6.0 + IDENTIFY_LDU;
        let end = level_triangle([[-1.0, -1.0], [1.0, -1.0], [0.0, 1.0]], 0.0);
        let corner = level_triangle([[5.0, 5.0], [6.0, 5.0], [6.0, 6.0]], 0.0);
        let flush = level_triangle([[5.0, -0.5], [9.0, -0.5], [9.0, 0.5]], 0.0);
        let free = Solid::unpieced(&[end.clone(), corner.clone()], Vec::new());
        assert!(!free.section_reaches(
            &vertical_probe(0.0),
            (-IDENTIFY_LDU, IDENTIFY_LDU),
            reach,
            reach
        ));
        let joined = Solid::unpieced(&[end, corner, flush], Vec::new());
        assert!(joined.section_reaches(
            &vertical_probe(0.0),
            (-IDENTIFY_LDU, IDENTIFY_LDU),
            reach,
            reach
        ));
    }

    #[test]
    fn nothing_beyond_a_probes_reach_is_its_nearest_wall() {
        let reach = 6.0 + HALF_GRID_LDU + IDENTIFY_LDU;
        let corner = upright([13.0, 12.0], [12.0, 13.0]);
        let inside = upright([12.0, -3.0], [12.0, 3.0]);
        let range = (IDENTIFY_LDU, 10.0 - IDENTIFY_LDU);
        let nearest = |solid: Solid| solid.nearest(&vertical_probe(0.0), range, reach);
        assert!(nearest(Solid::unpieced(&corner, Vec::new())).is_infinite());
        assert!(nearest(Solid::unpieced(&[], vec![huge_ring()])).is_infinite());
        assert_eq!(
            nearest(Solid::unpieced(
                &[corner, inside].concat(),
                vec![huge_ring()]
            )),
            12.0
        );
    }
}
