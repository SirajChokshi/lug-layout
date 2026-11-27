use crate::affine::Vec3;
use crate::identify::sixteenths;

use super::{
    column, direction_code, Bounding, Connector, Gender, GenericMatch, Mirror, SectionShape, Shape,
    Source, Status,
};

pub const CAP_ROOT: u8 = 1;
pub const CAP_FAR: u8 = 2;

pub const ROUND: u8 = 0;
pub const AXLE: u8 = 1;
pub const SQUARE: u8 = 2;
pub const FLARE_JOINS_PREVIOUS: u8 = 3;
pub const FLARE_JOINS_NEXT: u8 = 4;
pub const MALE_FINGER: u8 = 5;
pub const FEMALE_FINGER: u8 = 6;
pub const BOX: u8 = 7;
pub const FINGER_RADIUS_UNSTATED: f64 = 0.0;

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
    pub sixteenths: Option<[i32; 3]>,
    pub direction: Option<u8>,
    pub roll: Option<u8>,
    pub sections: Vec<FaceSection>,
    pub caps: u8,
    pub slide: bool,
    pub piece: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unreadable {
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

fn finger_sections(first: Gender, widths: &[f64], radius: Option<f64>) -> Vec<FaceSection> {
    widths
        .iter()
        .enumerate()
        .map(|(k, &width)| FaceSection {
            code: if (k % 2 == 0) == (first == Gender::Male) {
                MALE_FINGER
            } else {
                FEMALE_FINGER
            },
            size: radius.unwrap_or(FINGER_RADIUS_UNSTATED),
            length: width,
        })
        .collect()
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
    piece: u16,
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
            sixteenths: on_grid(origin),
            direction: direction_code(axis),
            roll: None,
            sections,
            caps,
            slide: self.slide,
            piece: self.piece,
        };
        let (start_closed, far_closed) = self.closed;
        Ok(match self.gender {
            Gender::Male if far_closed && !start_closed => {
                vec![face(far, reversed(direction), backwards, CAP_ROOT)]
            }
            Gender::Male if !start_closed && !far_closed => vec![
                face(start, direction, in_order, 0),
                face(far, reversed(direction), backwards, 0),
            ],
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

fn on_grid(origin: Vec3) -> Option<[i32; 3]> {
    let steps = |value: f64| sixteenths(value).and_then(|steps| i32::try_from(steps).ok());
    Some([steps(origin[0])?, steps(origin[1])?, steps(origin[2])?])
}

fn contact_faces(
    connector: &Connector,
    gender: Gender,
    section: FaceSection,
    roll: Option<u8>,
) -> Vec<MatingFace> {
    let direction = column(&connector.placement, 1);
    let axis = match gender {
        Gender::Male => direction,
        Gender::Female => reversed(direction),
    };
    connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets())
        .into_iter()
        .map(|offset| connector.placement.apply(offset))
        .map(|origin| MatingFace {
            source: connector.source,
            status: connector.status,
            group: connector.group.clone(),
            gender,
            origin,
            axis,
            sixteenths: on_grid(origin),
            direction: direction_code(axis),
            roll,
            sections: vec![section],
            caps: 0,
            slide: false,
            piece: connector.piece(),
        })
        .collect()
}

fn box_faces(
    connector: &Connector,
    gender: Gender,
    mirror: Mirror,
) -> Result<Vec<MatingFace>, Unreadable> {
    if connector.placement.determinant() < 0.0 {
        match mirror {
            Mirror::None => return Ok(Vec::new()),
            Mirror::CorZ => {}
            Mirror::Cor | Mirror::CorX | Mirror::CorY => return Err(Unreadable::Generic),
        }
    }
    let roll = direction_code(column(&connector.placement, 0)).ok_or(Unreadable::Generic)?;
    let section = FaceSection {
        code: BOX,
        size: 0.0,
        length: 0.0,
    };
    Ok(contact_faces(connector, gender, section, Some(roll)))
}

pub fn mating_faces(connector: &Connector) -> Result<Vec<MatingFace>, Unreadable> {
    let (genders, sections, closed, center, slide) = match &connector.shape {
        Shape::Cylinder {
            gender,
            sections,
            caps,
            center,
            slide,
            ..
        } => (
            vec![*gender],
            sections
                .iter()
                .map(|s| FaceSection {
                    code: code(s.shape),
                    size: s.radius,
                    length: s.length,
                })
                .collect::<Vec<_>>(),
            caps.closed_ends(*gender),
            *center,
            *slide,
        ),
        Shape::Clip {
            radius,
            length,
            center,
            slide,
        } => (
            vec![Gender::Female],
            vec![FaceSection {
                code: ROUND,
                size: *radius,
                length: *length,
            }],
            (false, false),
            *center,
            *slide,
        ),
        Shape::Finger {
            first,
            widths,
            radius,
            center,
        } => (
            vec![Gender::Male, Gender::Female],
            finger_sections(*first, widths, *radius),
            (false, false),
            *center,
            false,
        ),
        Shape::Generic {
            gender,
            bounding: Bounding::Cylinder { radius, length },
            matching: Some(GenericMatch::Group),
            free_placement: false,
            ..
        } if connector.group.is_some() && *length == 0.0 => {
            let section = FaceSection {
                code: ROUND,
                size: *radius,
                length: 0.0,
            };
            return Ok(contact_faces(connector, *gender, section, None));
        }
        Shape::Generic {
            gender,
            bounding: Bounding::Box { .. },
            matching: None | Some(GenericMatch::Group),
            free_placement: false,
            mirror,
        } if connector.group.is_some() => return box_faces(connector, *gender, *mirror),
        Shape::Generic { .. } => return Err(Unreadable::Generic),
    };
    let cylinders: Vec<Cylinder> = genders
        .into_iter()
        .map(|gender| Cylinder {
            source: connector.source,
            status: connector.status,
            group: &connector.group,
            gender,
            sections: &sections,
            closed,
            slide,
            piece: connector.piece(),
        })
        .collect();
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
        for cylinder in &cylinders {
            out.extend(cylinder.faces(start, direction)?);
        }
    }
    Ok(out)
}
