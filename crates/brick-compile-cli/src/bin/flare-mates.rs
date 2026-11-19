use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::affine::Vec3;
use brick_compile::connect::{
    mating_faces, parse_metas, ConnectorExtractor, FaceSection, Gender, InferredFeatures,
    MatingFace, Meta, PrimitiveConnectors, PrimitiveTable, SectionShape, ShadowPatches,
    ShadowSnaps, Shape, AXLE, FLARE_JOINS_NEXT, FLARE_JOINS_PREVIOUS, ROUND, SQUARE,
};
use brick_compile::flatten::{resolve_reference, Lod};
use brick_compile::identify::{identifies, IDENTIFY_LDU};
use brick_compile::model::{bake_model, official_reference};
use brick_compile_cli::{read_section_vocabulary, LazyLibrary};
use serde_json::{json, Value};

const COAXIAL_LDU: f64 = 0.01;
const ANTIPARALLEL: f64 = 1e-6;

#[derive(Clone, Copy, PartialEq)]
enum Rule {
    FlaresNeverMate,
    Proposed,
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn is_flare(code: u8) -> bool {
    code == FLARE_JOINS_PREVIOUS || code == FLARE_JOINS_NEXT
}

fn effective(
    sections: &[FaceSection],
    index: usize,
    gender: Gender,
    rule: Rule,
) -> Option<(u8, f64)> {
    let section = sections[index];
    if !is_flare(section.code) {
        return Some((section.code, section.size));
    }
    if rule == Rule::FlaresNeverMate {
        return None;
    }
    match gender {
        Gender::Female => Some((ROUND, section.size)),
        Gender::Male => {
            let neighbour = if section.code == FLARE_JOINS_PREVIOUS {
                index.checked_sub(1)
            } else {
                Some(index + 1)
            };
            let neighbour = sections.get(neighbour?)?;
            (neighbour.code == ROUND).then_some((ROUND, neighbour.size))
        }
    }
}

fn fits(male: (u8, f64), female: (u8, f64)) -> bool {
    let (m_code, m_size) = male;
    let (f_code, f_size) = female;
    let within = m_size <= f_size + IDENTIFY_LDU;
    match (m_code, f_code) {
        (ROUND, ROUND) | (AXLE, ROUND) | (ROUND, SQUARE) | (AXLE, SQUARE) => within,
        (AXLE, AXLE) => identifies(m_size - f_size),
        _ => false,
    }
}

fn spans(sections: &[FaceSection], start: f64) -> Vec<(f64, f64)> {
    let mut at = start;
    sections
        .iter()
        .map(|s| {
            let span = (at, at + s.length);
            at += s.length;
            span
        })
        .collect()
}

fn contained(
    male: &MatingFace,
    female: &MatingFace,
    offset: f64,
    rule: Rule,
) -> Result<bool, String> {
    if male.group != female.group {
        return Err(format!(
            "groups differ: male {:?}, female {:?}",
            male.group, female.group
        ));
    }
    let male_spans = spans(&male.sections, 0.0);
    let female_spans = spans(&female.sections, offset);
    let mut overlapped = false;
    for (i, &(m0, m1)) in male_spans.iter().enumerate() {
        for (j, &(f0, f1)) in female_spans.iter().enumerate() {
            if m0.max(f0) >= m1.min(f1) - IDENTIFY_LDU {
                continue;
            }
            overlapped = true;
            let (Some(m), Some(f)) = (
                effective(&male.sections, i, Gender::Male, rule),
                effective(&female.sections, j, Gender::Female, rule),
            ) else {
                return Ok(false);
            };
            if !fits(m, f) {
                return Err(format!(
                    "male section {i} {m:?} does not fit female section {j} {f:?}"
                ));
            }
        }
    }
    Ok(overlapped)
}

fn describe(face: &MatingFace) -> String {
    face.sections
        .iter()
        .map(|s| format!("{}:{}x{}", s.code, s.size, s.length))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shadow_files(root: &std::path::Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            shadow_files(&path, out);
        } else if path.extension().is_some_and(|x| x == "dat") {
            out.push(path);
        }
    }
}

