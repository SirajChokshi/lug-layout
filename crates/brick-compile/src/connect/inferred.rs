use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::affine::{Affine, Vec3};
use crate::flatten::{resolve_reference, Flattener, Library, Lod};
use crate::ldraw::{self, Line, Winding};

use super::meta::{parse_metas, Meta};
use super::solid::{
    covers_circle, identified, plan_axes, sixteenth, span_of, Probe, RoundShape, RoundSurface,
    Slab, Solid, HALF_GRID_LDU, IDENTIFY_LDU,
};
use super::{
    finished, Caps, Connector, Gender, Issue, Scaling, Section, SectionShape, Shape, Source,
};

const MAX_DEPTH: usize = 64;
const KEY_STEPS: f64 = 1.0 / IDENTIFY_LDU;
const CIRCLE_POINTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Uninferred {
    UnidentifiedSize { size: f64, length: f64 },
    UnidentifiedOrigin,
    LooseCavity { clearance: f64 },
    UnpairedThroughCavity { radius: f64 },
    TiltedRound { radius: f64 },
    UnknownFacing { radius: f64 },
    OpenArc { radius: f64 },
    Unflattened,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inference {
    pub connectors: Vec<Connector>,
    pub off_lattice: Vec<Connector>,
    pub issues: Vec<Issue>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SectionVocabulary {
    sizes: Vec<(SectionShape, f64)>,
    lengths: Vec<(SectionShape, f64)>,
}

impl SectionVocabulary {
    pub fn from_metas<'t>(texts: impl IntoIterator<Item = &'t str>) -> Self {
        let mut sizes = Vec::new();
        let mut lengths = Vec::new();
        for text in texts {
            for parsed in parse_metas(text).into_iter().flatten() {
                let Meta::Snap(connector) = parsed.meta else {
                    continue;
                };
                match connector.shape {
                    Shape::Cylinder { sections, .. } => {
                        for section in sections {
                            sizes.push((section.shape, section.radius));
                            lengths.push((section.shape, section.length));
                        }
                    }
                    Shape::Clip { radius, length, .. } => {
                        sizes.push((SectionShape::Round, radius));
                        lengths.push((SectionShape::Round, length));
                    }
                    Shape::Finger { .. } | Shape::Generic { .. } => {}
                }
            }
        }
        let tidy = |mut values: Vec<(SectionShape, f64)>| {
            values.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
            values.dedup();
            values
        };
        SectionVocabulary {
            sizes: tidy(sizes),
            lengths: tidy(lengths),
        }
    }

    fn matching(values: &[(SectionShape, f64)], shape: SectionShape, measured: f64) -> Option<f64> {
        let mut found = values
            .iter()
            .filter(|(s, v)| *s == shape && (v - measured).abs() <= IDENTIFY_LDU)
            .map(|(_, v)| *v);
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    fn size(&self, shape: SectionShape, measured: f64) -> Option<f64> {
        Self::matching(&self.sizes, shape, measured)
    }

    fn length(&self, shape: SectionShape, measured: f64) -> Option<f64> {
        sixteenth(measured).or_else(|| Self::matching(&self.lengths, shape, measured))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum UnitShape {
    Wall,
    Annulus { inner: f64, outer: f64 },
}

#[derive(Debug)]
struct UnitRound {
    shape: UnitShape,
    arcs: Vec<(f64, f64)>,
    facing: Option<f64>,
}

#[derive(Clone)]
struct RoundRef {
    unit: Rc<UnitRound>,
    matrix: Affine,
    inverted: bool,
    certified: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Run {
    axis: usize,
    center: [f64; 2],
    radius: f64,
    from: f64,
    to: f64,
    facing: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct Band {
    from: f64,
    to: f64,
    arcs: Vec<(f64, f64)>,
    center: [f64; 2],
    radius: f64,
}

type WallKey = (usize, i64, i64, i64, i8);

#[derive(Clone, Copy, Debug, PartialEq)]
struct StudProbe {
    radius: f64,
    reach: f64,
}

enum Probed {
    Blind(f64),
    Through,
    Loose(f64),
    Rejected,
}

struct Placed {
    surfaces: Vec<RoundSurface>,
    runs: Vec<Run>,
}

struct Borrowed<'a, L: Library + ?Sized>(&'a L);

impl<L: Library + ?Sized> Library for Borrowed<'_, L> {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.source(path)
    }
}

fn column(m: &Affine, c: usize) -> Vec3 {
    [m.m[c], m.m[4 + c], m.m[8 + c]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

fn key(value: f64) -> i64 {
    (identified(value) * KEY_STEPS).round() as i64
}

fn aligned_axis(direction: Vec3) -> Option<usize> {
    let size = norm(direction);
    let unit = direction.map(|c| c / size);
    (0..3).find(|&k| {
        (0..3).all(|j| j == k || unit[j].abs() <= IDENTIFY_LDU)
            && (unit[k].abs() - 1.0).abs() <= IDENTIFY_LDU
    })
}

fn unit_axis(axis: usize, sign: f64) -> Vec3 {
    let mut v = [0.0; 3];
    v[axis] = sign;
    v
}

fn ldraw_frame(origin: Vec3, local_y: Vec3) -> Affine {
    let axis = (0..3).find(|&k| local_y[k] != 0.0).unwrap_or(1);
    let x = unit_axis((axis + 2) % 3, 1.0);
    let z = [
        x[1] * local_y[2] - x[2] * local_y[1],
        x[2] * local_y[0] - x[0] * local_y[2],
        x[0] * local_y[1] - x[1] * local_y[0],
    ];
    Affine::from_ldraw(
        origin,
        [
            x[0], local_y[0], z[0], x[1], local_y[1], z[1], x[2], local_y[2], z[2],
        ],
    )
}

fn point_on(axis: usize, center: [f64; 2], along: f64) -> Vec3 {
    let (i, j) = plan_axes(axis);
    let mut p = [0.0; 3];
    p[axis] = along;
    p[i] = center[0];
    p[j] = center[1];
    p
}

fn polygon_normal(points: &[Vec3], winding: Winding) -> Vec3 {
    let e1 = [0, 1, 2].map(|k| points[1][k] - points[0][k]);
    let e2 = [0, 1, 2].map(|k| points[2][k] - points[0][k]);
    let normal = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    match winding {
        Winding::Ccw => normal,
        Winding::Cw => normal.map(|c| -c),
    }
}

fn surrounds_center(points: &[Vec3]) -> bool {
    let mut sign = 0.0;
    points.iter().enumerate().all(|(k, a)| {
        let b = points[(k + 1) % points.len()];
        let side = (b[0] - a[0]) * (-a[2]) - (b[2] - a[2]) * (-a[0]);
        let consistent = sign == 0.0 || side == 0.0 || side.signum() == sign;
        if side != 0.0 {
            sign = side.signum();
        }
        consistent
    })
}

fn unit_round(source: &str) -> Option<UnitRound> {
    let file = ldraw::parse(source);
    let mut certified = false;
    let mut winding = Winding::Ccw;
    let mut polygons: Vec<(Vec<Vec3>, bool, Winding)> = Vec::new();
    for line in &file.lines {
        match line {
            Line::Certify(w) => {
                certified = true;
                winding = *w;
            }
            Line::NoCertify => certified = false,
            Line::SetWinding(w) => winding = *w,
            Line::Subfile { .. } => return None,
            Line::Triangle { points, .. } => polygons.push((points.to_vec(), certified, winding)),
            Line::Quad { points, .. } => polygons.push((points.to_vec(), certified, winding)),
            Line::Edge { .. } | Line::InvertNext => {}
        }
    }
    if polygons.is_empty() {
        return None;
    }
    let radius = |p: &Vec3| p[0].hypot(p[2]);
    let level = |p: &Vec3, y: f64| (p[1] - y).abs() <= IDENTIFY_LDU;
    let all = || polygons.iter().flat_map(|(points, _, _)| points.iter());
    let wall = polygons.iter().all(|(points, _, _)| {
        points
            .iter()
            .all(|p| (radius(p) - 1.0).abs() <= IDENTIFY_LDU)
            && points.iter().all(|p| level(p, 0.0) || level(p, 1.0))
            && points.iter().any(|p| level(p, 0.0))
            && points.iter().any(|p| level(p, 1.0))
    });
    let shape = if wall {
        UnitShape::Wall
    } else if all().all(|p| level(p, 0.0)) {
        let inner = all().map(radius).fold(f64::INFINITY, f64::min);
        let outer = all().map(radius).fold(0.0, f64::max);
        let hollow = inner > IDENTIFY_LDU;
        let circle = if hollow { inner } else { outer };
        let on_circle = all()
            .filter(|p| (radius(p) - circle).abs() <= IDENTIFY_LDU)
            .count();
        let covers_center = hollow
            && polygons
                .iter()
                .any(|(points, _, _)| surrounds_center(points));
        if on_circle < CIRCLE_POINTS || covers_center {
            return None;
        }
        UnitShape::Annulus {
            inner: if hollow { inner } else { 0.0 },
            outer,
        }
    } else {
        return None;
    };
    let mut facings = Vec::new();
    let mut arcs = Vec::new();
    let mut all_certified = true;
    for (points, certified, winding) in &polygons {
        let normal = polygon_normal(points, *winding);
        let count = points.len() as f64;
        let centroid = [0, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / count);
        facings.push(match shape {
            UnitShape::Wall => (normal[0] * centroid[0] + normal[2] * centroid[1]).signum(),
            UnitShape::Annulus { .. } => normal[1].signum(),
        });
        all_certified &= *certified;
        let angles: Vec<f64> = points
            .iter()
            .filter(|p| radius(p) > IDENTIFY_LDU)
            .map(|p| p[2].atan2(p[0]))
            .collect();
        arcs.extend(span_of(&angles));
    }
    let first = facings[0];
    let agree = facings.iter().all(|f| *f == first);
    Some(UnitRound {
        shape,
        arcs,
        facing: (agree && all_certified).then_some(first),
    })
}

fn arc_length(arcs: &[(f64, f64)]) -> f64 {
    use std::f64::consts::TAU;
    arcs.iter()
        .map(|&(low, high)| {
            if high >= low {
                high - low
            } else {
                high - low + TAU
            }
        })
        .sum()
}

pub struct InferredFeatures<'a, L: Library + ?Sized> {
    library: &'a L,
    vocabulary: SectionVocabulary,
    probe: StudProbe,
    units: HashMap<String, Option<Rc<UnitRound>>>,
    rounds: HashMap<String, Rc<Vec<RoundRef>>>,
}

impl<'a, L: Library + ?Sized> InferredFeatures<'a, L> {
    pub fn new(
        library: &'a L,
        vocabulary: SectionVocabulary,
        probe_part: &str,
    ) -> Result<Self, String> {
        let mut features = InferredFeatures {
            library,
            vocabulary,
            probe: StudProbe {
                radius: 0.0,
                reach: 0.0,
            },
            units: HashMap::new(),
            rounds: HashMap::new(),
        };
        let path = resolve_reference(library, Lod::Standard, probe_part)
            .ok_or(format!("probe part {probe_part} is not in the library"))?;
        let mut issues = Vec::new();
        let males: Vec<Run> = features
            .placed(&path, &mut issues)
            .runs
            .into_iter()
            .filter(|run| run.facing > 0.0)
            .collect();
        let [run] = males.as_slice() else {
            return Err(format!(
                "probe part {probe_part} has {} outward round runs, not one",
                males.len()
            ));
        };
        let radius = features
            .vocabulary
            .size(SectionShape::Round, run.radius)
            .ok_or(format!("probe radius {} is not a section size", run.radius))?;
        let reach = features
            .vocabulary
            .length(SectionShape::Round, run.to - run.from)
            .ok_or(format!(
                "probe reach {} is not a section length",
                run.to - run.from
            ))?;
        features.probe = StudProbe { radius, reach };
        Ok(features)
    }

    pub fn infer(&mut self, path: &str) -> Inference {
        let mut inference = Inference::default();
        let borrowed = Borrowed(self.library);
        let Ok(flattened) = Flattener::new(&borrowed, Lod::Standard, &[]).flatten(path) else {
            inference.issues.push(Issue::Uninferred {
                origin: [0.0; 3],
                reason: Uninferred::Unflattened,
            });
            return inference;
        };
        let placed = self.placed(path, &mut inference.issues);
        let solid = Solid::new(&flattened.triangles, placed.surfaces);
        if solid.is_empty() {
            return inference;
        }
        let mut flanks: HashMap<(usize, i64, i64), Slab> = HashMap::new();
        for run in placed.runs.iter().filter(|run| run.facing > 0.0) {
            self.male(&solid, run, &mut flanks, &mut inference);
        }
        self.cavities(&solid, &placed.runs, &mut inference);
        let finish = |connectors: Vec<Connector>, issues: &mut Vec<Issue>| -> Vec<Connector> {
            connectors
                .iter()
                .map(|connector| finished(connector, issues))
                .collect()
        };
        inference.connectors = finish(
            std::mem::take(&mut inference.connectors),
            &mut inference.issues,
        );
        inference.off_lattice = finish(
            std::mem::take(&mut inference.off_lattice),
            &mut inference.issues,
        );
        inference
    }

    fn unit(&mut self, path: &str) -> Option<Rc<UnitRound>> {
        if let Some(found) = self.units.get(path) {
            return found.clone();
        }
        let unit = self.library.source(path).and_then(unit_round).map(Rc::new);
        self.units.insert(path.to_string(), unit.clone());
        unit
    }

    fn round_refs(&mut self, path: &str, depth: usize) -> Rc<Vec<RoundRef>> {
        if let Some(found) = self.rounds.get(path) {
            return Rc::clone(found);
        }
        let mut out = Vec::new();
        if depth <= MAX_DEPTH {
            if let Some(source) = self.library.source(path) {
                let mut certified = false;
                let mut invert_next = false;
                for line in ldraw::parse(source).lines {
                    let (matrix, reference) = match line {
                        Line::Certify(_) => {
                            certified = true;
                            continue;
                        }
                        Line::NoCertify => {
                            certified = false;
                            continue;
                        }
                        Line::InvertNext => {
                            invert_next = true;
                            continue;
                        }
                        Line::Subfile {
                            matrix, reference, ..
                        } => (matrix, reference),
                        _ => continue,
                    };
                    let inverted = std::mem::take(&mut invert_next);
                    let Some(child) = resolve_reference(self.library, Lod::Standard, &reference)
                    else {
                        continue;
                    };
                    if let Some(unit) = self.unit(&child) {
                        out.push(RoundRef {
                            unit,
                            matrix,
                            inverted,
                            certified,
                        });
                        continue;
                    }
                    for inner in self.round_refs(&child, depth + 1).iter() {
                        out.push(RoundRef {
                            unit: Rc::clone(&inner.unit),
                            matrix: matrix.then(&inner.matrix),
                            inverted: inverted ^ inner.inverted,
                            certified: certified && inner.certified,
                        });
                    }
                }
            }
        }
        let found = Rc::new(out);
        self.rounds.insert(path.to_string(), Rc::clone(&found));
        found
    }

    fn placed(&mut self, path: &str, issues: &mut Vec<Issue>) -> Placed {
        let mut surfaces = Vec::new();
        let mut walls: HashMap<WallKey, Vec<Band>> = HashMap::new();
        let mut reported: HashSet<[i64; 4]> = HashSet::new();
        for round in self.round_refs(path, 0).iter() {
            let m = &round.matrix;
            let (c0, c1, c2) = (column(m, 0), column(m, 1), column(m, 2));
            let t = [m.m[3], m.m[7], m.m[11]];
            let (rx, rz, height) = (norm(c0), norm(c2), norm(c1));
            let circular = rx > 0.0
                && height > 0.0
                && (rx - rz).abs() <= IDENTIFY_LDU
                && dot(c0, c2).abs() <= IDENTIFY_LDU * rx * rz
                && dot(c0, c1).abs() <= IDENTIFY_LDU * rx * height
                && dot(c2, c1).abs() <= IDENTIFY_LDU * rz * height;
            let Some(to_unit) = m.inverse().filter(|_| circular) else {
                continue;
            };
            let is_wall = round.unit.shape == UnitShape::Wall;
            let full = covers_circle(&round.unit.arcs, 0.0);
            let mut worth_reporting = |issues: &mut Vec<Issue>, reason: Uninferred| {
                if is_wall
                    && full
                    && self.vocabulary.size(SectionShape::Round, rx).is_some()
                    && reported.insert([key(t[0]), key(t[1]), key(t[2]), key(rx)])
                {
                    issues.push(Issue::Uninferred { origin: t, reason });
                }
            };
            let Some(axis) = aligned_axis(c1) else {
                worth_reporting(issues, Uninferred::TiltedRound { radius: rx });
                continue;
            };
            let flip = if round.inverted { -1.0 } else { 1.0 };
            let facing =
                round
                    .certified
                    .then_some(round.unit.facing)
                    .flatten()
                    .map(|f| match round.unit.shape {
                        UnitShape::Wall => f * flip,
                        UnitShape::Annulus { .. } => f * flip * c1[axis].signum(),
                    });
            let (i, j) = plan_axes(axis);
            let center = [t[i], t[j]];
            let orientation = c0[i] * c2[j] - c0[j] * c2[i];
            let map = |theta: f64| {
                let direction = [0, 1, 2].map(|k| c0[k] * theta.cos() + c2[k] * theta.sin());
                direction[j].atan2(direction[i])
            };
            let arcs: Vec<(f64, f64)> = round
                .unit
                .arcs
                .iter()
                .map(|&(low, high)| {
                    if orientation > 0.0 {
                        (map(low), map(high))
                    } else {
                        (map(high), map(low))
                    }
                })
                .collect();
            let ends = (t[axis], t[axis] + c1[axis]);
            let (from, to) = (ends.0.min(ends.1), ends.0.max(ends.1));
            let shape = match round.unit.shape {
                UnitShape::Wall => RoundShape::Wall {
                    radius: rx,
                    from,
                    to,
                },
                UnitShape::Annulus { inner, outer } => RoundShape::Annulus {
                    inner: inner * rx,
                    outer: outer * rx,
                    at: t[axis],
                },
            };
            surfaces.push(RoundSurface {
                axis,
                center,
                shape,
                full,
                arcs: arcs.clone(),
                facing,
                to_unit,
                unit_radii: match round.unit.shape {
                    UnitShape::Wall => (1.0, 1.0),
                    UnitShape::Annulus { inner, outer } => (inner, outer),
                },
            });
            if !is_wall {
                continue;
            }
            let Some(facing) = facing else {
                worth_reporting(issues, Uninferred::UnknownFacing { radius: rx });
                continue;
            };
            walls
                .entry((axis, key(center[0]), key(center[1]), key(rx), facing as i8))
                .or_default()
                .push(Band {
                    from,
                    to,
                    arcs,
                    center,
                    radius: rx,
                });
        }
        Placed {
            surfaces,
            runs: runs(walls, issues),
        }
    }

    fn keep(&self, connector: Connector, inference: &mut Inference) {
        let anchor = [
            connector.placement.m[3],
            connector.placement.m[7],
            connector.placement.m[11],
        ];
        match anchor.map(sixteenth) {
            [Some(x), Some(y), Some(z)] => inference.connectors.push(Connector {
                placement: Affine {
                    m: {
                        let mut m = connector.placement.m;
                        m[3] = x;
                        m[7] = y;
                        m[11] = z;
                        m
                    },
                },
                ..connector
            }),
            _ => {
                inference.issues.push(Issue::Uninferred {
                    origin: anchor,
                    reason: Uninferred::UnidentifiedOrigin,
                });
                inference.off_lattice.push(connector);
            }
        }
    }

    fn unidentified(
        &self,
        connector: Connector,
        size: f64,
        length: f64,
        inference: &mut Inference,
    ) {
        let m = &connector.placement.m;
        inference.issues.push(Issue::Uninferred {
            origin: [m[3], m[7], m[11]],
            reason: Uninferred::UnidentifiedSize { size, length },
        });
        inference.off_lattice.push(connector);
    }

    fn male(
        &self,
        solid: &Solid,
        run: &Run,
        flanks: &mut HashMap<(usize, i64, i64), Slab>,
        inference: &mut Inference,
    ) {
        let length = run.to - run.from;
        let from_end = Probe {
            axis: run.axis,
            inward: 1.0,
            entrance: point_on(run.axis, run.center, run.from),
            radius: run.radius,
        };
        let rooted_from = solid.stands_on(&from_end, 0.0, run.radius, 1.0);
        let rooted_to = solid.stands_on(&from_end, length, run.radius, -1.0);
        let (root, outward, caps) = match (rooted_from, rooted_to) {
            (true, true) => (run.from, 1.0, Caps::Two),
            (true, false) => (run.from, 1.0, Caps::One),
            (false, true) => (run.to, -1.0, Caps::One),
            (false, false) => return,
        };
        let flank = flanks
            .entry((run.axis, key(run.from), key(length)))
            .or_insert_with(|| {
                solid.slab(
                    run.axis,
                    1.0,
                    run.from,
                    (IDENTIFY_LDU, length - IDENTIFY_LDU),
                    RoundSurface::is_wall,
                )
            });
        if solid.enclosed(flank, run.center, RoundSurface::is_wall) {
            return;
        }
        let frame = ldraw_frame(
            point_on(run.axis, run.center, root),
            unit_axis(run.axis, -outward),
        );
        match (
            self.vocabulary.size(SectionShape::Round, run.radius),
            self.vocabulary.length(SectionShape::Round, length),
        ) {
            (Some(radius), Some(reach)) => self.keep(
                cylinder(Gender::Male, caps, radius, reach, frame, false),
                inference,
            ),
            _ => self.unidentified(
                cylinder(Gender::Male, caps, run.radius, length, frame, false),
                run.radius,
                length,
                inference,
            ),
        }
    }

    fn probe(&self, solid: &Solid, walls: &Slab, probe: &Probe) -> Probed {
        let reach = self.probe.reach;
        let floor = solid.floor(probe, probe.radius - IDENTIFY_LDU);
        if floor.depth < reach - IDENTIFY_LDU || floor.faces_probe == Some(false) {
            return Probed::Rejected;
        }
        let (i, j) = plan_axes(probe.axis);
        let center = [probe.entrance[i], probe.entrance[j]];
        let nearest = solid.nearest(
            probe,
            (IDENTIFY_LDU, reach - IDENTIFY_LDU),
            probe.radius + HALF_GRID_LDU,
        );
        if !nearest.is_finite() {
            return Probed::Rejected;
        }
        if nearest > probe.radius + IDENTIFY_LDU {
            return if solid.blocked_on_axes(walls, center, outward_wall) {
                Probed::Loose(nearest - probe.radius)
            } else {
                Probed::Rejected
            };
        }
        if !solid.enclosed(walls, center, outward_wall) {
            return Probed::Rejected;
        }
        if floor.depth.is_infinite() {
            Probed::Through
        } else {
            Probed::Blind(floor.depth)
        }
    }

    fn candidates(&self, solid: &Solid, runs: &[Run], inference: &mut Inference) -> Vec<Probe> {
        let mut bores: Vec<(Run, f64)> = Vec::new();
        for run in runs.iter().filter(|r| r.facing < 0.0) {
            match self.vocabulary.size(SectionShape::Round, run.radius) {
                Some(radius) => bores.push((*run, radius)),
                None => inference.issues.push(Issue::Uninferred {
                    origin: point_on(run.axis, run.center, run.from),
                    reason: Uninferred::UnidentifiedSize {
                        size: run.radius,
                        length: run.to - run.from,
                    },
                }),
            }
        }
        let mut probes: Vec<Probe> = Vec::new();
        let mut seen: HashSet<(usize, i8, [i64; 3], i64)> = HashSet::new();
        let mut add = |probe: Probe| {
            if seen.insert((
                probe.axis,
                probe.inward as i8,
                probe.entrance.map(key),
                key(probe.radius),
            )) {
                probes.push(probe);
            }
        };
        for plane in solid.planes() {
            let inward = -plane.outward;
            let steps = |low: f64, high: f64| {
                let first = ((low - IDENTIFY_LDU) / HALF_GRID_LDU).ceil() as i64;
                let last = ((high + IDENTIFY_LDU) / HALF_GRID_LDU).floor() as i64;
                first..=last
            };
            for a in steps(plane.min[0], plane.max[0]) {
                for b in steps(plane.min[1], plane.max[1]) {
                    let center = [a as f64 * HALF_GRID_LDU, b as f64 * HALF_GRID_LDU];
                    add(Probe {
                        axis: plane.axis,
                        inward,
                        entrance: point_on(plane.axis, center, plane.at),
                        radius: self.probe.radius,
                    });
                }
            }
            for (run, radius) in bores.iter().filter(|(r, _)| r.axis == plane.axis) {
                let inside = (0..2).all(|k| {
                    run.center[k] >= plane.min[k] - IDENTIFY_LDU
                        && run.center[k] <= plane.max[k] + IDENTIFY_LDU
                });
                if inside {
                    add(Probe {
                        axis: plane.axis,
                        inward,
                        entrance: point_on(plane.axis, run.center, plane.at),
                        radius: *radius,
                    });
                }
            }
        }
        probes
    }

    fn cavities(&self, solid: &Solid, runs: &[Run], inference: &mut Inference) {
        let mut through: Vec<Probe> = Vec::new();
        let mut slabs: HashMap<(usize, i8, i64), Slab> = HashMap::new();
        let range = (IDENTIFY_LDU, self.probe.reach - IDENTIFY_LDU);
        for probe in self.candidates(solid, runs, inference) {
            let at = probe.entrance[probe.axis];
            let slab = slabs
                .entry((probe.axis, probe.inward as i8, key(at)))
                .or_insert_with(|| solid.slab(probe.axis, probe.inward, at, range, outward_wall));
            match self.probe(solid, slab, &probe) {
                Probed::Rejected => {}
                Probed::Loose(clearance) => {
                    if probe.radius == self.probe.radius {
                        inference.issues.push(Issue::Uninferred {
                            origin: probe.entrance,
                            reason: Uninferred::LooseCavity { clearance },
                        });
                    }
                }
                Probed::Through => through.push(probe),
                Probed::Blind(depth) => {
                    let length = self
                        .vocabulary
                        .length(SectionShape::Round, depth)
                        .unwrap_or(self.probe.reach);
                    self.keep(
                        cylinder(
                            Gender::Female,
                            Caps::One,
                            probe.radius,
                            length,
                            ldraw_frame(probe.entrance, unit_axis(probe.axis, -probe.inward)),
                            false,
                        ),
                        inference,
                    );
                }
            }
        }
        self.through_holes(&through, inference);
    }

    fn through_holes(&self, through: &[Probe], inference: &mut Inference) {
        let mut used = vec![false; through.len()];
        for (index, probe) in through.iter().enumerate() {
            if used[index] {
                continue;
            }
            let (i, j) = plan_axes(probe.axis);
            let ahead = |candidate: &Probe| {
                (candidate.entrance[probe.axis] - probe.entrance[probe.axis]) * probe.inward
            };
            let partner = through
                .iter()
                .enumerate()
                .filter(|(other, candidate)| {
                    *other != index
                        && !used[*other]
                        && candidate.axis == probe.axis
                        && candidate.inward == -probe.inward
                        && key(candidate.radius) == key(probe.radius)
                        && key(candidate.entrance[i]) == key(probe.entrance[i])
                        && key(candidate.entrance[j]) == key(probe.entrance[j])
                        && ahead(candidate) > IDENTIFY_LDU
                })
                .min_by(|a, b| ahead(a.1).total_cmp(&ahead(b.1)))
                .map(|(other, _)| other);
            let Some(other) = partner else {
                inference.issues.push(Issue::Uninferred {
                    origin: probe.entrance,
                    reason: Uninferred::UnpairedThroughCavity {
                        radius: probe.radius,
                    },
                });
                continue;
            };
            used[index] = true;
            used[other] = true;
            let far = through[other].entrance;
            let span = ahead(&through[other]);
            let middle = [0, 1, 2].map(|k| (probe.entrance[k] + far[k]) / 2.0);
            let frame = ldraw_frame(middle, unit_axis(probe.axis, 1.0));
            match self.vocabulary.length(SectionShape::Round, span) {
                Some(length) => self.keep(
                    cylinder(
                        Gender::Female,
                        Caps::None,
                        probe.radius,
                        length,
                        frame,
                        true,
                    ),
                    inference,
                ),
                None => self.unidentified(
                    cylinder(Gender::Female, Caps::None, probe.radius, span, frame, true),
                    probe.radius,
                    span,
                    inference,
                ),
            }
        }
    }
}

fn runs(walls: HashMap<WallKey, Vec<Band>>, issues: &mut Vec<Issue>) -> Vec<Run> {
    let mut runs = Vec::new();
    for ((axis, _, _, _, facing), mut pieces) in walls {
        pieces.sort_by(|a, b| a.from.total_cmp(&b.from).then(a.to.total_cmp(&b.to)));
        let mut bands: Vec<Band> = Vec::new();
        for piece in pieces {
            match bands.last_mut() {
                Some(band)
                    if (band.from - piece.from).abs() <= IDENTIFY_LDU
                        && (band.to - piece.to).abs() <= IDENTIFY_LDU =>
                {
                    band.arcs.extend(piece.arcs);
                }
                _ => bands.push(piece),
            }
        }
        let mut current: Option<Run> = None;
        for band in bands {
            if !covers_circle(&band.arcs, IDENTIFY_LDU / band.radius) {
                if facing < 0 && arc_length(&band.arcs) > std::f64::consts::PI {
                    issues.push(Issue::Uninferred {
                        origin: point_on(axis, band.center, band.from),
                        reason: Uninferred::OpenArc {
                            radius: band.radius,
                        },
                    });
                }
                continue;
            }
            match current.as_mut() {
                Some(run) if band.from <= run.to + IDENTIFY_LDU => run.to = run.to.max(band.to),
                _ => {
                    runs.extend(current.take());
                    current = Some(Run {
                        axis,
                        center: band.center,
                        radius: band.radius,
                        from: band.from,
                        to: band.to,
                        facing: f64::from(facing),
                    });
                }
            }
        }
        runs.extend(current);
    }
    runs.sort_by(|a, b| {
        (a.axis, a.center, a.from, a.radius, a.facing)
            .partial_cmp(&(b.axis, b.center, b.from, b.radius, b.facing))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    runs
}

fn outward_wall(surface: &RoundSurface) -> bool {
    surface.is_wall() && surface.facing == Some(1.0)
}

fn cylinder(
    gender: Gender,
    caps: Caps,
    radius: f64,
    length: f64,
    placement: Affine,
    center: bool,
) -> Connector {
    Connector {
        source: Source::Inferred,
        id: None,
        group: None,
        shape: Shape::Cylinder {
            gender,
            sections: vec![Section {
                shape: SectionShape::Round,
                radius,
                length,
            }],
            caps,
            center,
            slide: false,
            scaling: Scaling::Fixed,
        },
        placement,
        grid: None,
    }
}
