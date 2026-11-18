use crate::affine::Vec3;

use super::{column, Caps, Connector, Gender, SectionShape, Shape, Source};

pub const CAP_ROOT: u8 = 1;
pub const CAP_FAR: u8 = 2;

pub const ROUND: u8 = 0;
pub const AXLE: u8 = 1;
pub const SQUARE: u8 = 2;
pub const FLARED_FAR_END: u8 = 3;
pub const FLARED_NEAR_END: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaceSection {
    pub code: u8,
    pub size: f64,
    pub length: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MatingFace {
    pub source: Source,
    pub gender: Gender,
    pub origin: Vec3,
    pub axis: Vec3,
    pub sections: Vec<FaceSection>,
    pub caps: u8,
    pub slide: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unreadable {
    FingerHinge,
    Generic,
    ClosedAtBothEnds,
}

fn code(shape: SectionShape) -> u8 {
    match shape {
        SectionShape::Round => ROUND,
        SectionShape::Axle => AXLE,
        SectionShape::Square => SQUARE,
        SectionShape::FlexibleEnd => FLARED_FAR_END,
        SectionShape::FlexibleStart => FLARED_NEAR_END,
    }
}

fn closed_ends(gender: Gender, caps: Caps) -> (bool, bool) {
    match (caps, gender) {
        (Caps::None, _) => (false, false),
        (Caps::Two, _) => (true, true),
        (Caps::A, _) | (Caps::One, Gender::Male) => (true, false),
        (Caps::B, _) | (Caps::One, Gender::Female) => (false, true),
    }
}

fn along(point: Vec3, direction: Vec3, distance: f64) -> Vec3 {
    [0, 1, 2].map(|k| point[k] + direction[k] * distance + 0.0)
}

fn reversed(direction: Vec3) -> Vec3 {
    direction.map(|c| -c + 0.0)
}

struct Cylinder<'a> {
    source: Source,
    gender: Gender,
    sections: &'a [FaceSection],
    closed: (bool, bool),
    slide: bool,
}

impl Cylinder<'_> {
    fn faces(&self, start: Vec3, direction: Vec3) -> Result<Vec<MatingFace>, Unreadable> {
        let total: f64 = self.sections.iter().map(|s| s.length).sum();
        let far = along(start, direction, total);
        let in_order = self.sections.to_vec();
        let backwards: Vec<FaceSection> = self.sections.iter().rev().copied().collect();
        let face = |origin, axis, sections, caps| MatingFace {
            source: self.source,
            gender: self.gender,
            origin,
            axis,
            sections,
            caps,
            slide: self.slide,
        };
        let (start_closed, far_closed) = self.closed;
        Ok(match self.gender {
            Gender::Male if far_closed && !start_closed => {
                vec![face(far, reversed(direction), backwards, CAP_ROOT)]
            }
            Gender::Male => {
                let caps = if far_closed {
                    CAP_ROOT | CAP_FAR
                } else {
                    CAP_ROOT
                };
                vec![face(start, direction, in_order, caps)]
            }
            Gender::Female if start_closed && far_closed => {
                return Err(Unreadable::ClosedAtBothEnds)
            }
            Gender::Female => {
                let mut out = Vec::new();
                if !start_closed {
                    let caps = if far_closed { CAP_FAR } else { 0 };
                    out.push(face(start, reversed(direction), in_order, caps));
                }
                if !far_closed {
                    let caps = if start_closed { CAP_FAR } else { 0 };
                    out.push(face(far, direction, backwards, caps));
                }
                out
            }
        })
    }
}

pub fn mating_faces(connector: &Connector) -> Result<Vec<MatingFace>, Unreadable> {
    let (gender, sections, closed, center, slide) = match &connector.shape {
        Shape::Cylinder {
            gender,
            sections,
            caps,
            center,
            slide,
            ..
        } => (
            *gender,
            sections
                .iter()
                .map(|s| FaceSection {
                    code: code(s.shape),
                    size: s.radius,
                    length: s.length,
                })
                .collect::<Vec<_>>(),
            closed_ends(*gender, *caps),
            *center,
            *slide,
        ),
        Shape::Clip {
            radius,
            length,
            center,
            slide,
        } => (
            Gender::Female,
            vec![FaceSection {
                code: ROUND,
                size: *radius,
                length: *length,
            }],
            (false, false),
            *center,
            *slide,
        ),
        Shape::Finger { .. } => return Err(Unreadable::FingerHinge),
        Shape::Generic { .. } => return Err(Unreadable::Generic),
    };
    let cylinder = Cylinder {
        source: connector.source,
        gender,
        sections: &sections,
        closed,
        slide,
    };
    let total: f64 = sections.iter().map(|s| s.length).sum();
    let direction = column(&connector.placement, 1);
    let offsets = connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets());
    let mut out = Vec::new();
    for offset in offsets {
        let anchor = connector.placement.apply(offset);
        let start = if center {
            along(anchor, direction, -total / 2.0)
        } else {
            anchor
        };
        out.extend(cylinder.faces(start, direction)?);
    }
    Ok(out)
}
