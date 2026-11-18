use std::cell::OnceCell;
use std::collections::HashMap;

use crate::affine::Vec3;
use crate::circle::{
    approximate_span, approximately_covers, contains as arc_contains,
    covers_circle as covers_exactly, span, Approximate, ApproximateSpan, ArcSpan, Bearing,
    Direction,
};
use crate::exact::{Exact, ExactVec3};
use crate::flatten::{ExactTriangle, Triangle};
use crate::homogeneous::{clip_between, ray_crosses, touches_origin, Homogeneous};
use crate::lattice::STUD_LDU;
use crate::trig::planar_length;

pub const IDENTIFY_LDU: f64 = 0.0005;
const CERTAIN_LDU: f64 = 1e-6;
const FLOAT_ERROR_LDU: f64 = 1e-9;
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
    exact: Option<ExactTriangle>,
    front: Option<Vec3>,
    low: Vec3,
    high: Vec3,
    owner: Option<usize>,
    piece: u16,
}

struct SlabPolygon {
    facet: usize,
    points: Vec<Local>,
}

pub struct Slab {
    axis: usize,
    inward: f64,
    at: f64,
    range: (f64, f64),
    planes: (Exact, Exact),
    polygons: Vec<SlabPolygon>,
    clipped: Vec<OnceCell<Vec<Homogeneous>>>,
    cells: HashMap<(i64, i64), Vec<u32>>,
    extent: ([i64; 2], [i64; 2]),
}

struct Around<'a> {
    slab: &'a Slab,
    center: [f64; 2],
    exact_center: &'a Direction,
}

struct Surroundings<'s> {
    polygons: Vec<Vec<Local>>,
    surfaces: Vec<&'s RoundSurface>,
    center: [f64; 2],
    clearance: f64,
}

pub struct Solid {
    facets: Vec<Facet>,
    world: Vec<OnceCell<Option<[ExactVec3; 3]>>>,
    columns: [HashMap<(i64, i64), Vec<u32>>; 3],
    surfaces: Vec<RoundSurface>,
    axes: HashMap<(usize, i64, i64), Vec<usize>>,
    walls: [HashMap<(i64, i64), Vec<usize>>; 3],
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

fn crossing(p: Local, q: Local, at: f64) -> Local {
    let (a, b) = if p <= q { (p, q) } else { (q, p) };
    let t = (at - a[2]) / (b[2] - a[2]);
    [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), at]
}

