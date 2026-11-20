use serde_json::{json, Value};

use super::{mating_faces, Extraction, Gender, MatingFace, Source, Status, Unreadable};

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
            let tier = if is_connectivity(connector.source) {
                &mut records.connectivity
            } else {
                &mut records.connectors
            };
            match mating_faces(connector) {
                Ok(faces) => tier.faces.extend(faces),
                Err(reason) => tier.unreadable.push(reason),
            }
        }
        records
    }
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