fn flare_census(root: &std::path::Path) -> Value {
    let mut files = Vec::new();
    shadow_files(root, &mut files);
    files.sort();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut partnerless: Vec<Value> = Vec::new();
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        let name = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        for parsed in parse_metas(&text).into_iter().flatten() {
            let Meta::Snap(connector) = parsed.meta else {
                continue;
            };
            let Shape::Cylinder {
                gender, sections, ..
            } = &connector.shape
            else {
                continue;
            };
            for (i, section) in sections.iter().enumerate() {
                let (label, partner) = match section.shape {
                    SectionShape::FlexibleEnd => ("_L", i.checked_sub(1)),
                    SectionShape::FlexibleStart => ("L_", Some(i + 1)),
                    _ => continue,
                };
                let place = match (i == 0, i + 1 == sections.len()) {
                    (true, true) => "only",
                    (true, false) => "first",
                    (false, true) => "last",
                    (false, false) => "between",
                };
                *counts.entry(format!("{label} {place}")).or_default() += 1;
                let partner = partner.and_then(|p| sections.get(p));
                let relation = match partner {
                    None => "no partner",
                    Some(p) if p.shape != SectionShape::Round => "partner not round",
                    Some(p) if section.radius > p.radius => "wider than its round partner",
                    Some(_) => "not wider than its round partner",
                };
                *counts.entry(format!("{label} {relation}")).or_default() += 1;
                if relation != "wider than its round partner" {
                    partnerless.push(json!({ "file": name, "gender": format!("{gender:?}"), "code": label, "index": i }));
                }
            }
        }
    }
    json!({ "counts": counts, "withoutWiderRoundPartner": partnerless })
}

struct Placed {
    instance: usize,
    part: String,
    face: MatingFace,
}