fn clip(polygon: Vec<Local>, at: f64, keep_above: bool) -> Vec<Local> {
    let inside = |p: &Local| if keep_above { p[2] >= at } else { p[2] <= at };
    let mut out = Vec::with_capacity(polygon.len() + 1);
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

fn slab_clip(polygon: Vec<Local>, from: f64, to: f64) -> Vec<Local> {
    clip(clip(polygon, from, true), to, false)
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

fn contains(polygon: &[Local], point: [f64; 2]) -> bool {
    let area = plan_area(polygon);
    if polygon.len() < 3 || area == 0.0 {
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
                take(a[2] + t * dd);
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
            take(
                origin[2]
                    + gradient[0] * (lowest[0] - origin[0])
                    + gradient[1] * (lowest[1] - origin[1]),
            );
        }
    }
    best
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
        let mut columns: [HashMap<(i64, i64), Vec<u32>>; 3] = Default::default();
        let mut facets = Vec::with_capacity(triangles.len());
        for (source, (triangle, &piece)) in triangles.iter().zip(pieces).enumerate() {
            let [a, b, c] = triangle.points;
            let normal = cross(sub(b, a), sub(c, a));
            if normal == [0.0; 3] {
                continue;
            }
            let low = [0, 1, 2].map(|k| a[k].min(b[k]).min(c[k]));
            let high = [0, 1, 2].map(|k| a[k].max(b[k]).max(c[k]));
            let index = facets.len() as u32;
            for (axis, column) in columns.iter_mut().enumerate() {
                let (i, j) = plan_axes(axis);
                for x in cell(low[i])..=cell(high[i]) {
                    for y in cell(low[j])..=cell(high[j]) {
                        column.entry((x, y)).or_default().push(index);
                    }
                }
            }
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
        let mut solid = Solid {
            world: facets.iter().map(|_| OnceCell::new()).collect(),
            facets,
            columns,
            surfaces: Vec::new(),
            axes: HashMap::new(),
            walls: Default::default(),
        };
        for (index, surface) in surfaces.iter().enumerate() {
            let probe = axis_probe(surface.axis, surface.center, 0.0, 1.0);
            for facet in solid.near(&probe, surface.reach() + IDENTIFY_LDU) {
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

    fn near(&self, probe: &Probe, reach: f64) -> Vec<u32> {
        let (i, j) = plan_axes(probe.axis);
        let column = &self.columns[probe.axis];
        let mut out = Vec::new();
        for x in cell(probe.entrance[i] - reach)..=cell(probe.entrance[i] + reach) {
            for y in cell(probe.entrance[j] - reach)..=cell(probe.entrance[j] + reach) {
                if let Some(found) = column.get(&(x, y)) {
                    out.extend_from_slice(found);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    fn polygon(&self, probe: &Probe, facet: &Facet) -> Vec<Local> {
        facet.points.iter().map(|p| probe.local(*p)).collect()
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

    pub fn contributors(&self, probe: &Probe, range: (f64, f64), floor: Option<f64>) -> Vec<u16> {
        let reach = probe.radius + IDENTIFY_LDU;
        let coaxial = self.exact(probe, reach);
        let mut pieces: Vec<u16> = Vec::new();
        let walls = (-IDENTIFY_LDU, range.1);
        for index in self.near(probe, reach) {
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
            pieces.extend(self.floor_pieces(probe, probe.radius - IDENTIFY_LDU, depth));
        }
        pieces.sort_unstable();
        pieces.dedup();
        pieces
    }

    fn floor_pieces(&self, probe: &Probe, inside: f64, depth: f64) -> Vec<u16> {
        let coaxial = self.exact(probe, inside + IDENTIFY_LDU);
        let mut pieces = Vec::new();
        for index in self.near(probe, inside + IDENTIFY_LDU) {
            if self.owned_by(index as usize, &coaxial) {
                continue;
            }
            let facet = &self.facets[index as usize];
            if self.depth_range(probe, facet).1 < -IDENTIFY_LDU {
                continue;
            }
            let polygon = clip(self.polygon(probe, facet), -IDENTIFY_LDU, true);
            if first_depth(&polygon, inside).is_some_and(|d| d <= depth + IDENTIFY_LDU) {
                pieces.push(facet.piece);
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
        pieces
    }

    pub fn floor(&self, probe: &Probe, inside: f64) -> Floor {
        let coaxial = self.exact(probe, inside + IDENTIFY_LDU);
        let mut depth = f64::INFINITY;
        let mut attaining: Vec<(f64, Option<f64>)> = Vec::new();
        for index in self.near(probe, inside + IDENTIFY_LDU) {
            if self.owned_by(index as usize, &coaxial) {
                continue;
            }
            let facet = &self.facets[index as usize];
            if self.depth_range(probe, facet).1 < -IDENTIFY_LDU {
                continue;
            }
            let polygon = clip(self.polygon(probe, facet), -IDENTIFY_LDU, true);
            if polygon.is_empty() {
                continue;
            }
            if let Some(d) = first_depth(&polygon, inside) {
                depth = depth.min(d);
                attaining.push((d, facet.front.map(|front| front[probe.axis] * probe.inward)));
            }
        }
        for &index in &coaxial {
            let surface = &self.surfaces[index];
            let (low, high) = surface.depths(probe);
            if surface.nearest_from(probe.center()) >= inside || high < -IDENTIFY_LDU {
                continue;
            }
            let d = low.max(-IDENTIFY_LDU);
            depth = depth.min(d);
            let along = match surface.shape {
                RoundShape::Annulus { .. } => surface.facing.map(|f| f * probe.inward),
                RoundShape::Wall { .. } => Some(0.0),
            };
            attaining.push((d, along));
        }
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

    pub fn slab(
        &self,
        axis: usize,
        inward: f64,
        at: f64,
        range: (f64, f64),
        ignores: impl Fn(&RoundSurface) -> bool,
    ) -> Slab {
        let probe = axis_probe(axis, [at, at], at, inward);
        let mut polygons = Vec::new();
        for (index, facet) in self.facets.iter().enumerate() {
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
            let plan: Vec<Local> = clipped
                .iter()
                .map(|p| [p[0] + at, p[1] + at, 0.0])
                .collect();
            polygons.push(SlabPolygon {
                facet: index,
                points: plan,
            });
        }
        let mut cells: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
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
        let along = |depth: f64| Exact::from_f64(at).add(&Exact::from_f64(inward * depth));
        let ends = (along(range.0), along(range.1));
        let planes = if ends.0.compare(&ends.1) == std::cmp::Ordering::Greater {
            (ends.1, ends.0)
        } else {
            ends
        };
        Slab {
            axis,
            inward,
            at,
            range,
            planes,
            clipped: polygons.iter().map(|_| OnceCell::new()).collect(),
            polygons,
            cells,
            extent,
        }
    }

    fn exact_polygon(
        &self,
        slab: &Slab,
        index: usize,
        center: &Direction,
    ) -> Option<Vec<Direction>> {
        let facet = slab.polygons[index].facet;
        let world = self.world[facet]
            .get_or_init(|| self.facets[facet].exact.as_ref().map(ExactTriangle::points))
            .as_ref()?;
        let clipped = slab.clipped[index].get_or_init(|| {
            clip_between(
                world.iter().cloned().map(Homogeneous::of).collect(),
                slab.axis,
                &slab.planes.0,
                &slab.planes.1,
            )
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
        let polygons = self
            .near(probe, reach)
            .into_iter()
            .filter(|&index| !self.owned_by(index as usize, &coaxial))
            .filter_map(|index| {
                let facet = &self.facets[index as usize];
                let (low, high) = self.depth_range(probe, facet);
                if high < range.0 || low > range.1 {
                    return None;
                }
                let clipped = slab_clip(self.polygon(probe, facet), range.0, range.1);
                (!clipped.is_empty()).then(|| nearest_radius(&clipped))
            });
        let analytic = coaxial
            .iter()
            .map(|&index| &self.surfaces[index])
            .filter(|surface| {
                let (low, high) = surface.depths(probe);
                high >= range.0 && low <= range.1
            })
            .map(|surface| surface.nearest_from(probe.center()));
        polygons.chain(analytic).fold(f64::INFINITY, f64::min)
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
        clearance: f64,
    ) -> Surroundings<'_> {
        let longest = steps
            .iter()
            .map(|s| planar_length(s[0], s[1]))
            .fold(0.0, f64::max);
        let reach = probe.radius + longest + IDENTIFY_LDU;
        let exact = self.exact(probe, reach);
        let polygons: Vec<Vec<Local>> = self
            .near(probe, reach)
            .into_iter()
            .filter(|&index| !self.owned_by(index as usize, &exact))
            .filter_map(|index| {
                let facet = &self.facets[index as usize];
                let (low, high) = self.depth_range(probe, facet);
                if high < range.0 || low > range.1 {
                    return None;
                }
                let clipped = slab_clip(self.polygon(probe, facet), range.0, range.1);
                (!clipped.is_empty()).then_some(clipped)
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
            .any(|polygon| polygon_segment_distance(polygon, to) < around.clearance)
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
        let around = self.surroundings(probe, range, steps, probe.radius);
        steps
            .iter()
            .map(|&step| {
                let length = planar_length(step[0], step[1]);
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
        let home = [cell(center[0]), cell(center[1])];
        let blocks = |polygon: &SlabPolygon| {
            !self.facets[polygon.facet]
                .owner
                .is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o]))
        };
        let unit = |value: i64| Exact::integer(value);
        [(0, 1), (0, -1), (1, 1), (1, -1)]
            .into_iter()
            .all(|(along, sign)| {
                let mut direction = [unit(0), unit(0)];
                direction[along] = unit(sign);
                arcs.iter()
                    .any(|arc| arc_contains(arc, &Bearing::Raw(direction.clone())))
                    || self.ray_hits(around, home, along, sign, &blocks)
            })
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
        let center = around.exact_center;
        let clears = |polygon: &SlabPolygon| {
            let offset = |p: &Local, k: usize| p[k] - around.center[k];
            let all = |test: &dyn Fn(&Local) -> bool| polygon.points.iter().all(test);
            all(&|p| offset(p, 1 - along) > CERTAIN_LDU)
                || all(&|p| offset(p, 1 - along) < -CERTAIN_LDU)
                || all(&|p| offset(p, along) * (sign as f64) < -CERTAIN_LDU)
        };
        let across = 1 - along;
        let forward = if sign > 0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
        let mut seen = vec![false; slab.polygons.len()];
        let mut step = home;
        loop {
            for row in [-1, 0, 1] {
                let mut at = step;
                at[across] += row;
                let Some(found) = slab.cells.get(&(at[0], at[1])) else {
                    continue;
                };
                for &index in found {
                    let index = index as usize;
                    if std::mem::replace(&mut seen[index], true) {
                        continue;
                    }
                    let polygon = &slab.polygons[index];
                    if !blocks(polygon) || clears(polygon) {
                        continue;
                    }
                    let Some(directions) = self.exact_polygon(slab, index, center) else {
                        continue;
                    };
                    if touches_origin(&directions) || ray_crosses(&directions, along, forward) {
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

    fn approximately_enclosed(
        &self,
        around: &Around,
        probe: &Probe,
        coaxial: &[usize],
        arcs: &[ArcSpan],
        ignores: &impl Fn(&RoundSurface) -> bool,
    ) -> Option<bool> {
        let slab = around.slab;
        let mut approximate: Vec<ApproximateSpan> = arcs
            .iter()
            .map(|(low, high)| {
                (
                    low.approximate(FLOAT_ERROR_LDU),
                    high.approximate(FLOAT_ERROR_LDU),
                )
            })
            .collect();
        for polygon in &slab.polygons {
            let facet = &self.facets[polygon.facet];
            if facet
                .owner
                .is_some_and(|o| coaxial.contains(&o) || ignores(&self.surfaces[o]))
            {
                continue;
            }
            let (low, high) = self.depth_range(probe, facet);
            let sliver = high - slab.range.0 <= CERTAIN_LDU || slab.range.1 - low <= CERTAIN_LDU;
            if sliver || facet.exact.is_none() {
                return None;
            }
            let shifted: Vec<Local> = polygon
                .points
                .iter()
                .map(|p| [p[0] - around.center[0], p[1] - around.center[1], 0.0])
                .collect();
            let edge = (0..shifted.len())
                .map(|k| segment_radius(shifted[k], shifted[(k + 1) % shifted.len()]))
                .fold(f64::INFINITY, f64::min);
            if edge <= CERTAIN_LDU {
                return None;
            }
            if contains(&shifted, [0.0, 0.0]) {
                return Some(true);
            }
            let ends: Option<Vec<Approximate>> = shifted
                .iter()
                .map(|p| Approximate::of(p[0], p[1], CERTAIN_LDU))
                .collect();
            approximate.push(approximate_span(ends?)?);
        }
        approximately_covers(&approximate)
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
        if let Some(decided) =
            self.approximately_enclosed(&around, &probe, &coaxial, &arcs, &ignores)
        {
            return decided;
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
                        let Some(directions) = self.exact_polygon(slab, index, exact_center) else {
                            continue;
                        };
                        if touches_origin(&directions) {
                            return true;
                        }
                        arcs.extend(self.polygon_arc(slab, index, directions));
                    }
                }
            }
            let due = ring == rings || ring == next_check;
            if due && arcs.len() > checked {
                if covers_exactly(&arcs) {
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

    pub fn stands_on(&self, probe: &Probe, at: f64, radius: f64, toward: f64) -> bool {
        self.near(probe, radius + IDENTIFY_LDU)
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
