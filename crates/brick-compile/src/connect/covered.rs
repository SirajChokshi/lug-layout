use std::collections::{HashMap, HashSet};
use std::mem;

use crate::identify::identifies;

use super::records::{
    exact_slot, free_faces_of_partly_held, same_receptor, standing, tier, ExactSlot,
};
use super::{
    mating_faces, Connector, Extraction, FaceSection, Gender, Issue, MatingFace, Source, Status,
    WithheldFace, CAP_FAR,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoveredFloor {
    NoFloor,
    SameFloor,
    CoverOpenThere,
}

const SHADOW_TIER: u8 = 1;
const PRIMITIVE_TIER: u8 = 2;

pub(super) fn drop_covered_inferences(extraction: &mut Extraction) {
    let covers = verified_covers(extraction);
    let mut renumbered: HashMap<usize, usize> = HashMap::new();
    let mut kept: Vec<Connector> = Vec::new();
    let mut withheld: Vec<WithheldFace> = Vec::new();
    for (index, connector) in mem::take(&mut extraction.connectors)
        .into_iter()
        .enumerate()
    {
        let coverage = covered_inference(&covers, &connector);
        if coverage.whole() {
            extraction
                .issues
                .extend(coverage.covered.into_iter().map(|(_, issue)| issue));
            continue;
        }
        renumbered.insert(index, kept.len());
        for (face, issue) in coverage.covered {
            withheld.push(WithheldFace {
                connector: kept.len(),
                face,
            });
            extraction.issues.push(issue);
        }
        kept.push(connector);
    }
    let earlier = mem::take(&mut extraction.withheld);
    extraction.withheld = earlier
        .into_iter()
        .filter_map(|face| {
            renumbered
                .get(&face.connector)
                .map(|&connector| WithheldFace { connector, ..face })
        })
        .chain(withheld)
        .collect();
    extraction.connectors = kept;
}

fn verified_covers(extraction: &Extraction) -> Vec<MatingFace> {
    let may_be_withheld: HashSet<(usize, usize)> = free_faces_of_partly_held(extraction)
        .into_iter()
        .map(|free| (free.connector, free.face))
        .collect();
    let faces: Vec<(usize, usize, MatingFace)> = extraction
        .connectors
        .iter()
        .enumerate()
        .filter_map(|(index, connector)| mating_faces(connector).ok().map(|found| (index, found)))
        .flat_map(|(index, found)| {
            found
                .into_iter()
                .enumerate()
                .map(move |(face, mating)| (index, face, mating))
        })
        .collect();
    let shadow_slots: HashSet<ExactSlot> = faces
        .iter()
        .filter(|(_, _, face)| tier(face.source) == SHADOW_TIER)
        .filter_map(|(_, _, face)| exact_slot(face))
        .collect();
    let published_status = |face: &MatingFace| -> Status {
        let Some(slot) = exact_slot(face) else {
            return face.status;
        };
        faces
            .iter()
            .map(|(_, _, other)| other)
            .filter(|other| {
                exact_slot(other) == Some(slot)
                    && tier(other.source) == tier(face.source)
                    && same_receptor(face, other)
            })
            .min_by_key(|other| standing(other))
            .map_or(face.status, |best| best.status)
    };
    faces
        .iter()
        .filter(|(index, face, mating)| {
            published_status(mating) == Status::Verified
                && match tier(mating.source) {
                    SHADOW_TIER => true,
                    PRIMITIVE_TIER => {
                        !may_be_withheld.contains(&(*index, *face))
                            && exact_slot(mating).is_none_or(|slot| !shadow_slots.contains(&slot))
                    }
                    _ => false,
                }
        })
        .map(|(_, _, mating)| mating.clone())
        .collect()
}

struct Coverage {
    faces: usize,
    covered: Vec<(usize, Issue)>,
}

impl Coverage {
    fn whole(&self) -> bool {
        self.faces > 0 && self.covered.len() == self.faces
    }
}

fn covered_inference(covers: &[MatingFace], candidate: &Connector) -> Coverage {
    let faces = match candidate.source {
        Source::Inferred => mating_faces(candidate).unwrap_or_default(),
        _ => Vec::new(),
    };
    let covered = faces
        .iter()
        .enumerate()
        .filter_map(|(index, face)| {
            covers
                .iter()
                .filter_map(|cover| {
                    cover_offset(cover, face).map(|offset| (cover, floor(cover, face, offset)))
                })
                .min_by_key(|(_, floor)| *floor == CoveredFloor::CoverOpenThere)
                .map(|(cover, floor)| {
                    (
                        index,
                        Issue::CoveredInference {
                            inferred: face.clone(),
                            cover: cover.clone(),
                            floor,
                        },
                    )
                })
        })
        .collect();
    Coverage {
        faces: faces.len(),
        covered,
    }
}

fn length(sections: &[FaceSection]) -> f64 {
    sections.iter().map(|section| section.length).sum()
}

fn beyond(distance: f64) -> bool {
    distance > 0.0 && !identifies(distance)
}

fn cover_offset(cover: &MatingFace, face: &MatingFace) -> Option<f64> {
    let direction = face.direction?;
    if cover.direction? != direction || cover.gender != face.gender || cover.group != face.group {
        return None;
    }
    let along = usize::from(direction / 2);
    let on_line = (0..3).all(|k| k == along || identifies(face.origin[k] - cover.origin[k]));
    let inward = match face.gender {
        Gender::Male => face.axis[along].signum(),
        Gender::Female => -face.axis[along].signum(),
    };
    let offset = (face.origin[along] - cover.origin[along]) * inward;
    let end = offset + length(&face.sections);
    if !on_line || !beyond(length(&face.sections)) || beyond(-offset) {
        return None;
    }
    if beyond(end - length(&cover.sections)) {
        return None;
    }
    let mut start = offset;
    for section in &face.sections {
        let stop = start + section.length;
        if !same_sections_over(&cover.sections, start, stop, section) {
            return None;
        }
        start = stop;
    }
    Some(offset)
}

fn same_sections_over(cover: &[FaceSection], from: f64, to: f64, section: &FaceSection) -> bool {
    let mut start = 0.0;
    cover.iter().all(|held| {
        let stop = start + held.length;
        let overlap = stop.min(to) - start.max(from);
        start = stop;
        !beyond(overlap) || (held.code == section.code && identifies(held.size - section.size))
    })
}

fn floor(cover: &MatingFace, face: &MatingFace, offset: f64) -> CoveredFloor {
    if face.gender != Gender::Female || face.caps & CAP_FAR == 0 {
        return CoveredFloor::NoFloor;
    }
    let floor = offset + length(&face.sections);
    if cover.caps & CAP_FAR != 0 && identifies(floor - length(&cover.sections)) {
        CoveredFloor::SameFloor
    } else {
        CoveredFloor::CoverOpenThere
    }
}
