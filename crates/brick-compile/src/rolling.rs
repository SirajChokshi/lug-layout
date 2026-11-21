use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};

use crate::affine::Vec3;
use crate::flatten::Triangle;
use crate::identify::{self, identifies, SIXTEENTHS_PER_LDU};

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct UnreadEnds {
    pub from: Option<i32>,
    pub to: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct BandPlace {
    pub axis: usize,
    pub at: Option<[i32; 2]>,
    pub radii: Option<[Option<i32>; 2]>,
    pub ends: UnreadEnds,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UnreadBand {
    Unoriented,
    Centre {
        axis: usize,
        radii: Option<[Option<i32>; 2]>,
        ends: UnreadEnds,
    },
    Radius {
        axis: usize,
        at: [i32; 2],
        radii: [Option<i32>; 2],
        ends: UnreadEnds,
    },
    Width {
        axis: usize,
        at: [i32; 2],
        radii: [i32; 2],
        ends: UnreadEnds,
    },
    Faceted(BandPlace),
    Partial(BandPlace),
    Facing(BandPlace),
    Irregular(BandPlace),
    Arcs(BandPlace),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RawExtent {
    ends: [u64; 2],
    radii: [Option<u64>; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct UnreadRow {
    pub band: UnreadBand,
    pub raw: RawExtent,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PartRolling {
    pub surfaces: Vec<RollingSurface>,
    pub unread: Vec<UnreadRow>,
}

impl RawExtent {
    fn of(lo: f64, hi: f64, radii: [Option<f64>; 2]) -> RawExtent {
        let bits = |value: f64| (value + 0.0).to_bits();
        RawExtent {
            ends: [bits(lo), bits(hi)],
            radii: radii.map(|radius| radius.map(bits)),
        }
    }

    fn json(self) -> Value {
        let mut out = json!({
            "from": exact_rational(f64::from_bits(self.ends[0])),
            "to": exact_rational(f64::from_bits(self.ends[1])),
        });
        if self.radii.iter().any(Option::is_some) {
            out["radii"] = json!(self
                .radii
                .map(|radius| radius.map(|bits| exact_rational(f64::from_bits(bits)))));
        }
        out
    }
}

impl UnreadRow {
    fn json(self) -> Value {
        let mut out = self.band.json();
        out["raw"] = self.raw.json();
        out
    }

    fn served_json(self) -> Value {
        let full = self.band.json();
        let mut out = json!({ "reason": full["reason"] });
        if let Some(axis) = full.get("axis") {
            out["axis"] = axis.clone();
        }
        out
    }
}

const FRACTION_BITS: u32 = 52;
const EXPONENT_MASK: u64 = 0x7ff;
const EXPONENT_OFFSET: i32 = 1075;
const DECIMAL_LIMB: u64 = 1_000_000_000;

fn exact_rational(value: f64) -> Value {
    let bits = (value + 0.0).to_bits();
    let biased = i32::try_from((bits >> FRACTION_BITS) & EXPONENT_MASK).unwrap_or(0);
    let fraction = bits & ((1u64 << FRACTION_BITS) - 1);
    let significand = if biased == 0 {
        fraction
    } else {
        fraction | (1u64 << FRACTION_BITS)
    };
    if significand == 0 {
        return json!({ "numerator": "0", "denominator": "1" });
    }
    let trailing = significand.trailing_zeros();
    let odd = significand >> trailing;
    let exponent = biased.max(1) - EXPONENT_OFFSET + i32::try_from(trailing).unwrap_or(0);
    let sign = if bits >> 63 == 1 { "-" } else { "" };
    let (numerator, denominator) = if exponent >= 0 {
        (
            decimal_times_power_of_two(odd, exponent.unsigned_abs()),
            "1".to_string(),
        )
    } else {
        (
            odd.to_string(),
            decimal_times_power_of_two(1, exponent.unsigned_abs()),
        )
    };
    json!({ "numerator": format!("{sign}{numerator}"), "denominator": denominator })
}

fn decimal_times_power_of_two(value: u64, power: u32) -> String {
    let mut limbs = vec![
        value % DECIMAL_LIMB,
        value / DECIMAL_LIMB % DECIMAL_LIMB,
        value / DECIMAL_LIMB / DECIMAL_LIMB,
    ];
    for _ in 0..power {
        let mut carry = 0;
        for limb in &mut limbs {
            let doubled = *limb * 2 + carry;
            *limb = doubled % DECIMAL_LIMB;
            carry = doubled / DECIMAL_LIMB;
        }
        if carry > 0 {
            limbs.push(carry);
        }
    }
    while limbs.len() > 1 && limbs.last() == Some(&0) {
        limbs.pop();
    }
    let mut text = limbs.last().map_or(String::new(), u64::to_string);
    for limb in limbs.iter().rev().skip(1) {
        text.push_str(&format!("{limb:09}"));
    }
    text
}

impl UnreadEnds {
    fn of(lo: f64, hi: f64) -> UnreadEnds {
        UnreadEnds {
            from: sixteenths_of(lo),
            to: sixteenths_of(hi),
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
        let mut out = match self {
            UnreadBand::Unoriented => json!({ "reason": "unoriented" }),
            UnreadBand::Centre { axis, radii, .. } => {
                let mut out = json!({ "reason": "centre", "axis": axis });
                if let Some(radii) = radii {
                    out["radii"] = json!(radii);
                }
                out
            }
            UnreadBand::Radius {
                axis, at, radii, ..
            } => {
                json!({ "reason": "radius", "axis": axis, "at": at, "radii": radii })
            }
            UnreadBand::Width {
                axis, at, radii, ..
            } => {
                json!({ "reason": "width", "axis": axis, "at": at, "radii": radii })
            }
            UnreadBand::Faceted(place) => place.json("faceted"),
            UnreadBand::Partial(place) => place.json("partial"),
            UnreadBand::Facing(place) => place.json("facing"),
            UnreadBand::Irregular(place) => place.json("irregular"),
            UnreadBand::Arcs(place) => place.json("arcs"),
        };
        if let Some(ends) = self.ends() {
            ends.write(&mut out);
        }
        out
    }

    fn ends(self) -> Option<UnreadEnds> {
        match self {
            UnreadBand::Unoriented => None,
            UnreadBand::Centre { ends, .. }
            | UnreadBand::Radius { ends, .. }
            | UnreadBand::Width { ends, .. } => Some(ends),
            UnreadBand::Faceted(place)
            | UnreadBand::Partial(place)
            | UnreadBand::Facing(place)
            | UnreadBand::Irregular(place)
            | UnreadBand::Arcs(place) => Some(place.ends),
        }
    }
}

impl BandPlace {
    fn json(self, reason: &str) -> Value {
        let mut out = json!({ "reason": reason, "axis": self.axis });
        if let Some(at) = self.at {
            out["at"] = json!(at);
        }
        if let Some(radii) = self.radii {
            out["radii"] = json!(radii);
        }
        out
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
        let unread: Vec<Value> = self.unread.iter().map(|row| row.served_json()).collect();
        json!({
            "stepsPerLdu": SIXTEENTHS_PER_LDU,
            "surfaces": surfaces,
            "unread": unread,
        })
    }

    pub fn diagnostics(&self) -> Vec<Value> {
        self.unread.iter().map(|row| row.json()).collect()
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
                    let Some(turn_cosine) = strip.ring_circles().turn_cosine(&strip.rings) else {
                        continue;
                    };
                    let facets = strip.facets();
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
    let mut settled = vec![false; triangles.len()];
    let mut strip_reports: Vec<(UnreadRow, Vec<usize>)> = Vec::new();
    let mut strip_notes: Vec<(UnreadRow, Vec<usize>)> = Vec::new();
    let mut reported_round_by_strips = vec![false; triangles.len()];
    for axis in AXES {
        for span in mesh.spans(axis) {
            let (closed, pooled) = span.strips(&mesh, roundness);
            for strip in closed.into_iter().chain(pooled) {
                match strip.reading(roundness) {
                    BandReading::NotRound => {}
                    BandReading::Inward => strip.triangles.iter().for_each(|&t| settled[t] = true),
                    BandReading::Read(band) => {
                        strip.triangles.iter().for_each(|&t| settled[t] = true);
                        read.push(band);
                    }
                    BandReading::Unread(row) => {
                        if strip.has_round_evidence() {
                            strip
                                .triangles
                                .iter()
                                .for_each(|&t| reported_round_by_strips[t] = true);
                        }
                        strip_reports.push((row, strip.triangles));
                    }
                    BandReading::Noted(row) => strip_notes.push((row, strip.triangles)),
                }
            }
        }
    }
    let mut reported_by_strips = vec![false; triangles.len()];
    for (_, strip_triangles) in &strip_reports {
        strip_triangles
            .iter()
            .for_each(|&t| reported_by_strips[t] = true);
    }
    let mut reported_by_vertices = vec![false; triangles.len()];
    for (component, readings) in mesh.vertex_revolutions(roundness, &settled) {
        let reads_a_band = readings.iter().any(|r| matches!(r, BandReading::Read(_)));
        let strips_report_it = component.iter().all(|&t| reported_by_strips[t]);
        if strips_report_it && !reads_a_band {
            if !component.iter().all(|&t| reported_round_by_strips[t]) {
                unread.extend(readings.into_iter().filter_map(|reading| match reading {
                    BandReading::Unread(row) | BandReading::Noted(row) => Some(row),
                    BandReading::NotRound | BandReading::Inward | BandReading::Read(_) => None,
                }));
            }
            continue;
        }
        let reports_a_band = readings
            .iter()
            .any(|r| matches!(r, BandReading::Read(_) | BandReading::Unread(_)));
        if reports_a_band {
            component
                .iter()
                .for_each(|&t| reported_by_vertices[t] = true);
        }
        for reading in readings {
            match reading {
                BandReading::NotRound | BandReading::Inward => {}
                BandReading::Unread(row) | BandReading::Noted(row) => unread.push(row),
                BandReading::Read(band) => read.push(band),
            }
        }
    }
    unread.extend(
        strip_reports
            .into_iter()
            .chain(strip_notes)
            .filter(|(_, strip_triangles)| {
                let vertices_report_it = strip_triangles.iter().all(|&t| reported_by_vertices[t]);
                !vertices_report_it
            })
            .map(|(row, _)| row),
    );
    let mut surfaces = Vec::new();
    for band in merged(read) {
        match band.surface() {
            Some(surface) => surfaces.push(surface),
            None => unread.push(UnreadRow {
                band: UnreadBand::Width {
                    axis: band.axis,
                    at: band.at,
                    radii: band.radii,
                    ends: UnreadEnds::of(band.lo, band.hi),
                },
                raw: RawExtent::of(band.lo, band.hi, band.raw_radii.map(Some)),
            }),
        }
    }
    surfaces.sort_unstable();
    surfaces.dedup();
    unread.sort_unstable();
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

const ON_THE_CENTRE: f64 = -1.0;
const QUARTER_TURN: f64 = 1.0;

fn quarter_turns_from_x(v: [f64; 2]) -> f64 {
    let spread = v[0].abs() + v[1].abs();
    if spread == 0.0 {
        return ON_THE_CENTRE;
    }
    let toward_x = v[0] / spread;
    if v[1] >= 0.0 {
        QUARTER_TURN - toward_x
    } else {
        3.0 * QUARTER_TURN + toward_x
    }
}

fn by_angle(a: [f64; 2], b: [f64; 2]) -> Ordering {
    quarter_turns_from_x(a)
        .total_cmp(&quarter_turns_from_x(b))
        .then((a[0] * a[0] + a[1] * a[1]).total_cmp(&(b[0] * b[0] + b[1] * b[1])))
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
enum Orientation {
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

    fn orientation(&self, triangles: &[usize], radial: impl Fn(Vec3, Vec3) -> f64) -> Orientation {
        let mut outward = false;
        let mut inward = false;
        for &t in triangles {
            let triangle = &self.triangles[t];
            let Some(normal) = self.normals[t] else {
                continue;
            };
            if triangle.double_sided {
                return Orientation::Unknown;
            }
            let along = radial(normal, centroid(&triangle.points));
            outward |= along > 0.0;
            inward |= along < 0.0;
        }
        match (outward, inward) {
            (true, false) => Orientation::Outward,
            (false, true) => Orientation::Inward,
            _ => Orientation::Unknown,
        }
    }

    fn vertex_revolutions(
        &self,
        roundness: Roundness,
        settled: &[bool],
    ) -> Vec<(Vec<usize>, Vec<BandReading>)> {
        let member: Vec<bool> = self
            .triangles
            .iter()
            .enumerate()
            .map(|(t, triangle)| {
                self.normals[t].is_some() && !settled[t] && !flat_across_an_axis(triangle)
            })
            .collect();
        let normal = |t: usize| self.normals[t].unwrap_or([0.0; 3]);
        self.components(&member, |a, b| {
            dot(normal(a), normal(b)) >= roundness.coarse_turn_cosine
        })
        .into_iter()
        .filter(|component| component.len() >= roundness.coarse_facets)
        .filter_map(|component| {
            let readings = self.vertex_revolution(&component, roundness)?;
            Some((component, readings))
        })
        .collect()
    }

    fn vertex_revolution(
        &self,
        component: &[usize],
        roundness: Roundness,
    ) -> Option<Vec<BandReading>> {
        let normals: Vec<Vec3> = component.iter().filter_map(|&t| self.normals[t]).collect();
        let (direction, scatter) = revolution_axis(&normals, roundness.coarse_turn_cosine)?;
        match aligned_axis(direction) {
            Some(axis) => self.aligned_revolution(component, axis, roundness),
            None => self
                .tilted_revolution(component, direction, scatter)
                .map(|reading| vec![reading]),
        }
    }

    fn aligned_revolution(
        &self,
        component: &[usize],
        axis: usize,
        roundness: Roundness,
    ) -> Option<Vec<BandReading>> {
        let plane = across(axis);
        let mut points: Vec<(f64, [f64; 2])> = component
            .iter()
            .flat_map(|&t| self.triangles[t].points)
            .map(|p| (p[axis], [p[plane[0]], p[plane[1]]]))
            .collect();
        points.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then(a.1[0].total_cmp(&b.1[0]))
                .then(a.1[1].total_cmp(&b.1[1]))
        });
        points.dedup();
        let orientation_about = |centre: [f64; 2]| {
            self.orientation(component, |normal, at| {
                normal[plane[0]] * (at[plane[0]] - centre[0])
                    + normal[plane[1]] * (at[plane[1]] - centre[1])
            })
        };
        let (lo, hi) = (points.first()?.0, points.last()?.0);
        let profile = Profile::through_full_rings(&points, roundness);
        let complete = self.bounded_by_end_rings(component, axis, lo, hi);
        let profile = match (profile, complete) {
            (Some(profile), true) => profile,
            (found, _) => {
                let fit = match found {
                    Some(incomplete_profile) => incomplete_profile.coaxial_fit(),
                    None => match coaxial_rings(&points, 0.0).or_else(|| one_circle(&points)) {
                        Some(fit) => fit,
                        None => {
                            return Some(vec![BandReading::Noted(UnreadRow {
                                band: UnreadBand::Irregular(BandPlace {
                                    axis,
                                    at: None,
                                    radii: None,
                                    ends: UnreadEnds::of(lo, hi),
                                }),
                                raw: RawExtent::of(lo, hi, [None; 2]),
                            })])
                        }
                    },
                };
                let orientation = orientation_about(fit.centres[0]);
                return Some(vec![BandCandidate {
                    axis,
                    lo,
                    hi,
                    centres: fit.centres,
                    radii: fit.radii,
                    facets: 0,
                    orientation,
                }
                .unread_when_outward(UnreadBand::Irregular)]);
            }
        };
        let orientation = orientation_about(profile.centre);
        let centres: Vec<[f64; 2]> = profile
            .rings
            .iter()
            .map(|ring| ring.circle.centre)
            .collect();
        let facets = profile.facets();
        Some(
            profile
                .rings
                .windows(2)
                .map(|pair| {
                    BandCandidate {
                        axis,
                        lo: pair[0].along,
                        hi: pair[1].along,
                        centres: centres.clone(),
                        radii: [Some(pair[0].circle.radius), Some(pair[1].circle.radius)],
                        facets,
                        orientation,
                    }
                    .reading(roundness)
                })
                .collect(),
        )
    }

    fn bounded_by_end_rings(&self, component: &[usize], axis: usize, lo: f64, hi: f64) -> bool {
        let mut uses: HashMap<(Key, Key), usize> = HashMap::new();
        for &t in component {
            let points = self.triangles[t].points;
            for (a, b) in [(0, 1), (1, 2), (2, 0)] {
                let (ka, kb) = (key(points[a]), key(points[b]));
                *uses
                    .entry(if ka <= kb { (ka, kb) } else { (kb, ka) })
                    .or_default() += 1;
            }
        }
        let ends = [key([lo; 3])[0], key([hi; 3])[0]];
        let at_an_end = |k: Key| ends.contains(&k[axis]);
        uses.iter()
            .filter(|&(_, &count)| count == 1)
            .all(|(&(a, b), _)| at_an_end(a) && at_an_end(b) && a[axis] == b[axis])
    }

    fn tilted_revolution(
        &self,
        component: &[usize],
        direction: Vec3,
        scatter: f64,
    ) -> Option<BandReading> {
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
        let along: Vec<f64> = corners.iter().map(|&p| dot(p, direction)).collect();
        let lo = along.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = along.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let Some(fit) = coaxial_rings(&points, scatter * size).or_else(|| one_circle(&points))
        else {
            return Some(BandReading::Noted(UnreadRow {
                band: UnreadBand::Unoriented,
                raw: RawExtent::of(lo, hi, [None; 2]),
            }));
        };
        let centre = fit.centres[0];
        let orientation = self.orientation(component, |normal, at| {
            let r = offset(projected(at), centre);
            let n = projected(normal);
            n[0] * r[0] + n[1] * r[1]
        });
        (orientation != Orientation::Inward).then_some(BandReading::Unread(UnreadRow {
            band: UnreadBand::Unoriented,
            raw: RawExtent::of(lo, hi, fit.radii),
        }))
    }
}

struct FullRing {
    along: f64,
    circle: Circle,
    facets: usize,
}

struct Profile {
    centre: [f64; 2],
    rings: Vec<FullRing>,
}

impl Profile {
    fn through_full_rings(points: &[(f64, [f64; 2])], roundness: Roundness) -> Option<Profile> {
        let mut levels: Vec<(f64, Vec<[f64; 2]>)> = Vec::new();
        for &(t, p) in points {
            match levels.last_mut() {
                Some((along, level)) if along.to_bits() == t.to_bits() => level.push(p),
                _ => levels.push((t, vec![p])),
            }
        }
        if levels.len() < 2 {
            return None;
        }
        let full_ring = |along: f64, level: &[[f64; 2]]| {
            if level.len() < roundness.coarse_facets {
                return None;
            }
            let ring = Ring::in_angular_order(level.to_vec());
            let (circle, _) = ring.circle()?;
            let around = ring.around(circle.centre);
            let goes_around = (0..around.len()).all(|i| {
                let (a, b) = (around[i], around[(i + 1) % around.len()]);
                a[0] * b[1] - a[1] * b[0] > 0.0 && turn_cosine(a, b) >= roundness.coarse_turn_cosine
            });
            goes_around.then_some(FullRing {
                along,
                circle,
                facets: level.len(),
            })
        };
        let last = levels.len() - 1;
        let mut rings = Vec::new();
        for (i, (along, level)) in levels.iter().enumerate() {
            match full_ring(*along, level) {
                Some(ring) => rings.push(ring),
                None if i == 0 || i == last => return None,
                None => {}
            }
        }
        let centre = rings.first()?.circle.centre;
        let on_segments = rings.windows(2).all(|pair| {
            let [low, high] = [&pair[0], &pair[1]];
            let sagitta = low.circle.sagitta.min(high.circle.sagitta);
            let radius_at = |t: f64| {
                low.circle.radius
                    + (high.circle.radius - low.circle.radius) * (t - low.along)
                        / (high.along - low.along)
            };
            points
                .iter()
                .filter(|(t, _)| *t >= low.along && *t <= high.along)
                .all(|&(t, p)| (planar_distance(p, centre) - radius_at(t)).abs() < sagitta)
        });
        on_segments.then_some(Profile { centre, rings })
    }

    fn facets(&self) -> usize {
        self.rings.iter().map(|ring| ring.facets).min().unwrap_or(0)
    }

    fn coaxial_fit(&self) -> CoaxialFit {
        let radius_of = |ring: Option<&FullRing>| ring.map(|ring| ring.circle.radius);
        CoaxialFit {
            centres: self.rings.iter().map(|ring| ring.circle.centre).collect(),
            radii: [radius_of(self.rings.first()), radius_of(self.rings.last())],
        }
    }
}

fn sixteenths_of(value: f64) -> Option<i32> {
    identify::sixteenths(value).and_then(|steps| i32::try_from(steps).ok())
}

fn identified_at(centre: [f64; 2]) -> Option<[i32; 2]> {
    match centre.map(sixteenths_of) {
        [Some(a), Some(b)] => Some([a, b]),
        _ => None,
    }
}

fn aligned_axis(direction: Vec3) -> Option<usize> {
    let mut found = None;
    for (k, &c) in direction.iter().enumerate() {
        let magnitude = c.abs();
        if identifies(magnitude - 1.0) {
            found = Some(k);
        } else if !identifies(magnitude) {
            return None;
        }
    }
    found
}

fn revolution_axis(normals: &[Vec3], turn_cosine: f64) -> Option<(Vec3, f64)> {
    let first = *normals.first()?;
    let far = normals
        .iter()
        .copied()
        .min_by(|a, b| dot(*a, first).total_cmp(&dot(*b, first)))?;
    let spread = sub(far, first);
    let third = normals.iter().copied().max_by(|a, b| {
        length(cross(spread, sub(*a, first))).total_cmp(&length(cross(spread, sub(*b, first))))
    })?;
    let turned_apart = |a: Vec3, b: Vec3| dot(a, b) <= turn_cosine;
    if !(turned_apart(first, far) && turned_apart(first, third) && turned_apart(far, third)) {
        return None;
    }
    let axis = unit(cross(spread, sub(third, first)))?;
    let level = dot(first, axis);
    let scatter = normals
        .iter()
        .map(|&n| (dot(n, axis) - level).abs())
        .fold(0.0, f64::max);
    let leading = axis
        .iter()
        .copied()
        .max_by(|a, b| a.abs().total_cmp(&b.abs()))
        .unwrap_or(1.0);
    let axis = if leading < 0.0 {
        axis.map(|c| -c + 0.0)
    } else {
        axis
    };
    Some((axis, scatter))
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

struct CoaxialFit {
    centres: Vec<[f64; 2]>,
    radii: [Option<f64>; 2],
}

fn coaxial_rings(points: &[(f64, [f64; 2])], ring_spread: f64) -> Option<CoaxialFit> {
    let mut fit = CoaxialFit {
        centres: Vec::new(),
        radii: [None; 2],
    };
    let mut start = 0;
    while start < points.len() {
        let mut end = start + 1;
        while end < points.len() && points[end].0 - points[end - 1].0 <= ring_spread {
            end += 1;
        }
        let ring: Vec<[f64; 2]> = points[start..end].iter().map(|(_, p)| *p).collect();
        let (first, last) = (start == 0, end == points.len());
        start = end;
        if ring.len() < 3 {
            continue;
        }
        let Some(circle) = ring_circle(ring.clone()) else {
            continue;
        };
        if let Some(&common) = fit.centres.first() {
            let radius = ring
                .iter()
                .map(|p| planar_distance(*p, common))
                .fold(0.0, f64::max);
            let off_the_common_circle = ring
                .iter()
                .any(|p| (planar_distance(*p, common) - radius).abs() >= circle.sagitta);
            if off_the_common_circle {
                return None;
            }
        }
        fit.centres.push(circle.centre);
        if first {
            fit.radii[0] = Some(circle.radius);
        }
        if last {
            fit.radii[1] = Some(circle.radius);
        }
    }
    (!fit.centres.is_empty()).then_some(fit)
}

fn one_circle(points: &[(f64, [f64; 2])]) -> Option<CoaxialFit> {
    let mut across: Vec<[f64; 2]> = points.iter().map(|(_, p)| *p).collect();
    across.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    across.dedup();
    let circle = ring_circle(across)?;
    Some(CoaxialFit {
        centres: vec![circle.centre],
        radii: [Some(circle.radius); 2],
    })
}

fn ring_circle(mut ring: Vec<[f64; 2]>) -> Option<Circle> {
    let fitted = fitted_centre(&ring)?;
    ring.sort_by(|a, b| by_angle(offset(*a, fitted), offset(*b, fitted)));
    let chords: Vec<(usize, usize)> = (0..ring.len()).map(|i| (i, (i + 1) % ring.len())).collect();
    Circle::fitted(&ring, &chords, fitted)
}

struct Circle {
    centre: [f64; 2],
    radius: f64,
    sagitta: f64,
}

impl Circle {
    fn about(
        points: &[[f64; 2]],
        chords: &[(usize, usize)],
        centre: [f64; 2],
        radius: f64,
    ) -> Option<Circle> {
        let sagitta = chords
            .iter()
            .map(|&(a, b)| {
                let middle = [
                    (points[a][0] + points[b][0]) / 2.0,
                    (points[a][1] + points[b][1]) / 2.0,
                ];
                radius - planar_distance(middle, centre)
            })
            .fold(f64::INFINITY, f64::min);
        let on_circle = sagitta > 0.0
            && sagitta.is_finite()
            && points
                .iter()
                .all(|p| (planar_distance(*p, centre) - radius).abs() < sagitta);
        on_circle.then_some(Circle {
            centre,
            radius,
            sagitta,
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
    fn in_angular_order(points: Vec<[f64; 2]>) -> Ring {
        let unordered = Ring {
            points,
            degree: Vec::new(),
            chords: Vec::new(),
        };
        let (centre, _) = unordered.extents();
        let mut points = unordered.points;
        points.sort_by(|a, b| by_angle(offset(*a, centre), offset(*b, centre)));
        let count = points.len();
        Ring {
            points,
            degree: vec![2; count],
            chords: (0..count).map(|i| (i, (i + 1) % count)).collect(),
        }
    }

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
            .filter(|c| (extents_radius - c.radius).abs() < c.sagitta);
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

enum RingCircles {
    Absent,
    ReferenceOnly {
        centre: [f64; 2],
        radii: [Option<f64>; 2],
    },
    Misaligned {
        centres: Vec<[f64; 2]>,
        radii: [Option<f64>; 2],
    },
    Coaxial {
        centres: Vec<[f64; 2]>,
        radii: [Option<f64>; 2],
        reference_ring: usize,
    },
}

impl RingCircles {
    fn turn_cosine(&self, rings: &[Ring; 2]) -> Option<f64> {
        let RingCircles::Coaxial {
            centres,
            reference_ring,
            ..
        } = self
        else {
            return None;
        };
        let ring = &rings[*reference_ring];
        let centre = centres[0];
        Some(
            ring.chords
                .iter()
                .map(|&(a, b)| {
                    turn_cosine(
                        offset(ring.points[a], centre),
                        offset(ring.points[b], centre),
                    )
                })
                .fold(f64::INFINITY, f64::min),
        )
    }
}

enum BandReading {
    NotRound,
    Inward,
    Unread(UnreadRow),
    Noted(UnreadRow),
    Read(ReadBand),
}

struct BandCandidate {
    axis: usize,
    lo: f64,
    hi: f64,
    centres: Vec<[f64; 2]>,
    radii: [Option<f64>; 2],
    facets: usize,
    orientation: Orientation,
}

impl BandCandidate {
    fn at(&self) -> Option<[i32; 2]> {
        let (first, rest) = self.centres.split_first()?;
        let at = identified_at(*first)?;
        rest.iter()
            .all(|&centre| identified_at(centre) == Some(at))
            .then_some(at)
    }

    fn identified_radii(&self) -> [Option<i32>; 2] {
        self.radii.map(|radius| radius.and_then(sixteenths_of))
    }

    fn ends(&self) -> UnreadEnds {
        UnreadEnds::of(self.lo, self.hi)
    }

    fn place_radii(&self) -> Option<[Option<i32>; 2]> {
        self.radii
            .iter()
            .any(Option::is_some)
            .then(|| self.identified_radii())
    }

    fn place(&self) -> BandPlace {
        BandPlace {
            axis: self.axis,
            at: self.at(),
            radii: self.place_radii(),
            ends: self.ends(),
        }
    }

    fn row(&self, band: UnreadBand) -> UnreadRow {
        UnreadRow {
            band,
            raw: RawExtent::of(self.lo, self.hi, self.radii),
        }
    }

    fn unread_when_outward(&self, outward: fn(BandPlace) -> UnreadBand) -> BandReading {
        match self.orientation {
            Orientation::Inward => BandReading::Inward,
            Orientation::Unknown => BandReading::Unread(self.row(UnreadBand::Facing(self.place()))),
            Orientation::Outward => BandReading::Unread(self.row(outward(self.place()))),
        }
    }

    fn reading(&self, roundness: Roundness) -> BandReading {
        match self.orientation {
            Orientation::Inward => BandReading::Inward,
            Orientation::Unknown => BandReading::Unread(self.row(UnreadBand::Facing(self.place()))),
            Orientation::Outward if self.centres.is_empty() => self.centre_unread(),
            Orientation::Outward if self.facets < roundness.standard_facets => {
                BandReading::Unread(self.row(UnreadBand::Faceted(self.place())))
            }
            Orientation::Outward => self.outward_reading(),
        }
    }

    fn centre_unread(&self) -> BandReading {
        BandReading::Unread(self.row(UnreadBand::Centre {
            axis: self.axis,
            radii: self.place_radii(),
            ends: self.ends(),
        }))
    }

    fn outward_reading(&self) -> BandReading {
        let radii = self.identified_radii();
        let Some(at) = self.at() else {
            return self.centre_unread();
        };
        match (radii, self.radii) {
            ([Some(r0), Some(r1)], [Some(raw0), Some(raw1)]) => BandReading::Read(ReadBand {
                axis: self.axis,
                at,
                lo: self.lo,
                hi: self.hi,
                radii: [r0, r1],
                raw_radii: [raw0, raw1],
            }),
            _ => BandReading::Unread(self.row(UnreadBand::Radius {
                axis: self.axis,
                at,
                radii,
                ends: self.ends(),
            })),
        }
    }
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

    fn has_round_evidence(&self) -> bool {
        !self.is_closed() || !matches!(self.ring_circles(), RingCircles::Absent)
    }

    fn facets(&self) -> usize {
        self.rings.iter().map(|r| r.points.len()).max().unwrap_or(0)
    }

    fn reference_circle(&self) -> Option<(usize, Circle)> {
        let denser_ring = usize::from(self.rings[1].points.len() > self.rings[0].points.len());
        [denser_ring, 1 - denser_ring]
            .into_iter()
            .find_map(|index| {
                self.rings[index]
                    .circle()
                    .map(|(circle, _)| (index, circle))
            })
    }

    fn ring_circles(&self) -> RingCircles {
        if !self.is_closed() {
            return RingCircles::Absent;
        }
        let Some((reference_ring, circle)) = self.reference_circle() else {
            return RingCircles::Absent;
        };
        let mut radii = [None; 2];
        radii[reference_ring] = Some(circle.radius);
        let other = &self.rings[1 - reference_ring];
        let (other_centre, coaxial) = if other.is_apex() {
            radii[1 - reference_ring] = Some(0.0);
            (
                other.points[0],
                planar_distance(other.points[0], circle.centre) < circle.sagitta,
            )
        } else {
            let Some((own, _)) = other.circle() else {
                return RingCircles::ReferenceOnly {
                    centre: circle.centre,
                    radii,
                };
            };
            radii[1 - reference_ring] = Some(own.radius);
            let coaxial = Circle::about(
                &other.points,
                &other.chords,
                circle.centre,
                other.circumradius(circle.centre),
            )
            .is_some_and(|about_common| {
                (about_common.radius - own.radius).abs() < about_common.sagitta
            });
            (own.centre, coaxial)
        };
        let centres = vec![circle.centre, other_centre];
        if coaxial {
            RingCircles::Coaxial {
                centres,
                radii,
                reference_ring,
            }
        } else {
            RingCircles::Misaligned { centres, radii }
        }
    }

    fn orientation_about(&self, centre: [f64; 2]) -> Orientation {
        let plane = across(self.axis);
        self.mesh.orientation(&self.triangles, |normal, at| {
            normal[plane[0]] * (at[plane[0]] - centre[0])
                + normal[plane[1]] * (at[plane[1]] - centre[1])
        })
    }

    fn candidate(
        &self,
        oriented_about: [f64; 2],
        centres: Vec<[f64; 2]>,
        radii: [Option<f64>; 2],
    ) -> BandCandidate {
        let orientation = self.orientation_about(oriented_about);
        BandCandidate {
            axis: self.axis,
            lo: self.lo,
            hi: self.hi,
            centres,
            radii,
            facets: self.facets(),
            orientation,
        }
    }

    fn radii_about(&self, reference_ring: usize, circle: &Circle) -> [Option<f64>; 2] {
        let other = &self.rings[1 - reference_ring];
        let mut radii = [None; 2];
        radii[reference_ring] = Some(circle.radius);
        if !other.points.is_empty() && !other.chords.is_empty() {
            radii[1 - reference_ring] = Circle::about(
                &other.points,
                &other.chords,
                circle.centre,
                other.circumradius(circle.centre),
            )
            .map(|about_common| about_common.radius);
        }
        radii
    }

    fn arcs(&self, roundness: Roundness) -> Option<UnreadRow> {
        let (reference_ring, circle) = self.reference_circle()?;
        if self.rings[reference_ring].points.len() < roundness.coarse_facets {
            return None;
        }
        let radii = self.radii_about(reference_ring, &circle);
        let candidate = self.candidate(circle.centre, vec![circle.centre], radii);
        match candidate.orientation {
            Orientation::Inward => None,
            Orientation::Unknown => Some(candidate.row(UnreadBand::Facing(candidate.place()))),
            Orientation::Outward => Some(candidate.row(UnreadBand::Arcs(candidate.place()))),
        }
    }

    fn open_candidate(&self, roundness: Roundness) -> Option<BandCandidate> {
        let (reference_ring, circle) = self.reference_circle()?;
        let ring = &self.rings[reference_ring];
        if ring.points.len() < roundness.coarse_facets {
            return None;
        }
        let radii = self.radii_about(reference_ring, &circle);
        let around = ring.around(circle.centre);
        let goes_round = (0..around.len()).all(|i| {
            let (a, b) = (around[i], around[(i + 1) % around.len()]);
            a[0] * b[1] - a[1] * b[0] > 0.0 && turn_cosine(a, b) >= roundness.coarse_turn_cosine
        });
        goes_round.then(|| self.candidate(circle.centre, vec![circle.centre], radii))
    }

    fn reading(&self, roundness: Roundness) -> BandReading {
        if self.is_closed() {
            return self.closed_reading(roundness);
        }
        match self.open_candidate(roundness) {
            Some(candidate) => candidate.unread_when_outward(UnreadBand::Partial),
            None => self
                .arcs(roundness)
                .map_or(BandReading::NotRound, BandReading::Noted),
        }
    }

    fn closed_reading(&self, roundness: Roundness) -> BandReading {
        if self.facets() < roundness.coarse_facets {
            return BandReading::NotRound;
        }
        match self.ring_circles() {
            RingCircles::Absent => {
                let denser_ring = self.rings.iter().max_by_key(|r| r.points.len());
                let extents_centre = denser_ring.map_or([0.0; 2], |r| r.extents().0);
                self.candidate(extents_centre, Vec::new(), [None; 2])
                    .reading(roundness)
            }
            RingCircles::ReferenceOnly { centre, radii } => self
                .candidate(centre, vec![centre], radii)
                .unread_when_outward(UnreadBand::Irregular),
            RingCircles::Misaligned { centres, radii } => {
                let oriented_about = centres[0];
                self.candidate(oriented_about, centres, radii)
                    .unread_when_outward(UnreadBand::Irregular)
            }
            RingCircles::Coaxial { centres, radii, .. } => {
                let oriented_about = centres[0];
                self.candidate(oriented_about, centres, radii)
                    .reading(roundness)
            }
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
    raw_radii: [f64; 2],
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
        match [self.lo, self.hi, next.hi].map(sixteenths_of) {
            [Some(t0), Some(t1), Some(t2)] => {
                let [r0, r1, r2] = [self.radii[0], self.radii[1], next.radii[1]].map(i64::from);
                let [t0, t1, t2] = [t0, t1, t2].map(i64::from);
                (r1 - r0) * (t2 - t1) == (r2 - r1) * (t1 - t0)
            }
            _ => false,
        }
    }

    fn surface(&self) -> Option<RollingSurface> {
        let cylinder = self.radii[0] == self.radii[1];
        let from = end_sixteenths(self.lo, cylinder, f64::ceil)?;
        let to = end_sixteenths(self.hi, cylinder, f64::floor)?;
        (from < to).then_some(RollingSurface {
            axis: self.axis,
            at: self.at,
            from,
            to,
            radii: self.radii,
        })
    }
}

fn end_sixteenths(end: f64, cylinder: bool, inward: fn(f64) -> f64) -> Option<i32> {
    sixteenths_of(end).or_else(|| cylinder.then(|| inward(end * 16.0) as i32))
}

fn merged(mut bands: Vec<ReadBand>) -> Vec<ReadBand> {
    bands.sort_by(|a, b| {
        (a.axis, a.at)
            .cmp(&(b.axis, b.at))
            .then(a.lo.total_cmp(&b.lo))
            .then(a.radii.cmp(&b.radii))
            .then(a.hi.total_cmp(&b.hi))
    });
    bands.dedup_by(|b, a| {
        a.axis == b.axis && a.at == b.at && a.lo == b.lo && a.hi == b.hi && a.radii == b.radii
    });
    let mut out: Vec<ReadBand> = Vec::new();
    for band in bands {
        match out.iter_mut().rev().find(|open| open.continues_into(&band)) {
            Some(open) => {
                open.hi = band.hi;
                open.radii[1] = band.radii[1];
                open.raw_radii[1] = band.raw_radii[1];
            }
            None => out.push(band),
        }
    }
    out
}
