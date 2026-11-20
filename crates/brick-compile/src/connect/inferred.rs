use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::circle::{covers_circle as covers_exactly, span, ArcSpan, Bearing, Direction};
use crate::exact::{Decimal, Exact, ExactAffine};
use crate::flatten::{resolve_reference, Flattener, Library, Lod};
use crate::ldraw::{self, ExactNumbers, Line, Winding};
use crate::pieces::{PieceMap, PieceNumbering, NO_PIECE};
use crate::trig::{cos, planar_length, sin};

use super::axle::{AxleFound, AxleMiss, AxleProbe};
use super::meta::{parse_metas, Meta};
use super::profile::Profile;
use super::solid::{plan_axes, Probe, RoundShape, RoundSurface, Slab, Solid, HALF_GRID_LDU};
use super::{
    finished, joined_pieces, Caps, Connector, Gender, Issue, MatingFace, Scaling, Section,
    SectionShape, Shape, Source, Status,
};
use crate::identify::{
    decimal_sixteenths, identified, identifies, sixteenth, sixteenths, IDENTIFY_LDU,
    SIXTEENTHS_PER_LDU,
};

const MAX_DEPTH: usize = 64;
const KEY_STEPS: f64 = 1.0 / IDENTIFY_LDU;
const CIRCLE_POINTS: usize = 3;
const LATTICE_STEPS: [[f64; 2]; 8] = [
    [HALF_GRID_LDU, 0.0],
    [-HALF_GRID_LDU, 0.0],
    [0.0, HALF_GRID_LDU],
    [0.0, -HALF_GRID_LDU],
    [HALF_GRID_LDU, HALF_GRID_LDU],
    [HALF_GRID_LDU, -HALF_GRID_LDU],
    [-HALF_GRID_LDU, HALF_GRID_LDU],
    [-HALF_GRID_LDU, -HALF_GRID_LDU],
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Uninferred {
    UnidentifiedSize { size: f64, length: f64 },
    UnidentifiedOrigin,
    LooseCavity { clearance: f64 },
    SlidingCavity,
    OffCentreCavity { offset: f64 },
    EntranceInsideCavity,
    SleeveOfReceptor,
    UnpairedThroughCavity { radius: f64 },
    MergedIntoRejectedProbe { survivor: Vec3 },
    TiltedRound { radius: f64 },
    UnknownFacing { radius: f64 },
    OpenArc { radius: f64 },
    Unflattened,
    Oversized { squares: f64 },
    SlabBoundaryWithoutExactPlane { distance: f64 },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inference {
    pub connectors: Vec<Connector>,
    pub off_lattice: Vec<Connector>,
    pub issues: Vec<Issue>,
}

const SHAPE_CODES: [(SectionShape, &str); 5] = [
    (SectionShape::Round, "R"),
    (SectionShape::Axle, "A"),
    (SectionShape::Square, "S"),
    (SectionShape::FlexibleEnd, "_L"),
    (SectionShape::FlexibleStart, "L_"),
];
const GENDER_CODES: [(Gender, &str); 2] = [(Gender::Male, "M"), (Gender::Female, "F")];

fn shape_code(shape: SectionShape) -> &'static str {
    SHAPE_CODES
        .iter()
        .find_map(|&(s, code)| (s == shape).then_some(code))
        .unwrap_or_default()
}

fn shape_of(code: &str) -> Option<SectionShape> {
    SHAPE_CODES
        .iter()
        .find_map(|&(shape, c)| (c == code).then_some(shape))
}

fn gender_code(gender: Gender) -> &'static str {
    GENDER_CODES
        .iter()
        .find_map(|&(g, code)| (g == gender).then_some(code))
        .unwrap_or_default()
}

fn gender_of(code: &str) -> Option<Gender> {
    GENDER_CODES
        .iter()
        .find_map(|&(gender, c)| (c == code).then_some(gender))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SectionVocabulary {
    sizes: Vec<(Gender, SectionShape, f64)>,
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
                    Shape::Cylinder {
                        gender, sections, ..
                    } => {
                        for section in sections {
                            sizes.push((gender, section.shape, section.radius));
                            lengths.push((section.shape, section.length));
                        }
                    }
                    Shape::Clip { radius, length, .. } => {
                        sizes.push((Gender::Female, SectionShape::Round, radius));
                        lengths.push((SectionShape::Round, length));
                    }
                    Shape::Finger { .. } | Shape::Generic { .. } => {}
                }
            }
        }
        Self::sorted(sizes, lengths)
    }

    fn sorted(
        mut sizes: Vec<(Gender, SectionShape, f64)>,
        mut lengths: Vec<(SectionShape, f64)>,
    ) -> Self {
        sizes.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)).then(a.2.total_cmp(&b.2)));
        sizes.dedup();
        lengths.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        lengths.dedup();
        SectionVocabulary { sizes, lengths }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "sizes": self
                .sizes
                .iter()
                .map(|&(gender, shape, size)| json!({
                    "gender": gender_code(gender),
                    "shape": shape_code(shape),
                    "size": size,
                }))
                .collect::<Vec<_>>(),
            "lengths": self
                .lengths
                .iter()
                .map(|&(shape, length)| json!({ "shape": shape_code(shape), "length": length }))
                .collect::<Vec<_>>(),
        })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let entries = |key: &str| {
            value[key]
                .as_array()
                .ok_or(format!("a section vocabulary needs a {key} array"))
        };
        let number = |entry: &Value, key: &str| {
            entry[key]
                .as_f64()
                .ok_or(format!("vocabulary entry {entry} needs a numeric {key}"))
        };
        let shape = |entry: &Value| {
            entry["shape"]
                .as_str()
                .and_then(shape_of)
                .ok_or(format!("vocabulary entry {entry} names no section shape"))
        };
        let sizes = entries("sizes")?
            .iter()
            .map(|entry| {
                let gender = entry["gender"]
                    .as_str()
                    .and_then(gender_of)
                    .ok_or(format!("vocabulary entry {entry} names no gender"))?;
                Ok((gender, shape(entry)?, number(entry, "size")?))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let lengths = entries("lengths")?
            .iter()
            .map(|entry| Ok((shape(entry)?, number(entry, "length")?)))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self::sorted(sizes, lengths))
    }

    fn unique(mut found: impl Iterator<Item = f64>) -> Option<f64> {
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    fn size(&self, gender: Gender, shape: SectionShape, measured: f64) -> Option<f64> {
        let mate = match gender {
            Gender::Male => Gender::Female,
            Gender::Female => Gender::Male,
        };
        Self::unique(
            self.sizes
                .iter()
                .filter(|(g, s, v)| *g == mate && *s == shape && identifies(v - measured))
                .map(|(_, _, v)| *v),
        )
    }

    fn length(&self, shape: SectionShape, measured: f64) -> Option<f64> {
        sixteenth(measured).or_else(|| {
            Self::unique(
                self.lengths
                    .iter()
                    .filter(|(s, v)| *s == shape && identifies(v - measured))
                    .map(|(_, v)| *v),
            )
        })
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
    arcs: Option<Vec<ArcSpan>>,
    facing: Option<f64>,
}

#[derive(Clone)]
struct RoundRef {
    unit: Rc<UnitRound>,
    matrix: Affine,
    exact: Option<Rc<ExactAffine>>,
    inverted: bool,
    certified: bool,
    trail: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq)]
