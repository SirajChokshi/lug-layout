use crate::affine::Vec3;

use super::{
    column, Bounding, Caps, Connector, Gender, GenericMatch, SectionShape, Shape, Source, Status,
};

pub const CAP_ROOT: u8 = 1;
pub const CAP_FAR: u8 = 2;

pub const ROUND: u8 = 0;
pub const AXLE: u8 = 1;
pub const SQUARE: u8 = 2;
pub const FLARE_JOINS_PREVIOUS: u8 = 3;
pub const FLARE_JOINS_NEXT: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaceSection {
    pub code: u8,
    pub size: f64,
    pub length: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MatingFace {
    pub source: Source,
    pub status: Status,
    pub group: Option<String>,
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
        SectionShape::FlexibleEnd => FLARE_JOINS_PREVIOUS,
        SectionShape::FlexibleStart => FLARE_JOINS_NEXT,
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

fn reversed_section(section: &FaceSection) -> FaceSection {
    let code = match section.code {
        FLARE_JOINS_PREVIOUS => FLARE_JOINS_NEXT,
        FLARE_JOINS_NEXT => FLARE_JOINS_PREVIOUS,
        other => other,
    };
    FaceSection { code, ..*section }
}

fn along(point: Vec3, direction: Vec3, distance: f64) -> Vec3 {
    [0, 1, 2].map(|k| point[k] + direction[k] * distance + 0.0)
}

fn reversed(direction: Vec3) -> Vec3 {
    direction.map(|c| -c + 0.0)
}

struct Cylinder<'a> {
    source: Source,
    status: Status,
    group: &'a Option<String>,
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
        let backwards: Vec<FaceSection> =
            self.sections.iter().rev().map(reversed_section).collect();
        let face = |origin, axis, sections, caps| MatingFace {
            source: self.source,
            status: self.status,
            group: self.group.clone(),
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

fn contact_faces(connector: &Connector, gender: Gender, radius: f64) -> Vec<MatingFace> {
    let direction = column(&connector.placement, 1);
    let axis = match gender {
        Gender::Male => direction,
        Gender::Female => reversed(direction),
    };
    connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets())
        .into_iter()
        .map(|offset| MatingFace {
            source: connector.source,
            status: connector.status,
            group: connector.group.clone(),
            gender,
            origin: connector.placement.apply(offset),
            axis,
            sections: vec![FaceSection {
                code: ROUND,
                size: radius,
                length: 0.0,
            }],
            caps: 0,
            slide: false,
        })
        .collect()
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
        Shape::Generic {
            gender,
            bounding: Bounding::Cylinder { radius, length },
            matching: Some(GenericMatch::Group),
            free_placement: false,
        } if connector.group.is_some() && *length == 0.0 => {
            return Ok(contact_faces(connector, *gender, *radius))
        }
        Shape::Generic { .. } => return Err(Unreadable::Generic),
    };
    let cylinder = Cylinder {
        source: connector.source,
        status: connector.status,
        group: &connector.group,
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
