use std::collections::HashMap;

use serde_json::{json, Value};

use super::{
    joined_pieces, mating_faces, Extraction, Gender, MatingFace, Source, Status, Unreadable,
    WithheldFace,
};

const FREE_AXIS: i64 = -1;

pub const CONNECTIVITY_LICENSE: &str = "CC BY-SA 4.0";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TierRecord {
    pub faces: Vec<MatingFace>,
    pub unreadable: Vec<Unreadable>,
}

impl TierRecord {
    pub fn is_empty(&self) -> bool {
        self.faces.is_empty() && self.unreadable.is_empty()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PartRecords {
    pub connectivity: TierRecord,
    pub connectors: TierRecord,
}

impl PartRecords {
    pub fn of(extraction: &Extraction) -> PartRecords {
        let mut records = PartRecords::default();
        for connector in &extraction.connectors {
            if let Err(reason) = mating_faces(connector) {
                records.tier(connector.source).unreadable.push(reason);
            }
        }
        for published in published_faces(extraction) {
            records
                .tier(published.face.source)
                .faces
                .push(published.face);
        }
        records
    }

    fn tier(&mut self, source: Source) -> &mut TierRecord {
        if is_connectivity(source) {
            &mut self.connectivity
        } else {
            &mut self.connectors
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PublishedFace {
    pub face: MatingFace,
    pub pieces: Vec<u16>,
}

type ExactSlot = (u8, [i32; 3], u8);

fn exact_slot(face: &MatingFace) -> Option<ExactSlot> {
    Some((gender_code(face.gender), face.sixteenths?, face.direction?))
}

pub(super) struct FreeFace {
    pub connector: usize,
    pub face: usize,
    pub mating: MatingFace,
    pub holders: Vec<MatingFace>,
}

pub(super) fn free_faces_of_partly_held(extraction: &Extraction) -> Vec<FreeFace> {
    let faces: Vec<(usize, Vec<MatingFace>)> = extraction
        .connectors
        .iter()
        .enumerate()
        .filter_map(|(index, connector)| mating_faces(connector).ok().map(|f| (index, f)))
        .collect();
    let mut at_slot: HashMap<ExactSlot, Vec<&MatingFace>> = HashMap::new();
    for (_, found) in &faces {
        for face in found {
            if let Some(slot) = exact_slot(face) {
                at_slot.entry(slot).or_default().push(face);
            }
        }
    }
    let mut free = Vec::new();
    for (connector, found) in &faces {
        let own = tier(extraction.connectors[*connector].source);
        let holders_at = |face: &MatingFace| -> Vec<MatingFace> {
            exact_slot(face)
                .and_then(|slot| at_slot.get(&slot))
                .map(|held| {
                    held.iter()
                        .filter(|holder| tier(holder.source) < own)
                        .map(|holder| (*holder).clone())
                        .collect()
                })
                .unwrap_or_default()
        };
        let holders: Vec<MatingFace> = found.iter().flat_map(holders_at).collect();
        if holders.is_empty() {
            continue;
        }
        for (index, face) in found.iter().enumerate() {
            if face.gender == Gender::Female && holders_at(face).is_empty() {
                free.push(FreeFace {
                    connector: *connector,
                    face: index,
                    mating: face.clone(),
                    holders: holders.clone(),
                });
            }
        }
    }
    free
}

fn tier(source: Source) -> u8 {
    match source {
        Source::Shadow | Source::Patch => 1,
        Source::Primitive => 2,
        Source::Inferred => 4,
    }
}

fn standing(face: &MatingFace) -> (u8, bool, u8) {
    (
        tier(face.source),
        face.source != Source::Patch,
        status_code(face.status),
    )
}

fn same_receptor(a: &MatingFace, b: &MatingFace) -> bool {
    a.gender == b.gender
        && a.sections == b.sections
        && a.caps == b.caps
        && a.slide == b.slide
        && a.group == b.group
}

pub fn published_faces(extraction: &Extraction) -> Vec<PublishedFace> {
    let mut faces: Vec<PublishedFace> = Vec::new();
    for (index, connector) in extraction.connectors.iter().enumerate() {
        if let Ok(found) = mating_faces(connector) {
            faces.extend(
                found
                    .into_iter()
                    .enumerate()
                    .filter(|(face, _)| {
                        !extraction.withheld.contains(&WithheldFace {
                            connector: index,
                            face: *face,
                        })
                    })
                    .map(|(_, face)| PublishedFace {
                        face,
                        pieces: connector.pieces.clone(),
                    }),
            );
        }
    }
    let mut at_slot: HashMap<ExactSlot, Vec<usize>> = HashMap::new();
    for (index, published) in faces.iter().enumerate() {
        if let Some(slot) = exact_slot(&published.face) {
            at_slot.entry(slot).or_default().push(index);
        }
    }
    let mut kept = vec![true; faces.len()];
    for indices in at_slot.values() {
        let Some(top) = indices.iter().map(|&i| tier(faces[i].face.source)).min() else {
            continue;
        };
        let holder = indices
            .iter()
            .copied()
            .find(|&i| tier(faces[i].face.source) == top)
            .expect("the top tier holds the slot");
        let lower: Vec<usize> = indices
            .iter()
            .copied()
            .filter(|&i| tier(faces[i].face.source) > top)
            .collect();
        for lower in lower {
            kept[lower] = false;
            if faces[lower].face.source != Source::Inferred {
                faces[holder].pieces = joined_pieces(&faces[holder].pieces, &faces[lower].pieces);
            }
        }
        let held: Vec<usize> = indices
            .iter()
            .copied()
            .filter(|&i| tier(faces[i].face.source) == top)
            .collect();
        for (n, &first) in held.iter().enumerate() {
            if !kept[first] {
                continue;
            }
            for &second in &held[n + 1..] {
                if !kept[second] || !same_receptor(&faces[first].face, &faces[second].face) {
                    continue;
                }
                kept[second] = false;
                faces[first].pieces = joined_pieces(&faces[first].pieces, &faces[second].pieces);
                if standing(&faces[second].face) < standing(&faces[first].face) {
                    faces[first].face.source = faces[second].face.source;
                    faces[first].face.status = faces[second].face.status;
                }
            }
        }
    }
    faces
        .into_iter()
        .zip(kept)
        .filter_map(|(mut published, kept)| {
            kept.then(|| {
                if let Some(&lowest) = published.pieces.first() {
                    published.face.piece = lowest;
                }
                published
            })
        })
        .collect()
}

fn unreadable_name(reason: Unreadable) -> &'static str {
    match reason {
        Unreadable::Generic => "generic",
        Unreadable::ClosedAtBothEnds => "closedAtBothEnds",
    }
}

pub fn is_connectivity(source: Source) -> bool {
    match source {
        Source::Shadow | Source::Patch => true,
        Source::Primitive | Source::Inferred => false,
    }
}

pub fn source_code(source: Source) -> u8 {
    match source {
        Source::Shadow => 1,
        Source::Primitive => 2,
        Source::Inferred => 4,
        Source::Patch => 8,
    }
}

pub fn status_code(status: Status) -> u8 {
    match status {
        Status::Verified => 0,
        Status::Unverified => 1,
    }
}

fn gender_code(gender: Gender) -> u8 {
    match gender {
        Gender::Male => 0,
        Gender::Female => 1,
    }
}

pub fn record_json(part: &str, license: &str, record: &TierRecord) -> Value {
    let faces = &record.faces;
    let mut gender = Vec::with_capacity(faces.len());
    let mut source = Vec::with_capacity(faces.len());
    let mut status = Vec::with_capacity(faces.len());
    let mut caps = Vec::with_capacity(faces.len());
    let mut slide = Vec::with_capacity(faces.len());
    let mut group = Vec::with_capacity(faces.len());
    let mut origin = Vec::with_capacity(faces.len() * 3);
    let mut axis = Vec::with_capacity(faces.len());
    let mut section_start = Vec::with_capacity(faces.len());
    let mut section_count = Vec::with_capacity(faces.len());
    let mut section_code = Vec::new();
    let mut section_size = Vec::new();
    let mut section_length = Vec::new();
    let mut free_face = Vec::new();
    let mut free_origin = Vec::new();
    let mut free_axis = Vec::new();
    let mut piece = Vec::with_capacity(faces.len());
    for (index, face) in faces.iter().enumerate() {
        piece.push(face.piece);
        gender.push(gender_code(face.gender));
        source.push(source_code(face.source));
        status.push(status_code(face.status));
        caps.push(face.caps);
        slide.push(face.slide);
        group.push(face.group.clone().unwrap_or_default());
        match (face.sixteenths, face.direction) {
            (Some(sixteenths), Some(direction)) => {
                origin.extend(sixteenths.map(i64::from));
                axis.push(i64::from(direction));
            }
            _ => {
                origin.extend([0, 0, 0]);
                axis.push(FREE_AXIS);
                free_face.push(index);
                free_origin.extend(face.origin);
                free_axis.extend(face.axis);
            }
        }
        section_start.push(section_code.len());
        section_count.push(face.sections.len());
        for section in &face.sections {
            section_code.push(section.code);
            section_size.push(section.size);
            section_length.push(section.length);
        }
    }
    json!({
        "part": part,
        "license": license,
        "faces": {
            "gender": gender,
            "source": source,
            "status": status,
            "caps": caps,
            "slide": slide,
            "group": group,
            "origin": origin,
            "axis": axis,
            "sectionStart": section_start,
            "sectionCount": section_count,
            "sectionCode": section_code,
            "sectionSize": section_size,
            "sectionLength": section_length,
            "piece": piece,
        },
        "free": {
            "face": free_face,
            "origin": free_origin,
            "axis": free_axis,
        },
        "unreadable": record.unreadable.iter().copied().map(unreadable_name).collect::<Vec<_>>(),
    })
}