struct Run {
    axis: usize,
    center: [f64; 2],
    exact_center: Direction,
    radius: f64,
    from: f64,
    to: f64,
    ends: Option<(Exact, Exact)>,
    facing: f64,
    pieces: Vec<u16>,
}

#[derive(Clone, Debug, PartialEq)]
struct Band {
    from: f64,
    to: f64,
    ends: Option<(Exact, Exact)>,
    arcs: Option<Vec<ArcSpan>>,
    center: [f64; 2],
    exact_center: Option<Direction>,
    radius: f64,
    pieces: Vec<u16>,
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
    Sliding,
    OffCentre(f64),
    Rejected,
}

struct Placed {
    surfaces: Vec<RoundSurface>,
    runs: Vec<Run>,
}

struct Prepared {
    solid: Option<Solid>,
    runs: Vec<Run>,
    issues: Vec<Issue>,
}

struct MaleCandidate {
    exact_anchor: Option<ExactPoint>,
    connector: Connector,
    identified: bool,
    tip: (usize, i8, i64, i64, i64),
}

type Column = (usize, i8, i64, i64, i64);

type AxleEnds = [Option<(Probe, f64)>; 2];

fn column_of(probe: &Probe) -> Column {
    let (i, j) = plan_axes(probe.axis);
    (
        probe.axis,
        probe.inward as i8,
        key(probe.entrance[i]),
        key(probe.entrance[j]),
        key(probe.radius),
    )
}

