mod meta;
mod primitive;
mod shadow;

use std::collections::HashSet;

use crate::affine::{Affine, Vec3};
use crate::flatten::Library;

pub use meta::{parse_metas, Meta, MetaError, ParsedMeta};
pub use primitive::{PrimitiveConnectors, PrimitiveTable};
pub use shadow::ShadowSnaps;

const UNIT_SCALE_TOLERANCE: f64 = 1e-3;
const ROTATION_DUST: f64 = 1e-9;
const SAME_PLACE_LDU: f64 = 0.0005;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Source {
    Shadow,
    Primitive,
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

#[derive(Clone, Debug, PartialEq)]
pub struct Connector {
    pub source: Source,
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
    ScaledFixedShape {
        source: Source,
        id: Option<String>,
        scale: Vec3,
    },
    UnpairedHoleEnd {
        primitive: String,
        origin: Vec3,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extraction {
    pub connectors: Vec<Connector>,
    pub suppressed: Vec<Connector>,
    pub curated: bool,
    pub issues: Vec<Issue>,
}

fn column(m: &Affine, c: usize) -> Vec3 {
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

type PoseKey = (u8, [i64; 3], [i64; 3]);

fn identified(value: f64) -> i64 {
    (value / (2.0 * SAME_PLACE_LDU)).round() as i64
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

fn pose_keys(connector: &Connector) -> Vec<PoseKey> {
    let axis = column(&connector.placement, 1);
    let flip = symmetric(&connector.shape)
        && axis
            .iter()
            .copied()
            .find(|c| identified(*c) != 0)
            .is_some_and(|c| c < 0.0);
    let axis = axis.map(|c| identified(if flip { -c } else { c }));
    let offsets = connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets());
    offsets
        .into_iter()
        .map(|offset| {
            let origin = connector.placement.apply(offset).map(identified);
            (polarity(&connector.shape), origin, axis)
        })
        .collect()
}

pub struct ConnectorExtractor<'a, L: Library + ?Sized, S: Library + ?Sized> {
    shadow: ShadowSnaps<'a, L, S>,
    primitives: PrimitiveConnectors<'a, L>,
}

impl<'a, L: Library + ?Sized, S: Library + ?Sized> ConnectorExtractor<'a, L, S> {
    pub fn new(shadow: ShadowSnaps<'a, L, S>, primitives: PrimitiveConnectors<'a, L>) -> Self {
        ConnectorExtractor { shadow, primitives }
    }

    pub fn extract(&mut self, path: &str) -> Extraction {
        let mut extraction = self.shadow.snaps(path);
        let mut occupied: HashSet<PoseKey> = extraction
            .connectors
            .iter()
            .chain(&extraction.suppressed)
            .flat_map(pose_keys)
            .collect();
        let (primitive, issues) = self.primitives.connectors(path);
        extraction.issues.extend(issues);
        for candidate in primitive {
            let keys = pose_keys(&candidate);
            if keys.iter().any(|key| occupied.contains(key)) {
                continue;
            }
            occupied.extend(keys);
            extraction.connectors.push(candidate);
        }
        extraction
    }
}