fn run() -> Result<bool, String> {
    let mut values = HashMap::new();
    let mut all_males = false;
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        if flag == "--all-males" {
            all_males = true;
        } else {
            values.insert(flag, raw.next().unwrap_or_default());
        }
    }
    let take = |k: &str| values.get(k).cloned().ok_or(format!("missing {k}"));
    let library = LazyLibrary::new(PathBuf::from(take("--ldraw")?));
    let shadow_root = PathBuf::from(take("--shadow")?);
    let shadow = LazyLibrary::new(shadow_root.clone());
    let table_path = take("--primitives")?;
    let table: Value = serde_json::from_slice(&fs::read(&table_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let inferred_path = take("--inferred")?;
    let inferred: Value =
        serde_json::from_slice(&fs::read(&inferred_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let probe_part = inferred["cavityProbe"]
        .as_str()
        .ok_or(format!("{inferred_path}: cavityProbe must be a part path"))?;
    let vocabulary = read_section_vocabulary(Path::new(&take("--vocabulary")?))?;
    let patches = values
        .get("--patches")
        .map(|root| LazyLibrary::new(PathBuf::from(root)));
    let unverified = HashSet::new();
    let snaps = ShadowSnaps::new(&library, &shadow);
    let snaps = match &patches {
        Some(files) => snaps.patched(ShadowPatches {
            files,
            verified: &unverified,
        }),
        None => snaps,
    };
    let mut extractor = ConnectorExtractor::new(
        snaps,
        PrimitiveConnectors::new(&library, PrimitiveTable::from_json(&table)?),
        InferredFeatures::new(&library, vocabulary, probe_part)?,
    );
    let mut faces_of: HashMap<String, Vec<MatingFace>> = HashMap::new();
    let mut report = Vec::new();
    let mut totals: BTreeMap<&str, usize> = BTreeMap::new();
    let omr = PathBuf::from(take("--omr")?);
    let mut models: Vec<PathBuf> = fs::read_dir(&omr)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "mpd"))
        .collect();
    models.sort();
    for model_path in models {
        let source = fs::read_to_string(&model_path).map_err(|e| e.to_string())?;
        let baked = bake_model(&source).map_err(|e| format!("{}: {e:?}", model_path.display()))?;
        let mut placed: Vec<Placed> = Vec::new();
        for (index, instance) in baked.instances.iter().enumerate() {
            let reference = instance
                .inline
                .as_deref()
                .map_or_else(|| instance.part.clone(), official_reference);
            let Some(path) = resolve_reference(&library, Lod::Standard, &reference) else {
                continue;
            };
            let faces = faces_of.entry(path.clone()).or_insert_with(|| {
                extractor
                    .extract(&path)
                    .connectors
                    .iter()
                    .filter_map(|c| mating_faces(c).ok())
                    .flatten()
                    .collect()
            });
            let world = &instance.matrix;
            for face in faces.iter() {
                let origin = world.apply(face.origin);
                let tip = world.apply([0, 1, 2].map(|k| face.origin[k] + face.axis[k]));
                placed.push(Placed {
                    instance: index,
                    part: path.clone(),
                    face: MatingFace {
                        origin,
                        axis: sub(tip, origin),
                        ..face.clone()
                    },
                });
            }
        }
        let name = model_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        for male in placed.iter().filter(|p| {
            p.face.gender == Gender::Male
                && (all_males || p.face.sections.iter().any(|s| is_flare(s.code)))
        }) {
            for female in placed
                .iter()
                .filter(|p| p.face.gender == Gender::Female && p.instance != male.instance)
            {
                if dot(male.face.axis, female.face.axis) > -1.0 + ANTIPARALLEL {
                    continue;
                }
                let offset_vector = sub(female.face.origin, male.face.origin);
                let offset = dot(offset_vector, male.face.axis);
                let off_axis = sub(offset_vector, male.face.axis.map(|c| c * offset));
                if dot(off_axis, off_axis).sqrt() > COAXIAL_LDU {
                    continue;
                }
                let male_length: f64 = male.face.sections.iter().map(|s| s.length).sum();
                let female_length: f64 = female.face.sections.iter().map(|s| s.length).sum();
                if offset >= male_length - IDENTIFY_LDU || offset + female_length <= IDENTIFY_LDU {
                    continue;
                }
                let today = contained(&male.face, &female.face, offset, Rule::FlaresNeverMate);
                let proposed = contained(&male.face, &female.face, offset, Rule::Proposed);
                let key = match (&today, &proposed) {
                    (Ok(true), Ok(true)) => "mates under both",
                    (_, Ok(true)) => "mates only under the proposed rule",
                    _ => "does not mate under the proposed rule",
                };
                *totals.entry(key).or_default() += 1;
                if all_males || key != "mates only under the proposed rule" || report.len() < 400 {
                    report.push(json!({
                        "model": name,
                        "result": key,
                        "male": { "instance": male.instance, "part": male.part, "sections": describe(&male.face) },
                        "female": { "instance": female.instance, "part": female.part, "sections": describe(&female.face), "caps": female.face.caps, "slide": female.face.slide },
                        "offset": (offset * 10000.0).round() / 10000.0,
                        "proposed": match proposed { Ok(v) => json!(v), Err(e) => json!(e) },
                    }));
                }
            }
        }
    }
    let census = flare_census(&PathBuf::from(take("--shadow")?));
    let out = json!({ "census": census, "totals": totals, "pairs": report });
    let text = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())? + "\n";
    fs::write(take("--out")?, text).map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string(&totals).map_err(|e| e.to_string())?
    );
    Ok(!totals.contains_key("does not mate under the proposed rule"))
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("flare-mates: {error}");
            ExitCode::FAILURE
        }
    }
}