fn depth_along(probe: &Probe) -> f64 {
    probe.entrance[probe.axis] * probe.inward
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
    (0..3)
        .find(|&k| (0..3).all(|j| j == k || identifies(unit[j])) && identifies(unit[k].abs() - 1.0))
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
    let file = ldraw::parse_exact(source);
    let mut certified = false;
    let mut winding = Winding::Ccw;
    let mut polygons: Vec<(Vec<Vec3>, bool, Winding)> = Vec::new();
    let mut exact_polygons: Vec<Option<Vec<[Decimal; 3]>>> = Vec::new();
    for (line, exact) in file.lines.iter().zip(&file.exact) {
        let exact_points = match exact {
            ExactNumbers::Points(points) => Some(points.clone()),
            _ => None,
        };
        match line {
            Line::Certify(w) => {
                certified = true;
                winding = *w;
            }
            Line::NoCertify => certified = false,
            Line::SetWinding(w) => winding = *w,
            Line::Subfile { .. } => return None,
            Line::Triangle { points, .. } => {
                polygons.push((points.to_vec(), certified, winding));
                exact_polygons.push(exact_points);
            }
            Line::Quad { points, .. } => {
                polygons.push((points.to_vec(), certified, winding));
                exact_polygons.push(exact_points);
            }
            Line::Edge { .. } | Line::InvertNext => {}
        }
    }
    if polygons.is_empty() {
        return None;
    }
    let radius = |p: &Vec3| planar_length(p[0], p[2]);
    let level = |p: &Vec3, y: f64| identifies(p[1] - y);
    let all = || polygons.iter().flat_map(|(points, _, _)| points.iter());
    let wall = polygons.iter().all(|(points, _, _)| {
        points.iter().all(|p| identifies(radius(p) - 1.0))
            && points.iter().all(|p| level(p, 0.0) || level(p, 1.0))
            && points.iter().any(|p| level(p, 0.0))
            && points.iter().any(|p| level(p, 1.0))
    });
    let shape = if wall {
        UnitShape::Wall
    } else if all().all(|p| level(p, 0.0)) {
        let inner = all().map(radius).fold(f64::INFINITY, f64::min);
        let outer = all().map(radius).fold(0.0, f64::max);
        let hollow = !identifies(inner);
        let circle = if hollow { inner } else { outer };
        let on_circle = all().filter(|p| identifies(radius(p) - circle)).count();
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
    let mut arcs = Some(Vec::new());
    let mut all_certified = true;
    for ((points, certified, winding), exact) in polygons.iter().zip(&exact_polygons) {
        let normal = polygon_normal(points, *winding);
        let count = points.len() as f64;
        let centroid = [0, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / count);
        facings.push(match shape {
            UnitShape::Wall => (normal[0] * centroid[0] + normal[2] * centroid[1]).signum(),
            UnitShape::Annulus { .. } => normal[1].signum(),
        });
        all_certified &= *certified;
        let rim: Option<Vec<Direction>> = exact.as_ref().map(|exact| {
            points
                .iter()
                .zip(exact)
                .filter(|(p, _)| !identifies(radius(p)))
                .map(|(_, e)| [e[0].exact(), e[2].exact()])
                .collect()
        });
        match (&mut arcs, rim) {
            (Some(found), Some(rim)) => {
                found.extend(span(rim.into_iter().map(Bearing::Raw).collect()))
            }
            _ => arcs = None,
        }
    }
    let first = facings[0];
    let agree = facings.iter().all(|f| *f == first);
    Some(UnitRound {
        shape,
        arcs,
        facing: (agree && all_certified).then_some(first),
    })
}

fn arc_length(arcs: &[ArcSpan]) -> f64 {
    use std::f64::consts::TAU;
    arcs.iter()
        .map(|(low, high)| (low.angle(), high.angle()))
        .map(|(low, high)| {
            if high >= low {
                high - low
            } else {
                high - low + TAU
            }
        })
        .sum()
}

struct AxleSizes {
    probe: AxleProbe,
    female: f64,
    male: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Openness {
    Open,
    NotOpen,
    Unmeasurable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntranceClosure {
    Open,
    Closed,
    Unmeasurable,
}

fn face_probe(face: &MatingFace) -> Option<Probe> {
    let origin = [face.origin[0], -face.origin[1], -face.origin[2]].map(|c| c + 0.0);
    let axis = [face.axis[0], -face.axis[1], -face.axis[2]];
    let k = aligned_axis(axis)?;
    let section = face.sections.first()?;
    Some(Probe {
        axis: k,
        inward: -axis[k].signum(),
        entrance: origin,
        radius: section.size,
    })
}

pub struct InferredFeatures<'a, L: Library + ?Sized> {
    library: &'a L,
    vocabulary: SectionVocabulary,
    probe: StudProbe,
    axle: Option<AxleSizes>,
    units: HashMap<String, Option<Rc<UnitRound>>>,
    rounds: HashMap<String, Rc<Vec<RoundRef>>>,
    prepared: Option<(String, Rc<Prepared>)>,
    numbering: PieceNumbering<'a, L>,
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
            axle: None,
            units: HashMap::new(),
            rounds: HashMap::new(),
            prepared: None,
            numbering: PieceNumbering::new(library),
        };
        let path = resolve_reference(library, Lod::Standard, probe_part)
            .ok_or(format!("probe part {probe_part} is not in the library"))?;
        let mut issues = Vec::new();
        let males: Vec<Run> = features
            .placed(&path, &PieceMap::default(), &mut issues)
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
            .size(Gender::Male, SectionShape::Round, run.radius)
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

    pub fn with_axle_probe(mut self, probe_part: &str) -> Result<Self, String> {
        let profile = axle_section(self.library, probe_part)?;
        let size = |gender: Gender| {
            self.vocabulary
                .size(gender, SectionShape::Axle, profile.radius())
                .ok_or(format!(
                    "axle probe radius {} is not an axle section size",
                    profile.radius()
                ))
        };
        let (female, male) = (size(Gender::Female)?, size(Gender::Male)?);
        self.axle = Some(AxleSizes {
            probe: AxleProbe::new(profile)?,
            female,
            male,
        });
        Ok(self)
    }

    fn prepare(&mut self, path: &str) -> Rc<Prepared> {
        if let Some((cached, prepared)) = &self.prepared {
            if cached == path {
                return Rc::clone(prepared);
            }
        }
        let borrowed = Borrowed(self.library);
        let pieces = self.numbering.map(path);
        let mut flattener = Flattener::new(&borrowed, Lod::Standard, &[])
            .numbering_pieces(&pieces)
            .exact_geometry();
        let flattened = flattener.flatten(path);
        let mut issues: Vec<Issue> = flattener
            .malformed()
            .iter()
            .cloned()
            .map(Issue::from)
            .collect();
        let malformed = !issues.is_empty();
        let prepared = match flattened {
            Err(_) => {
                issues.push(Issue::Uninferred {
                    origin: [0.0; 3],
                    reason: Uninferred::Unflattened,
                });
                Prepared {
                    solid: None,
                    runs: Vec::new(),
                    issues,
                }
            }
            Ok(_) if malformed => Prepared {
                solid: None,
                runs: Vec::new(),
                issues,
            },
            Ok(flattened) => {
                let placed = self.placed(path, &pieces, &mut issues);
                let solid = Solid::new(
                    &flattened.triangles,
                    &flattened.triangle_pieces(),
                    &flattened.exact,
                    placed.surfaces,
                );
                issues.extend(solid.largest_oversized().map(|(origin, squares)| {
                    Issue::Uninferred {
                        origin,
                        reason: Uninferred::Oversized { squares },
                    }
                }));
                Prepared {
                    solid: (!solid.is_empty()).then_some(solid),
                    runs: placed.runs,
                    issues,
                }
            }
        };
        let prepared = Rc::new(prepared);
        self.prepared = Some((path.to_string(), Rc::clone(&prepared)));
        prepared
    }

    fn face_openness(&self, solid: &Solid, face: &MatingFace) -> Openness {
        let Some(probe) = face_probe(face) else {
            return Openness::Unmeasurable;
        };
        let floor = solid.floor(&probe, probe.radius);
        if !floor.depth.is_finite() {
            Openness::Unmeasurable
        } else if floor.depth >= self.probe.reach - IDENTIFY_LDU && floor.faces_probe != Some(false)
        {
            Openness::Open
        } else {
            Openness::NotOpen
        }
    }

    fn candidate_openness(&self, solid: &Solid, candidate: &Connector) -> Openness {
        let Ok(faces) = super::mating_faces(candidate) else {
            return Openness::Unmeasurable;
        };
        faces
            .iter()
            .map(|face| self.face_openness(solid, face))
            .fold(Openness::Open, |worst, next| match (worst, next) {
                (Openness::Unmeasurable, _) | (_, Openness::Unmeasurable) => Openness::Unmeasurable,
                (Openness::NotOpen, _) | (_, Openness::NotOpen) => Openness::NotOpen,
                (Openness::Open, Openness::Open) => Openness::Open,
            })
    }

    pub fn openness(&mut self, path: &str, candidate: &Connector) -> Openness {
        let prepared = self.prepare(path);
        let Some(solid) = &prepared.solid else {
            return Openness::Unmeasurable;
        };
        self.candidate_openness(solid, candidate)
    }

    pub fn entrance_closure(&mut self, path: &str, face: &MatingFace) -> EntranceClosure {
        let prepared = self.prepare(path);
        let Some(solid) = &prepared.solid else {
            return EntranceClosure::Unmeasurable;
        };
        let Some(probe) = face_probe(face) else {
            return EntranceClosure::Unmeasurable;
        };
        let Some(plane) = sixteenths(probe.entrance[probe.axis]) else {
            return EntranceClosure::Unmeasurable;
        };
        let floor = solid.floor(&probe, probe.radius);
        if floor.faces_probe == Some(false) {
            return EntranceClosure::Closed;
        }
        if !floor.depth.is_finite() {
            return EntranceClosure::Open;
        }
        let floor_plane = probe.entrance[probe.axis] + probe.inward * floor.depth;
        if sixteenths(floor_plane) == Some(plane) {
            EntranceClosure::Closed
        } else if floor.faces_probe == Some(true) {
            EntranceClosure::Open
        } else {
            EntranceClosure::Unmeasurable
        }
    }

    pub fn open(&mut self, path: &str, candidates: Vec<Connector>) -> Inference {
        let prepared = self.prepare(path);
        let mut inference = Inference::default();
        let Some(solid) = &prepared.solid else {
            return inference;
        };
        let open: Vec<Connector> = candidates
            .into_iter()
            .filter(|candidate| self.candidate_openness(solid, candidate) == Openness::Open)
            .map(|candidate| Connector {
                source: Source::Inferred,
                status: Status::Unverified,
                ..candidate
            })
            .collect();
        for connector in open {
            self.keep(connector, None, &mut inference);
        }
        inference
    }

    pub fn infer(&mut self, path: &str) -> Inference {
        let prepared = self.prepare(path);
        let mut inference = Inference {
            issues: prepared.issues.clone(),
            ..Inference::default()
        };
        let Some(solid) = &prepared.solid else {
            return inference;
        };
        let mut flanks: HashMap<FlankKey, Slab> = HashMap::new();
        let males: Vec<MaleCandidate> = prepared
            .runs
            .iter()
            .filter(|run| run.facing > 0.0)
            .filter_map(|run| self.male(solid, run, &mut flanks))
            .collect();
        let mut flank_keys: Vec<&FlankKey> = flanks.keys().collect();
        flank_keys.sort();
        for flank in flank_keys {
            report_unanchored(&flanks[flank], &mut inference);
        }
        let mouths = self.cavities(solid, &prepared.runs, &mut inference);
        self.axles(solid, &mut inference);
        for male in males {
            if mouths.contains(&male.tip) {
                let m = &male.connector.placement.m;
                inference.issues.push(Issue::Uninferred {
                    origin: [m[3], m[7], m[11]],
                    reason: Uninferred::SleeveOfReceptor,
                });
                continue;
            }
            if male.identified {
                self.keep(male.connector, male.exact_anchor, &mut inference);
            } else {
                let m = &male.connector.placement.m;
                let (size, length) = match &male.connector.shape {
                    Shape::Cylinder { sections, .. } => (sections[0].radius, sections[0].length),
                    _ => (0.0, 0.0),
                };
                inference.issues.push(Issue::Uninferred {
                    origin: [m[3], m[7], m[11]],
                    reason: Uninferred::UnidentifiedSize { size, length },
                });
                inference.off_lattice.push(male.connector);
            }
        }
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
                let mut ordinal: u32 = 0;
                let file = ldraw::parse_exact(source);
                for (line, exact) in file.lines.into_iter().zip(file.exact) {
                    let exact_matrix = match exact {
                        ExactNumbers::Matrix(numbers) => {
                            Some(Rc::new(ExactAffine::from_ldraw(&numbers)))
                        }
                        _ => None,
                    };
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
                    let here = ordinal;
                    ordinal += 1;
                    let Some(child) = resolve_reference(self.library, Lod::Standard, &reference)
                    else {
                        continue;
                    };
                    if let Some(unit) = self.unit(&child) {
                        out.push(RoundRef {
                            unit,
                            matrix,
                            exact: exact_matrix,
                            inverted,
                            certified,
                            trail: vec![here],
                        });
                        continue;
                    }
                    for inner in self.round_refs(&child, depth + 1).iter() {
                        out.push(RoundRef {
                            unit: Rc::clone(&inner.unit),
                            matrix: matrix.then(&inner.matrix),
                            exact: match (&exact_matrix, &inner.exact) {
                                (Some(outer), Some(inner)) => Some(Rc::new(outer.then(inner))),
                                _ => None,
                            },
                            inverted: inverted ^ inner.inverted,
                            certified: certified && inner.certified,
                            trail: std::iter::once(here)
                                .chain(inner.trail.iter().copied())
                                .collect(),
                        });
                    }
                }
            }
        }
        let found = Rc::new(out);
        self.rounds.insert(path.to_string(), Rc::clone(&found));
        found
    }

    fn placed(&mut self, path: &str, pieces: &PieceMap, issues: &mut Vec<Issue>) -> Placed {
        let mut surfaces = Vec::new();
        let mut walls: HashMap<WallKey, Vec<Band>> = HashMap::new();
        let mut reported: HashSet<[i64; 4]> = HashSet::new();
        for round in self.round_refs(path, 0).iter() {
            let piece = pieces.piece(&round.trail);
            let m = &round.matrix;
            let (c0, c1, c2) = (column(m, 0), column(m, 1), column(m, 2));
            let t = [m.m[3], m.m[7], m.m[11]];
            let (rx, rz, height) = (norm(c0), norm(c2), norm(c1));
            let circular = rx > 0.0
                && rz > 0.0
                && height > 0.0
                && identifies(rx - rz)
                && identifies(dot(c0, c2) / (rx * rz))
                && identifies(dot(c0, c1) / (rx * height))
                && identifies(dot(c2, c1) / (rz * height));
            if !circular {
                continue;
            }
            let is_wall = round.unit.shape == UnitShape::Wall;
            let full = round
                .unit
                .arcs
                .as_ref()
                .is_some_and(|arcs| covers_exactly(arcs));
            let mut worth_reporting = |issues: &mut Vec<Issue>, reason: Uninferred| {
                if is_wall
                    && full
                    && [Gender::Male, Gender::Female]
                        .iter()
                        .any(|g| self.vocabulary.size(*g, SectionShape::Round, rx).is_some())
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
            let arcs: Option<Vec<ArcSpan>> = round
                .exact
                .as_ref()
                .zip(round.unit.arcs.as_ref())
                .map(|(matrix, unit_arcs)| {
                    let (c0, c2) = (matrix.column(0), matrix.column(2));
                    let map = |end: &Bearing| -> Bearing {
                        let Bearing::Raw(d) = end else {
                            return end.clone();
                        };
                        Bearing::identify(
                            [
                                c0[i].mul(&d[0]).add(&c2[i].mul(&d[1])),
                                c0[j].mul(&d[0]).add(&c2[j].mul(&d[1])),
                            ],
                            1.0,
                        )
                    };
                    let turning = c0[i].mul(&c2[j]).sub(&c0[j].mul(&c2[i])).sign();
                    unit_arcs
                        .iter()
                        .map(|(low, high)| {
                            if turning == Ordering::Greater {
                                (map(low), map(high))
                            } else {
                                (map(high), map(low))
                            }
                        })
                        .collect()
                });
            let exact_center: Option<Direction> = round.exact.as_ref().map(|matrix| {
                let t = matrix.translation();
                [t[i].clone(), t[j].clone()]
            });
            let exact_ends: Option<(Exact, Exact)> = round.exact.as_ref().map(|matrix| {
                let start = matrix.translation()[axis].clone();
                let end = start.add(&matrix.column(1)[axis]);
                exact_order(start, end)
            });
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
                piece,
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
                    ends: exact_ends,
                    arcs,
                    center,
                    exact_center,
                    radius: rx,
                    pieces: vec![piece],
                });
        }
        Placed {
            surfaces,
            runs: runs(walls, issues),
        }
    }

    fn keep(
        &self,
        connector: Connector,
        exact_anchor: Option<ExactPoint>,
        inference: &mut Inference,
    ) {
        let anchor = [
            connector.placement.m[3],
            connector.placement.m[7],
            connector.placement.m[11],
        ];
        match [0, 1, 2].map(|k| lattice_coordinate(anchor[k], exact_anchor.as_ref().map(|e| &e[k])))
        {
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
        flanks: &mut HashMap<FlankKey, Slab>,
    ) -> Option<MaleCandidate> {
        let length = run.to - run.from;
        let from_end = Probe {
            axis: run.axis,
            inward: 1.0,
            entrance: point_on(run.axis, run.center, run.from),
            radius: run.radius,
        };
        let rooted_from = solid.stands_on(&from_end, 0.0, run.radius, 1.0);
        let rooted_to = solid.stands_on(&from_end, length, run.radius, -1.0);
        let (root, tip, outward, caps) = match (rooted_from, rooted_to) {
            (true, true) => (run.from, run.to, 1.0, Caps::Two),
            (true, false) => (run.from, run.to, 1.0, Caps::One),
            (false, true) => (run.to, run.from, -1.0, Caps::One),
            (false, false) => return None,
        };
        let flank = flanks
            .entry((run.axis, key(run.from), key(length), exact_key(&run.ends)))
            .or_insert_with(|| {
                solid.slab(
                    run.axis,
                    1.0,
                    run.from,
                    (IDENTIFY_LDU, length - IDENTIFY_LDU),
                    run.ends.clone(),
                    RoundSurface::is_wall,
                )
            });
        if solid.enclosed(flank, run.center, &run.exact_center, RoundSurface::is_wall) {
            return None;
        }
        let frame = ldraw_frame(
            point_on(run.axis, run.center, root),
            unit_axis(run.axis, -outward),
        );
        let exact_anchor = run.ends.as_ref().map(|(low, high)| {
            let root = if outward > 0.0 { low } else { high };
            exact_point_on(run.axis, &run.exact_center, root)
        });
        let tip_key = (
            run.axis,
            outward as i8,
            key(run.center[0]),
            key(run.center[1]),
            key(tip),
        );
        let sizes = (
            self.vocabulary
                .size(Gender::Male, SectionShape::Round, run.radius),
            self.vocabulary.length(SectionShape::Round, length),
        );
        Some(match sizes {
            (Some(radius), Some(reach)) => MaleCandidate {
                exact_anchor,
                connector: cylinder(Gender::Male, caps, radius, reach, frame, false, &run.pieces),
                identified: true,
                tip: tip_key,
            },
            _ => MaleCandidate {
                exact_anchor: None,
                connector: cylinder(
                    Gender::Male,
                    caps,
                    run.radius,
                    length,
                    frame,
                    false,
                    &run.pieces,
                ),
                identified: false,
                tip: tip_key,
            },
        })
    }

    fn probe(
        &self,
        solid: &Solid,
        walls: &Slab,
        probe: &Probe,
        exact_center: &Direction,
    ) -> Probed {
        let reach = self.probe.reach;
        let Some(floor) = solid.floor_beyond(probe, probe.radius, reach - IDENTIFY_LDU) else {
            return Probed::Rejected;
        };
        if floor.faces_probe == Some(false) {
            return Probed::Rejected;
        }
        let (i, j) = plan_axes(probe.axis);
        let center = [probe.entrance[i], probe.entrance[j]];
        let nearest = solid.nearest(
            probe,
            (IDENTIFY_LDU, reach - IDENTIFY_LDU),
            plan_reach(probe.radius),
        );
        if !nearest.is_finite() {
            return Probed::Rejected;
        }
        if nearest > probe.radius + IDENTIFY_LDU {
            return if solid.blocked_on_axes(walls, center, exact_center, outward_wall) {
                Probed::Loose(nearest - probe.radius)
            } else {
                Probed::Rejected
            };
        }
        let range = (IDENTIFY_LDU, reach - IDENTIFY_LDU);
        if solid.bore_continues_outward(probe)
            || !solid.enclosed(walls, center, exact_center, outward_wall)
        {
            return Probed::Rejected;
        }
        if !solid.confined(probe, range, &LATTICE_STEPS) {
            return Probed::Sliding;
        }
        if let Some(offset) = off_centre(&solid.travel(probe, range, &LATTICE_STEPS)) {
            return Probed::OffCentre(offset);
        }
        if floor.depth.is_infinite() {
            Probed::Through
        } else {
            Probed::Blind(floor.depth)
        }
    }

    fn candidates(&self, solid: &Solid, runs: &[Run], inference: &mut Inference) -> Candidates {
        let mut bores: Vec<(Run, f64)> = Vec::new();
        for run in runs.iter().filter(|r| r.facing < 0.0) {
            match self
                .vocabulary
                .size(Gender::Female, SectionShape::Round, run.radius)
            {
                Some(radius) => bores.push((run.clone(), radius)),
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
        let mut centers: Vec<ExactEntrance> = Vec::new();
        let mut on_axis: Vec<bool> = Vec::new();
        let mut merged: Vec<Vec<(Probe, ExactEntrance)>> = Vec::new();
        let mut seen: HashMap<(usize, i8, [i64; 3], i64), usize> = HashMap::new();
        let mut add = |probe: Probe, center: ExactEntrance, bore: bool| {
            let slot = (
                probe.axis,
                probe.inward as i8,
                probe.entrance.map(key),
                key(probe.radius),
            );
            match seen.get(&slot) {
                Some(&survivor) if probes[survivor].entrance != probe.entrance => {
                    if bore && !on_axis[survivor] {
                        on_axis[survivor] = true;
                        let displaced = (
                            std::mem::replace(&mut probes[survivor], probe),
                            std::mem::replace(&mut centers[survivor], center),
                        );
                        merged[survivor].push(displaced);
                    } else {
                        merged[survivor].push((probe, center));
                    }
                }
                Some(_) => {}
                None => {
                    seen.insert(slot, probes.len());
                    probes.push(probe);
                    centers.push(center);
                    on_axis.push(bore);
                    merged.push(Vec::new());
                }
            }
        };
        for plane in solid.planes() {
            let inward = -plane.outward;
            for center in solid.grid(&plane, plan_reach(self.probe.radius)) {
                add(
                    Probe {
                        axis: plane.axis,
                        inward,
                        entrance: point_on(plane.axis, center, plane.at),
                        radius: self.probe.radius,
                    },
                    (center.map(Exact::from_f64), plane.exact_at.clone()),
                    false,
                );
            }
            for (run, radius) in bores.iter().filter(|(r, _)| r.axis == plane.axis) {
                let inside = (0..2).all(|k| {
                    run.center[k] >= plane.min[k] - IDENTIFY_LDU
                        && run.center[k] <= plane.max[k] + IDENTIFY_LDU
                });
                if inside {
                    add(
                        Probe {
                            axis: plane.axis,
                            inward,
                            entrance: point_on(plane.axis, run.center, plane.at),
                            radius: *radius,
                        },
                        (run.exact_center.clone(), plane.exact_at.clone()),
                        true,
                    );
                }
            }
        }
        Candidates {
            probes,
            centers,
            merged,
        }
    }

    fn cavities(
        &self,
        solid: &Solid,
        runs: &[Run],
        inference: &mut Inference,
    ) -> HashSet<(usize, i8, i64, i64, i64)> {
        let mut through: Vec<(Probe, Option<ExactPoint>)> = Vec::new();
        let mut blind: Vec<(Probe, f64, Option<ExactPoint>)> = Vec::new();
        let mut slabs: HashMap<(usize, i8, i64, Option<String>), Slab> = HashMap::new();
        let exact_reach = sixteenths(self.probe.reach).map(|_| Exact::from_f64(self.probe.reach));
        let range = (IDENTIFY_LDU, self.probe.reach - IDENTIFY_LDU);
        let Candidates {
            probes: candidates,
            centers,
            merged,
        } = self.candidates(solid, runs, inference);
        let mut columns: HashMap<Column, Vec<usize>> = HashMap::new();
        for (index, probe) in candidates.iter().enumerate() {
            columns.entry(column_of(probe)).or_default().push(index);
        }
        for ((probe, (exact_center, exact_at)), merged_into) in
            candidates.iter().zip(&centers).zip(&merged)
        {
            let at = probe.entrance[probe.axis];
            let ends = exact_at
                .clone()
                .zip(exact_reach.clone())
                .map(|(near, reach)| {
                    let far = if probe.inward > 0.0 {
                        near.add(&reach)
                    } else {
                        near.sub(&reach)
                    };
                    (near, far)
                });
            let slab = slabs
                .entry((
                    probe.axis,
                    probe.inward as i8,
                    key(at),
                    exact_at.as_ref().map(Exact::canonical),
                ))
                .or_insert_with(|| {
                    let slab = solid.slab(probe.axis, probe.inward, at, range, ends, outward_wall);
                    report_unanchored(&slab, inference);
                    slab
                });
            match self.probe(solid, slab, probe, exact_center) {
                Probed::Rejected => {
                    for (lost, (lost_center, _)) in merged_into {
                        if !matches!(self.probe(solid, slab, lost, lost_center), Probed::Rejected) {
                            inference.issues.push(Issue::Uninferred {
                                origin: lost.entrance,
                                reason: Uninferred::MergedIntoRejectedProbe {
                                    survivor: probe.entrance,
                                },
                            });
                        }
                    }
                }
                Probed::Loose(clearance) => {
                    if probe.radius == self.probe.radius {
                        inference.issues.push(Issue::Uninferred {
                            origin: probe.entrance,
                            reason: Uninferred::LooseCavity { clearance },
                        });
                    }
                }
                Probed::Sliding => inference.issues.push(Issue::Uninferred {
                    origin: probe.entrance,
                    reason: Uninferred::SlidingCavity,
                }),
                Probed::OffCentre(offset) => inference.issues.push(Issue::Uninferred {
                    origin: probe.entrance,
                    reason: Uninferred::OffCentreCavity { offset },
                }),
                Probed::Through => {
                    through.push((*probe, exact_entrance(probe, exact_center, exact_at)))
                }
                Probed::Blind(depth) => {
                    blind.push((*probe, depth, exact_entrance(probe, exact_center, exact_at)))
                }
            }
        }
        let mut mouths = HashSet::new();
        for (probe, depth, exact_anchor) in blind {
            let opens_further_out = columns[&column_of(&probe)].iter().any(|&other| {
                let outer = &candidates[other];
                let separation = depth_along(&probe) - depth_along(outer);
                if separation <= IDENTIFY_LDU {
                    return false;
                }
                solid
                    .floor_beyond(outer, outer.radius, separation - IDENTIFY_LDU)
                    .is_some_and(|floor| floor.faces_probe != Some(false))
            });
            if probe.radius == self.probe.radius {
                let (i, j) = plan_axes(probe.axis);
                mouths.insert((
                    probe.axis,
                    -probe.inward as i8,
                    key(probe.entrance[i]),
                    key(probe.entrance[j]),
                    key(probe.entrance[probe.axis]),
                ));
            }
            if opens_further_out {
                inference.issues.push(Issue::Uninferred {
                    origin: probe.entrance,
                    reason: Uninferred::EntranceInsideCavity,
                });
                continue;
            }
            let length = self
                .vocabulary
                .length(SectionShape::Round, depth)
                .unwrap_or(self.probe.reach);
            let pieces = solid.contributors(&probe, range, Some(depth));
            self.keep(
                cylinder(
                    Gender::Female,
                    Caps::One,
                    probe.radius,
                    length,
                    ldraw_frame(probe.entrance, unit_axis(probe.axis, -probe.inward)),
                    false,
                    &pieces,
                ),
                exact_anchor,
                inference,
            );
        }
        self.through_holes(solid, range, &through, inference);
        mouths
    }

    fn axles(&self, solid: &Solid, inference: &mut Inference) {
        let Some(axle) = &self.axle else {
            return;
        };
        let (found, missed) = axle.probe.find(solid);
        for (origin, miss) in missed {
            inference.issues.push(Issue::Uninferred {
                origin,
                reason: match miss {
                    AxleMiss::OffCentre { offset } => Uninferred::OffCentreCavity { offset },
                    AxleMiss::Sliding => Uninferred::SlidingCavity,
                },
            });
        }
        let mut through: HashMap<(usize, i64, i64), AxleEnds> = HashMap::new();
        let mut bare: HashMap<(usize, i64, i64), AxleEnds> = HashMap::new();
        let end_of =
            |lines: &mut HashMap<(usize, i64, i64), AxleEnds>, probe: Probe, angle: f64| {
                let (i, j) = plan_axes(probe.axis);
                let side = usize::from(probe.inward < 0.0);
                let ends = lines
                    .entry((probe.axis, key(probe.entrance[i]), key(probe.entrance[j])))
                    .or_default();
                if ends[side].is_none_or(|(kept, _)| depth_along(&probe) < depth_along(&kept)) {
                    ends[side] = Some((probe, angle));
                }
            };
        for feature in found {
            match feature {
                AxleFound::Hole {
                    probe,
                    angle,
                    depth: Some(depth),
                } => self.keep_axle(
                    axle_cylinder(
                        Gender::Female,
                        Caps::One,
                        [axle.female, depth],
                        axle_frame(probe.entrance, probe.axis, -probe.inward, angle),
                        false,
                        &solid.contributors(&probe, (0.0, depth), Some(depth)),
                    ),
                    inference,
                ),
                AxleFound::Hole {
                    probe,
                    angle,
                    depth: None,
                } => end_of(&mut through, probe, angle),
                AxleFound::Axle {
                    probe,
                    angle,
                    length: None,
                } => end_of(&mut bare, probe, angle),
                AxleFound::Axle {
                    probe,
                    angle,
                    length: Some(length),
                } => {
                    let mut root = probe.entrance;
                    root[probe.axis] += probe.inward * length;
                    self.keep_axle(
                        axle_cylinder(
                            Gender::Male,
                            Caps::One,
                            [axle.male, length],
                            axle_frame(root, probe.axis, probe.inward, angle),
                            false,
                            &solid.contributors(&probe, (0.0, length), None),
                        ),
                        inference,
                    );
                }
            }
        }
        let mut lines: Vec<(Gender, AxleEnds)> = by_key(through)
            .into_iter()
            .map(|e| (Gender::Female, e))
            .chain(by_key(bare).into_iter().map(|e| (Gender::Male, e)))
            .collect();
        lines.sort_by(|a, b| {
            let first = |e: &AxleEnds| e.iter().flatten().next().map(|(p, _)| p.entrance);
            first(&a.1)
                .partial_cmp(&first(&b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for (gender, ends) in lines {
            let [Some((rising, angle)), Some((falling, _))] = ends else {
                for (probe, _) in ends.iter().flatten() {
                    inference.issues.push(Issue::Uninferred {
                        origin: probe.entrance,
                        reason: Uninferred::UnpairedThroughCavity {
                            radius: probe.radius,
                        },
                    });
                }
                continue;
            };
            let (low, high) = (rising.entrance[rising.axis], falling.entrance[falling.axis]);
            if high <= low + IDENTIFY_LDU {
                for probe in [rising, falling] {
                    inference.issues.push(Issue::Uninferred {
                        origin: probe.entrance,
                        reason: Uninferred::UnpairedThroughCavity {
                            radius: probe.radius,
                        },
                    });
                }
                continue;
            }
            let middle = [0, 1, 2].map(|k| (rising.entrance[k] + falling.entrance[k]) / 2.0);
            let size = match gender {
                Gender::Female => axle.female,
                Gender::Male => axle.male,
            };
            let span = (0.0, high - low);
            self.keep_axle(
                axle_cylinder(
                    gender,
                    Caps::None,
                    [size, high - low],
                    axle_frame(middle, rising.axis, 1.0, angle),
                    true,
                    &joined_pieces(
                        &solid.contributors(&rising, span, None),
                        &solid.contributors(&falling, span, None),
                    ),
                ),
                inference,
            );
        }
    }

    fn keep_axle(&self, mut connector: Connector, inference: &mut Inference) {
        let Shape::Cylinder { sections, .. } = &mut connector.shape else {
            return;
        };
        let (size, measured) = (sections[0].radius, sections[0].length);
        match self.vocabulary.length(SectionShape::Axle, measured) {
            Some(length) => {
                sections[0].length = length;
                self.keep(connector, None, inference);
            }
            None => self.unidentified(connector, size, measured, inference),
        }
    }

    fn through_holes(
        &self,
        solid: &Solid,
        range: (f64, f64),
        through: &[(Probe, Option<ExactPoint>)],
        inference: &mut Inference,
    ) {
        let mut lines: HashMap<(usize, i64, i64, i64), [Option<Probe>; 2]> = HashMap::new();
        let mut exact_entrances: HashMap<([i64; 3], i64), ExactPoint> = HashMap::new();
        for (probe, exact) in through {
            if let Some(exact) = exact {
                exact_entrances
                    .entry((probe.entrance.map(key), key(probe.radius)))
                    .or_insert_with(|| exact.clone());
            }
            let (i, j) = plan_axes(probe.axis);
            let side = usize::from(probe.inward < 0.0);
            let ends = lines
                .entry((
                    probe.axis,
                    key(probe.entrance[i]),
                    key(probe.entrance[j]),
                    key(probe.radius),
                ))
                .or_default();
            let outer = ends[side].is_none_or(|kept| depth_along(probe) < depth_along(&kept));
            if outer {
                ends[side] = Some(*probe);
            }
        }
        let mut lines: Vec<[Option<Probe>; 2]> = by_key(lines);
        lines.sort_by(|a, b| {
            let first = |e: &[Option<Probe>; 2]| e.iter().flatten().next().map(|p| p.entrance);
            first(a)
                .partial_cmp(&first(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for ends in lines {
            let [Some(rising), Some(falling)] = ends else {
                for probe in ends.iter().flatten() {
                    inference.issues.push(Issue::Uninferred {
                        origin: probe.entrance,
                        reason: Uninferred::UnpairedThroughCavity {
                            radius: probe.radius,
                        },
                    });
                }
                continue;
            };
            let (low, high) = (rising.entrance[rising.axis], falling.entrance[falling.axis]);
            if high <= low + IDENTIFY_LDU {
                for probe in [rising, falling] {
                    inference.issues.push(Issue::Uninferred {
                        origin: probe.entrance,
                        reason: Uninferred::UnpairedThroughCavity {
                            radius: probe.radius,
                        },
                    });
                }
                continue;
            }
            let span = high - low;
            let middle = [0, 1, 2].map(|k| (rising.entrance[k] + falling.entrance[k]) / 2.0);
            let frame = ldraw_frame(middle, unit_axis(rising.axis, 1.0));
            let pieces = joined_pieces(
                &solid.contributors(&rising, range, None),
                &solid.contributors(&falling, range, None),
            );
            let exact_of = |probe: &Probe| {
                exact_entrances
                    .get(&(probe.entrance.map(key), key(probe.radius)))
                    .cloned()
            };
            let exact_middle = exact_of(&rising)
                .zip(exact_of(&falling))
                .map(|(a, b)| exact_midpoint(&a, &b));
            match self.vocabulary.length(SectionShape::Round, span) {
                Some(length) => self.keep(
                    cylinder(
                        Gender::Female,
                        Caps::None,
                        rising.radius,
                        length,
                        frame,
                        true,
                        &pieces,
                    ),
                    exact_middle,
                    inference,
                ),
                None => self.unidentified(
                    cylinder(
                        Gender::Female,
                        Caps::None,
                        rising.radius,
                        span,
                        frame,
                        true,
                        &pieces,
                    ),
                    rising.radius,
                    span,
                    inference,
                ),
            }
        }
    }
}

fn plan_reach(radius: f64) -> f64 {
    radius + HALF_GRID_LDU + IDENTIFY_LDU
}

pub(super) fn axle_section<L: Library + ?Sized>(
    library: &L,
    probe_part: &str,
) -> Result<Profile, String> {
    let path = resolve_reference(library, Lod::Standard, probe_part)
        .ok_or(format!("axle probe {probe_part} is not in the library"))?;
    let borrowed = Borrowed(library);
    let flattened = Flattener::new(&borrowed, Lod::Standard, &[])
        .flatten(&path)
        .map_err(|e| format!("axle probe {probe_part}: {e:?}"))?;
    let level = flattened
        .triangles
        .first()
        .map(|t| t.points[0][1])
        .ok_or(format!("axle probe {probe_part} has no faces"))?;
    if flattened
        .triangles
        .iter()
        .flat_map(|t| t.points.iter())
        .any(|p| !identifies(p[1] - level))
    {
        return Err(format!("axle probe {probe_part} is not a flat section"));
    }
    let triangles: Vec<[[f64; 2]; 3]> = flattened
        .triangles
        .iter()
        .map(|t| t.points.map(|p| [p[0], p[2]]))
        .collect();
    Profile::from_triangles(&triangles, IDENTIFY_LDU)
        .map_err(|e| format!("axle probe {probe_part}: {e}"))
}

pub(super) fn by_key<K: Ord, V>(map: HashMap<K, V>) -> Vec<V> {
    let mut entries: Vec<(K, V)> = map.into_iter().collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries.into_iter().map(|(_, value)| value).collect()
}

fn runs(walls: HashMap<WallKey, Vec<Band>>, issues: &mut Vec<Issue>) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut walls: Vec<(WallKey, Vec<Band>)> = walls.into_iter().collect();
    walls.sort_by_key(|(key, _)| *key);
    for ((axis, _, _, _, facing), mut pieces) in walls {
        pieces.sort_by(|a, b| a.from.total_cmp(&b.from).then(a.to.total_cmp(&b.to)));
        let mut bands: Vec<Band> = Vec::new();
        for piece in pieces {
            match bands.last_mut() {
                Some(band)
                    if identifies(band.from - piece.from) && identifies(band.to - piece.to) =>
                {
                    match (&mut band.arcs, piece.arcs) {
                        (Some(arcs), Some(more)) => arcs.extend(more),
                        _ => band.arcs = None,
                    }
                    band.ends = spanning(band.ends.take(), piece.ends);
                    band.pieces = joined_pieces(&band.pieces, &piece.pieces);
                }
                _ => bands.push(piece),
            }
        }
        let mut current: Option<Run> = None;
        for band in bands {
            let covered = band.arcs.as_ref().is_some_and(|arcs| covers_exactly(arcs));
            let exact_center = band.exact_center.clone().filter(|_| covered);
            let Some(exact_center) = exact_center else {
                let open = band.arcs.as_deref().map_or(0.0, arc_length);
                if facing < 0 && open > std::f64::consts::PI {
                    issues.push(Issue::Uninferred {
                        origin: point_on(axis, band.center, band.from),
                        reason: Uninferred::OpenArc {
                            radius: band.radius,
                        },
                    });
                }
                continue;
            };
            match current.as_mut() {
                Some(run) if band.from <= run.to + IDENTIFY_LDU => {
                    run.to = run.to.max(band.to);
                    run.ends = spanning(run.ends.take(), band.ends);
                    run.pieces = joined_pieces(&run.pieces, &band.pieces);
                }
                _ => {
                    runs.extend(current.take());
                    current = Some(Run {
                        axis,
                        center: band.center,
                        exact_center,
                        radius: band.radius,
                        from: band.from,
                        to: band.to,
                        ends: band.ends,
                        facing: f64::from(facing),
                        pieces: band.pieces,
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

fn report_unanchored(slab: &Slab, inference: &mut Inference) {
    if let Some(boundary) = &slab.unanchored_boundary {
        inference.issues.push(Issue::Uninferred {
            origin: boundary.origin,
            reason: Uninferred::SlabBoundaryWithoutExactPlane {
                distance: boundary.distance,
            },
        });
    }
}

type ExactPoint = [Exact; 3];

fn exact_point_on(axis: usize, center: &Direction, along: &Exact) -> ExactPoint {
    let (i, j) = plan_axes(axis);
    let mut point = [Exact::zero(), Exact::zero(), Exact::zero()];
    point[axis] = along.clone();
    point[i] = center[0].clone();
    point[j] = center[1].clone();
    point
}

fn exact_entrance(probe: &Probe, center: &Direction, at: &Option<Exact>) -> Option<ExactPoint> {
    at.as_ref().map(|at| exact_point_on(probe.axis, center, at))
}

fn exact_midpoint(a: &ExactPoint, b: &ExactPoint) -> ExactPoint {
    let half = Decimal::parse("0.5")
        .expect("one half prints as a decimal")
        .exact();
    [0, 1, 2].map(|k| a[k].add(&b[k]).mul(&half))
}

fn lattice_coordinate(measured: f64, exact: Option<&Exact>) -> Option<f64> {
    let per_ldu = f64::from(SIXTEENTHS_PER_LDU);
    match exact
        .and_then(Exact::small_decimal)
        .map(|(units, scale)| decimal_sixteenths(units, scale))
    {
        Some(Ok(steps)) => steps.map(|steps| steps as f64 / per_ldu + 0.0),
        Some(Err(_)) | None => sixteenth(measured),
    }
}

fn exact_order(a: Exact, b: Exact) -> (Exact, Exact) {
    if a.compare(&b) == Ordering::Greater {
        (b, a)
    } else {
        (a, b)
    }
}

fn spanning(a: Option<(Exact, Exact)>, b: Option<(Exact, Exact)>) -> Option<(Exact, Exact)> {
    let ((a_low, a_high), (b_low, b_high)) = (a?, b?);
    Some((exact_order(a_low, b_low).0, exact_order(a_high, b_high).1))
}

type FlankKey = (usize, i64, i64, Option<[String; 2]>);

type ExactEntrance = (Direction, Option<Exact>);

struct Candidates {
    probes: Vec<Probe>,
    centers: Vec<ExactEntrance>,
    merged: Vec<Vec<(Probe, ExactEntrance)>>,
}

fn exact_key(ends: &Option<(Exact, Exact)>) -> Option<[String; 2]> {
    ends.as_ref()
        .map(|(low, high)| [low.canonical(), high.canonical()])
}

fn outward_wall(surface: &RoundSurface) -> bool {
    surface.is_wall() && surface.facing == Some(1.0)
}

fn off_centre(travel: &[f64]) -> Option<f64> {
    let opposite = |a: &[f64; 2], b: &[f64; 2]| a[0] == -b[0] && a[1] == -b[1];
    let worst = LATTICE_STEPS
        .iter()
        .enumerate()
        .flat_map(|(i, step)| {
            LATTICE_STEPS
                .iter()
                .enumerate()
                .skip(i + 1)
                .filter(move |(_, other)| opposite(step, other))
                .map(move |(j, _)| (travel[i] - travel[j]).abs() / 2.0)
        })
        .fold(0.0, f64::max);
    (!identifies(worst)).then_some(worst)
}

fn cylinder(
    gender: Gender,
    caps: Caps,
    radius: f64,
    length: f64,
    placement: Affine,
    center: bool,
    pieces: &[u16],
) -> Connector {
    sectioned(
        gender,
        caps,
        Section {
            shape: SectionShape::Round,
            radius,
            length,
        },
        placement,
        [center, false],
        pieces,
    )
}

fn axle_cylinder(
    gender: Gender,
    caps: Caps,
    [radius, length]: [f64; 2],
    placement: Affine,
    center: bool,
    pieces: &[u16],
) -> Connector {
    sectioned(
        gender,
        caps,
        Section {
            shape: SectionShape::Axle,
            radius,
            length,
        },
        placement,
        [center, true],
        pieces,
    )
}

fn sectioned(
    gender: Gender,
    caps: Caps,
    section: Section,
    placement: Affine,
    [center, slide]: [bool; 2],
    pieces: &[u16],
) -> Connector {
    Connector {
        source: Source::Inferred,
        status: Status::Unverified,
        id: None,
        group: None,
        shape: Shape::Cylinder {
            gender,
            sections: vec![section],
            caps,
            center,
            slide,
            scaling: Scaling::Fixed,
        },
        placement,
        grid: None,
        pieces: if pieces.is_empty() {
            vec![NO_PIECE]
        } else {
            pieces.to_vec()
        },
    }
}

fn axle_frame(origin: Vec3, axis: usize, toward: f64, angle: f64) -> Affine {
    let (i, j) = plan_axes(axis);
    let mut x = [0.0; 3];
    x[i] = cos(angle);
    x[j] = sin(angle);
    let y = unit_axis(axis, toward);
    let z = [
        x[1] * y[2] - x[2] * y[1],
        x[2] * y[0] - x[0] * y[2],
        x[0] * y[1] - x[1] * y[0],
    ];
    Affine::from_ldraw(
        origin,
        [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
    )
}
