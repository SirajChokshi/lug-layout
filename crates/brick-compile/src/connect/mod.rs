mod axle;
mod depth_bands;
mod faces;
mod inferred;
mod meta;
mod primitive;
mod profile;
mod records;
mod shadow;
mod solid;

use std::collections::{HashMap, HashSet};

use crate::affine::{Affine, Vec3};
use crate::flatten::Library;
use crate::lattice::{non_finite, unplaceable, Malformation, MalformedGeometry};

pub use faces::{
    mating_faces, FaceSection, MatingFace, Unreadable, AXLE, CAP_FAR, CAP_ROOT, FLARE_JOINS_NEXT,
    FLARE_JOINS_PREVIOUS, ROUND, SQUARE,
};
pub use inferred::{Inference, InferredFeatures, SectionVocabulary, Uninferred};
pub use meta::{parse_metas, Meta, MetaError, ParsedMeta};
pub use primitive::{PrimitiveConnectors, PrimitiveTable};
pub use records::{
    is_connectivity, record_json, source_code, status_code, PartRecords, TierRecord,
};
pub use shadow::{ShadowPatches, ShadowSnaps};

const UNIT_SCALE_TOLERANCE: f64 = 1e-3;
const ROTATION_DUST: f64 = 1e-9;
const SAME_PLACE_LDU: f64 = 0.0005;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Source {
    Shadow,
    Primitive,
    Inferred,
    Patch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Status {
    Verified,
    Unverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Gender {
    Male,
    Female,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SectionShape {
    Round,
    Axle,
    Square,
    FlexibleEnd,
    FlexibleStart,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Section {
    pub shape: SectionShape,
    pub radius: f64,
    pub length: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Caps {
    None,
    One,
    Two,
    A,
    B,
}

impl Caps {
    pub fn closed_ends(self, gender: Gender) -> (bool, bool) {
        match (self, gender) {
            (Caps::None, _) => (false, false),
            (Caps::Two, _) => (true, true),
            (Caps::A, _) | (Caps::One, Gender::Male) => (true, false),
            (Caps::B, _) | (Caps::One, Gender::Female) => (false, true),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scaling {
    Fixed,
    AlongAxis,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Bounding {
    Sphere { radius: f64 },
    Cube { size: f64 },
    Box { size: [f64; 3] },
    Cylinder { radius: f64, length: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GenericMatch {
    Size,
    Group,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Cylinder {
        gender: Gender,
        sections: Vec<Section>,
        caps: Caps,
        center: bool,
        slide: bool,
        scaling: Scaling,
    },
    Clip {
        radius: f64,
        length: f64,
        center: bool,
        slide: bool,
    },
    Finger {
        first: Gender,
        widths: Vec<f64>,
        radius: Option<f64>,
        center: bool,
    },
    Generic {
        gender: Gender,
        bounding: Bounding,
        matching: Option<GenericMatch>,
        free_placement: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub counts: [u32; 3],
    pub centered: [bool; 3],
    pub steps: [f64; 3],
}

impl Grid {
    pub fn offsets(&self) -> Vec<Vec3> {
        let along = |axis: usize| -> Vec<f64> {
            let count = self.counts[axis];
            let start = if self.centered[axis] {
                -(f64::from(count) - 1.0) * self.steps[axis] / 2.0
            } else {
                0.0
            };
            (0..count)
                .map(|i| start + f64::from(i) * self.steps[axis] + 0.0)
                .collect()
        };
        let (xs, ys, zs) = (along(0), along(1), along(2));
        let mut out = Vec::with_capacity(xs.len() * ys.len() * zs.len());
        for &x in &xs {
            for &y in &ys {
                for &z in &zs {
                    out.push([x, y, z]);
                }
            }
        }
        out
    }
}

pub(crate) fn grid_cell(connector: &Connector, offset: Vec3) -> Connector {
    let at = connector.placement.apply(offset);
    let mut m = connector.placement.m;
    m[3] = at[0] + 0.0;
    m[7] = at[1] + 0.0;
    m[11] = at[2] + 0.0;
    Connector {
        placement: Affine { m },
        grid: None,
        ..connector.clone()
    }
}

pub(crate) fn placeable_cells(connector: &Connector) -> (Vec<Connector>, Vec<Malformation>) {
    let Some(grid) = connector.grid else {
        return match unplaceable(&connector.placement.m) {
            Some(malformation) => (Vec::new(), vec![malformation]),
            None => (vec![connector.clone()], Vec::new()),
        };
    };
    let mut kept = Vec::new();
    let mut findings = Vec::new();
    for offset in grid.offsets() {
        let cell = grid_cell(connector, offset);
        match unplaceable(&cell.placement.m) {
            Some(malformation) if !findings.contains(&malformation) => findings.push(malformation),
            Some(_) => {}
            None => kept.push(cell),
        }
    }
    if findings.is_empty() {
        (vec![connector.clone()], findings)
    } else {
        (kept, findings)
    }
}

pub(crate) fn malformed_shape(connector: &Connector) -> Option<Malformation> {
    let steps = connector.grid.map_or([0.0; 3], |grid| grid.steps);
    if non_finite(&steps) {
        return Some(Malformation::NonFinite);
    }
    let sizes: Vec<f64> = match &connector.shape {
        Shape::Cylinder { sections, .. } => sections
            .iter()
            .flat_map(|section| [section.radius, section.length])
            .collect(),
        Shape::Clip { radius, length, .. } => vec![*radius, *length],
        Shape::Finger { widths, radius, .. } => widths.iter().copied().chain(*radius).collect(),
        Shape::Generic { bounding, .. } => match bounding {
            Bounding::Sphere { radius } => vec![*radius],
            Bounding::Cube { size } => vec![*size],
            Bounding::Box { size } => size.to_vec(),
            Bounding::Cylinder { radius, length } => vec![*radius, *length],
        },
    };
    unplaceable(&sizes)
}

pub(crate) fn linear_part(placement: &Affine) -> [f64; 9] {
    let m = &placement.m;
    [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
}

#[derive(Clone, Debug, PartialEq)]
pub struct Connector {
    pub source: Source,
    pub status: Status,
    pub id: Option<String>,
    pub group: Option<String>,
    pub shape: Shape,
    pub placement: Affine,
    pub grid: Option<Grid>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Issue {
    Meta {
        file: String,
        error: MetaError,
    },
    IgnoredParameter {
        file: String,
        parameter: String,
    },
    UnresolvedInclude {
        file: String,
        reference: String,
    },
    TooDeep {
        file: String,
    },
    MalformedGeometry {
        file: String,
        malformation: Malformation,
    },
    ScaledFixedShape {
        source: Source,
        id: Option<String>,
        scale: Vec3,
    },
    UnpairedHoleEnd {
        primitive: String,
        origin: Vec3,
    },
    UndrawnHoleInterior {
        primitive: String,
        origin: Vec3,
    },
    SectionDisagreement {
        origin: Vec3,
        kept: (Source, Shape),
        lower: (Source, Shape),
    },
    Uninferred {
        origin: Vec3,
        reason: Uninferred,
    },
}

impl From<MalformedGeometry> for Issue {
    fn from(found: MalformedGeometry) -> Self {
        Issue::MalformedGeometry {
            file: found.file,
            malformation: found.malformation,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extraction {
    pub connectors: Vec<Connector>,
    pub suppressed: Vec<Connector>,
    pub off_lattice: Vec<Connector>,
    pub curated: bool,
    pub issues: Vec<Issue>,
}

pub(crate) fn column(m: &Affine, c: usize) -> Vec3 {
    [m.m[c], m.m[4 + c], m.m[8 + c]]
}

fn translation(m: &Affine) -> Vec3 {
    [m.m[3], m.m[7], m.m[11]]
}

fn length(v: Vec3) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn clean(value: f64) -> f64 {
    let rounded = value.round();
    if (value - rounded).abs() <= ROTATION_DUST {
        rounded + 0.0
    } else {
        value + 0.0
    }
}

fn placed(connector: &Connector, at: &Affine) -> Connector {
    Connector {
        placement: at.then(&connector.placement),
        ..connector.clone()
    }
}

fn finished(connector: &Connector, issues: &mut Vec<Issue>) -> Connector {
    let p = &connector.placement;
    let scale = [0, 1, 2].map(|c| length(column(p, c)));
    let mut m = p.m;
    for (c, factor) in scale.iter().enumerate() {
        if *factor > 0.0 {
            for row in 0..3 {
                m[row * 4 + c] = clean(m[row * 4 + c] / factor);
            }
        }
    }
    let unit = scale
        .iter()
        .all(|factor| (factor - 1.0).abs() <= UNIT_SCALE_TOLERANCE);
    let mut shape = connector.shape.clone();
    match &mut shape {
        Shape::Cylinder {
            sections,
            scaling: Scaling::AlongAxis,
            ..
        } => {
            for section in sections.iter_mut() {
                section.length *= scale[1];
            }
        }
        _ if !unit => issues.push(Issue::ScaledFixedShape {
            source: connector.source,
            id: connector.id.clone(),
            scale,
        }),
        _ => {}
    }
    let up = Affine { m }.ldraw_to_y_up();
    Connector {
        shape,
        placement: Affine {
            m: up.m.map(|v| v + 0.0),
        },
        grid: connector.grid.map(|grid| Grid {
            steps: [
                grid.steps[0] * scale[0] + 0.0,
                -grid.steps[1] * scale[1] + 0.0,
                -grid.steps[2] * scale[2] + 0.0,
            ],
            ..grid
        }),
        ..connector.clone()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Slot {
    Lattice {
        polarity: u8,
        sixteenths: [i64; 3],
        axis: u8,
    },
    Free {
        polarity: u8,
        origin: [i64; 3],
        axis: [i64; 3],
    },
}

const FREE_ORIGIN_STEPS_PER_LDU: f64 = 1e3;
const FREE_AXIS_STEPS: f64 = 1e6;

fn direction_code(axis: Vec3) -> Option<u8> {
    (0..3).find_map(|k| {
        let aligned = (0..3).all(|j| j == k || axis[j].abs() <= SAME_PLACE_LDU);
        let sign = axis[k];
        match aligned && (sign.abs() - 1.0).abs() <= SAME_PLACE_LDU {
            true if sign > 0.0 => Some(2 * k as u8),
            true => Some(2 * k as u8 + 1),
            false => None,
        }
    })
}

fn polarity(shape: &Shape) -> u8 {
    match shape {
        Shape::Cylinder {
            gender: Gender::Male,
            ..
        } => 0,
        Shape::Cylinder {
            gender: Gender::Female,
            ..
        } => 1,
        Shape::Clip { .. } => 2,
        Shape::Finger {
            first: Gender::Male,
            ..
        } => 3,
        Shape::Finger {
            first: Gender::Female,
            ..
        } => 4,
        Shape::Generic {
            gender: Gender::Male,
            ..
        } => 5,
        Shape::Generic {
            gender: Gender::Female,
            ..
        } => 6,
    }
}

fn symmetric(shape: &Shape) -> bool {
    matches!(
        shape,
        Shape::Cylinder { center: true, .. }
            | Shape::Clip { center: true, .. }
            | Shape::Finger { center: true, .. }
    )
}

fn slots(connector: &Connector) -> Vec<Slot> {
    let mut axis = column(&connector.placement, 1);
    let first = axis.iter().copied().find(|c| c.abs() > SAME_PLACE_LDU);
    if symmetric(&connector.shape) && first.is_some_and(|c| c < 0.0) {
        axis = axis.map(|c| -c);
    }
    let polarity = polarity(&connector.shape);
    let code = direction_code(axis);
    connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets())
        .into_iter()
        .map(|offset| {
            let origin = connector.placement.apply(offset);
            let lattice = [0, 1, 2].map(|k| solid::sixteenths(origin[k]));
            match (lattice, code) {
                ([Some(x), Some(y), Some(z)], Some(axis)) => Slot::Lattice {
                    polarity,
                    sixteenths: [x, y, z],
                    axis,
                },
                _ => Slot::Free {
                    polarity,
                    origin: origin.map(|c| (c * FREE_ORIGIN_STEPS_PER_LDU).round() as i64),
                    axis: axis.map(|c| (c * FREE_AXIS_STEPS).round() as i64),
                },
            }
        })
        .collect()
}

fn same_sections(a: &Shape, b: &Shape) -> bool {
    match (a, b) {
        (Shape::Cylinder { sections: x, .. }, Shape::Cylinder { sections: y, .. }) => {
            x.len() == y.len()
                && x.iter().zip(y).all(|(p, q)| {
                    p.shape == q.shape
                        && (p.radius - q.radius).abs() <= SAME_PLACE_LDU
                        && (p.length - q.length).abs() <= SAME_PLACE_LDU
                })
        }
        _ => a == b,
    }
}

#[derive(Clone, Copy)]
enum Occupant {
    Tier(usize),
    Cleared,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum SlotKey {
    Anchor(Slot),
    Face(Slot),
}

fn anchor_keys(connector: &Connector) -> Vec<SlotKey> {
    slots(connector).into_iter().map(SlotKey::Anchor).collect()
}

fn face_slot(face: &MatingFace) -> Slot {
    let polarity = match face.gender {
        Gender::Male => 0,
        Gender::Female => 1,
    };
    let lattice = face.origin.map(solid::sixteenths);
    match (lattice, direction_code(face.axis)) {
        ([Some(x), Some(y), Some(z)], Some(axis)) => Slot::Lattice {
            polarity,
            sixteenths: [x, y, z],
            axis,
        },
        _ => Slot::Free {
            polarity,
            origin: face
                .origin
                .map(|c| (c * FREE_ORIGIN_STEPS_PER_LDU).round() as i64),
            axis: face.axis.map(|c| (c * FREE_AXIS_STEPS).round() as i64),
        },
    }
}

fn anchor_and_face_keys(connector: &Connector) -> Vec<SlotKey> {
    let mut keys = anchor_keys(connector);
    if let Ok(faces) = mating_faces(connector) {
        keys.extend(faces.iter().map(|face| SlotKey::Face(face_slot(face))));
    }
    keys
}

fn merge(
    extraction: &mut Extraction,
    candidates: Vec<Connector>,
    keys: fn(&Connector) -> Vec<SlotKey>,
) {
    let mut occupied: HashMap<SlotKey, Occupant> = HashMap::new();
    for (index, connector) in extraction.connectors.iter().enumerate() {
        for key in keys(connector) {
            occupied.entry(key).or_insert(Occupant::Tier(index));
        }
    }
    for connector in &extraction.suppressed {
        for key in keys(connector) {
            occupied.entry(key).or_insert(Occupant::Cleared);
        }
    }
    for candidate in candidates {
        let candidate_keys = keys(&candidate);
        let holder = candidate_keys
            .iter()
            .find_map(|key| occupied.get(key).copied());
        match holder {
            Some(Occupant::Tier(index)) => {
                let kept = &extraction.connectors[index];
                if !same_sections(&kept.shape, &candidate.shape) {
                    extraction.issues.push(Issue::SectionDisagreement {
                        origin: translation(&candidate.placement),
                        kept: (kept.source, kept.shape.clone()),
                        lower: (candidate.source, candidate.shape.clone()),
                    });
                }
            }
            Some(Occupant::Cleared) => {}
            None => {
                let index = extraction.connectors.len();
                for key in candidate_keys {
                    occupied.insert(key, Occupant::Tier(index));
                }
                extraction.connectors.push(candidate);
            }
        }
    }
}

pub struct ConnectorExtractor<'a, L: Library + ?Sized, S: Library + ?Sized> {
    shadow: ShadowSnaps<'a, L, S>,
    primitives: PrimitiveConnectors<'a, L>,
    inferred: InferredFeatures<'a, L>,
}

impl<'a, L: Library + ?Sized, S: Library + ?Sized> ConnectorExtractor<'a, L, S> {
    pub fn new(
        shadow: ShadowSnaps<'a, L, S>,
        primitives: PrimitiveConnectors<'a, L>,
        inferred: InferredFeatures<'a, L>,
    ) -> Self {
        ConnectorExtractor {
            shadow,
            primitives,
            inferred,
        }
    }

    pub fn extract(&mut self, path: &str) -> Extraction {
        let mut extraction = self.shadow.snaps(path);
        let (primitive, issues) = self.primitives.connectors(path);
        extraction.issues.extend(issues);
        merge(&mut extraction, primitive, anchor_keys);
        let candidates = self.primitives.where_open(path);
        let opened = self.inferred.open(path, candidates);
        extraction.issues.extend(opened.issues);
        extraction.off_lattice.extend(opened.off_lattice);
        merge(&mut extraction, opened.connectors, anchor_and_face_keys);
        let inferred = self.inferred.infer(path);
        let held: HashSet<Slot> = extraction
            .connectors
            .iter()
            .filter_map(|c| mating_faces(c).ok())
            .flatten()
            .filter(|face| face.gender == Gender::Female)
            .map(|face| {
                face_slot(&MatingFace {
                    axis: [0.0; 3],
                    ..face
                })
            })
            .collect();
        extraction
            .issues
            .extend(inferred.issues.into_iter().filter(|issue| match issue {
                Issue::Uninferred {
                    origin,
                    reason:
                        Uninferred::LooseCavity { .. }
                        | Uninferred::SlidingCavity
                        | Uninferred::OffCentreCavity { .. },
                } => {
                    let entrance = MatingFace {
                        source: Source::Inferred,
                        status: Status::Unverified,
                        group: None,
                        gender: Gender::Female,
                        origin: [origin[0], -origin[1], -origin[2]].map(|c| c + 0.0),
                        axis: [0.0; 3],
                        sixteenths: None,
                        direction: None,
                        sections: Vec::new(),
                        caps: 0,
                        slide: false,
                    };
                    !held.contains(&face_slot(&entrance))
                }
                _ => true,
            }));
        extraction.off_lattice.extend(inferred.off_lattice);
        merge(&mut extraction, inferred.connectors, anchor_and_face_keys);
        let mut reported: Vec<Issue> = Vec::new();
        extraction.issues.retain(|issue| match issue {
            Issue::MalformedGeometry { .. } if reported.contains(issue) => false,
            Issue::MalformedGeometry { .. } => {
                reported.push(issue.clone());
                true
            }
            _ => true,
        });
        extraction
    }
}
