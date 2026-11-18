use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use brick_compile::affine::{Affine, Vec3};
use brick_compile::connect::{
    mating_faces, Connector, ConnectorExtractor, Gender, InferredFeatures, Issue, MatingFace,
    PrimitiveConnectors, PrimitiveTable, SectionShape, SectionVocabulary, ShadowSnaps, Shape,
    Source, Uninferred,
};
use brick_compile::flatten::{resolve_reference, Library, Lod};
use brick_compile::ldraw::{parse, Line};
use brick_compile::model::{bake_model, official_reference};
use serde_json::{json, Value};

const SAME_LDU: f64 = 0.01;
const PARALLEL: f64 = 1e-6;
const MALE_STUD_TITLES: [&str; 3] = ["Stud", "Stud Open", "Stud Truncated"];
const HOLE_END: &str = "p/peghole.dat";
const MOVED: &str = "~Moved";
const EXAMPLES: usize = 12;
const COMMENTED_SNAP: &str = "0 //!LDCAD SNAP_";
const TUBE_TITLE: &str = "Stud Tube Open";
const AXLE_TITLE: &str = "Technic Axle";
const FACE_KEY_STEPS: f64 = 2000.0;
const SIXTEENTHS: f64 = 16.0;
const IDENTIFY_LDU: f64 = 0.0005;
const CLEARANCE_STEPS: f64 = 1000.0;
const LIVE_SNAP: &str = "0 !LDCAD SNAP_";

struct LazyLibrary {
    root: PathBuf,
    revive_commented_snaps: bool,
    loaded: RefCell<HashMap<String, Option<&'static str>>>,
}

impl LazyLibrary {
    fn new(root: PathBuf) -> Self {
        LazyLibrary {
            root,
            revive_commented_snaps: false,
            loaded: RefCell::new(HashMap::new()),
        }
    }

    fn reviving_commented_snaps(root: PathBuf) -> Self {
        LazyLibrary {
            revive_commented_snaps: true,
            ..LazyLibrary::new(root)
        }
    }
}

impl Library for LazyLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        if let Some(found) = self.loaded.borrow().get(path) {
            return *found;
        }
        let found: Option<&'static str> = fs::read(self.root.join(path)).ok().map(|bytes| {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let text = if self.revive_commented_snaps {
                text.replace(COMMENTED_SNAP, LIVE_SNAP)
            } else {
                text
            };
            &*Box::leak(text.into_boxed_str())
        });
        self.loaded.borrow_mut().insert(path.to_string(), found);
        found
    }
}

type AuditSlot = (Option<Gender>, [i64; 3], [i64; 3]);

fn audit_slots(connector: &Connector) -> Vec<AuditSlot> {
    poses(connector)
        .into_iter()
        .map(|p| {
            (
                gender_of(connector),
                p.origin.map(|c| (c * 1000.0).round() as i64),
                p.axis.map(|c| (c * 1000.0).round() as i64),
            )
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Feature {
    Stud,
    HoleEnd,
    Tube,
    Axle,
}

fn y_up_point(p: Vec3) -> Vec3 {
    [p[0], -p[1] + 0.0, -p[2] + 0.0]
}

fn column(m: &Affine, c: usize) -> Vec3 {
    [m.m[c], m.m[4 + c], m.m[8 + c]]
}

fn translation(m: &Affine) -> Vec3 {
    [m.m[3], m.m[7], m.m[11]]
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: Vec3) -> Vec3 {
    let n = norm(a);
    a.map(|c| c / n)
}

fn title_of(library: &LazyLibrary, path: &str) -> String {
    library
        .source(path)
        .map(|s| parse(s).header.title)
        .unwrap_or_default()
}

fn is_male_stud_title(title: &str) -> bool {
    title == MALE_STUD_TITLES[0]
        || MALE_STUD_TITLES[1..]
            .iter()
            .any(|t| title == *t || title.starts_with(&format!("{t} ")))
}

fn features(
    library: &LazyLibrary,
    path: &str,
    at: &Affine,
    depth: usize,
    out: &mut Vec<(Feature, String, Affine)>,
) {
    let Some(source) = library.source(path) else {
        return;
    };
    if depth > 64 {
        return;
    }
    for line in parse(source).lines {
        let Line::Subfile {
            matrix, reference, ..
        } = line
        else {
            continue;
        };
        let Some(child) = resolve_reference(library, Lod::Standard, &reference) else {
            continue;
        };
        let placed = at.then(&matrix);
        let name = child.rsplit('/').next().unwrap_or(&child).to_string();
        if child.starts_with("p/stud") && is_male_stud_title(&title_of(library, &child)) {
            out.push((Feature::Stud, name, placed));
            continue;
        }
        if child == HOLE_END {
            out.push((Feature::HoleEnd, name, placed));
            continue;
        }
        if child.starts_with("p/") && title_of(library, &child).starts_with(TUBE_TITLE) {
            out.push((Feature::Tube, name.clone(), placed));
        }
        if child.starts_with("p/") && title_of(library, &child).starts_with(AXLE_TITLE) {
            out.push((Feature::Axle, name, placed));
            continue;
        }
        features(library, &child, &placed, depth + 1, out);
    }
}

struct Pose {
    origin: Vec3,
    axis: Vec3,
}

fn poses(connector: &Connector) -> Vec<Pose> {
    let offsets = connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |g| g.offsets());
    let axis = unit(column(&connector.placement, 1));
    offsets
        .into_iter()
        .map(|o| Pose {
            origin: connector.placement.apply(o),
            axis,
        })
        .collect()
}

fn gender_of(connector: &Connector) -> Option<Gender> {
    match &connector.shape {
        Shape::Cylinder { gender, .. } | Shape::Generic { gender, .. } => Some(*gender),
        Shape::Clip { .. } => Some(Gender::Female),
        Shape::Finger { .. } => None,
    }
}

fn agrees(feature: Feature, at: &Affine, connectors: &[Connector]) -> bool {
    let origin = y_up_point(translation(at));
    let up = unit(y_up_point(column(at, 1))).map(|c| -c);
    connectors.iter().any(|connector| {
        let Shape::Cylinder { gender, .. } = &connector.shape else {
            return false;
        };
        poses(connector).iter().any(|p| match feature {
            Feature::Stud => {
                *gender == Gender::Male
                    && norm(sub(p.origin, origin)) <= SAME_LDU
                    && dot(p.axis, up) >= 1.0 - PARALLEL
            }
            Feature::HoleEnd => {
                let v = sub(origin, p.origin);
                *gender == Gender::Female
                    && dot(p.axis, up).abs() >= 1.0 - PARALLEL
                    && norm(sub(v, p.axis.map(|c| c * dot(v, p.axis)))) <= SAME_LDU
            }
            Feature::Tube | Feature::Axle => false,
        })
    })
}

fn axle_connector(at: &Affine, faces: &[MatingFace]) -> bool {
    let origin = y_up_point(translation(at));
    let along = unit(y_up_point(column(at, 1)));
    faces.iter().any(|f| {
        let v = sub(f.origin, origin);
        f.sections.iter().any(|s| s.code == 1)
            && dot(f.axis, along).abs() >= 1.0 - PARALLEL
            && norm(sub(v, along.map(|c| c * dot(v, along)))) <= SAME_LDU
    })
}

fn inside_axle_connector(at: &Affine, faces: &[MatingFace]) -> bool {
    let origin = y_up_point(translation(at));
    let along = unit(y_up_point(column(at, 1)));
    faces.iter().any(|f| {
        let v = sub(origin, f.origin);
        let off_axis = norm(sub(v, f.axis.map(|c| c * dot(v, f.axis))));
        f.sections
            .iter()
            .any(|s| s.code == 1 && off_axis <= s.size + SAME_LDU)
            && dot(f.axis, along).abs() >= 1.0 - PARALLEL
    })
}

fn on_tube_axis(at: &Affine, face: &MatingFace) -> bool {
    let origin = y_up_point(translation(at));
    let along = unit(y_up_point(column(at, 1)));
    let v = sub(face.origin, origin);
    face.gender == Gender::Female
        && dot(face.axis, along).abs() >= 1.0 - PARALLEL
        && norm(sub(v, along.map(|c| c * dot(v, along)))) <= SAME_LDU
}

fn tube_receptor(at: &Affine, faces: &[MatingFace]) -> Option<Source> {
    faces.iter().find(|f| on_tube_axis(at, f)).map(|f| f.source)
}

fn sections_key(connector: &Connector) -> String {
    shape_key(&connector.shape)
}

fn shape_key(shape: &Shape) -> String {
    match shape {
        Shape::Cylinder {
            gender, sections, ..
        } => {
            let g = if *gender == Gender::Male { "M" } else { "F" };
            let secs: Vec<String> = sections
                .iter()
                .map(|s| {
                    let shape = match s.shape {
                        SectionShape::Round => "R",
                        SectionShape::Axle => "A",
                        SectionShape::Square => "S",
                        SectionShape::FlexibleEnd => "_L",
                        SectionShape::FlexibleStart => "L_",
                    };
                    format!(
                        "{shape}{} {}",
                        s.radius,
                        (s.length * 1000.0).round() / 1000.0
                    )
                })
                .collect();
            format!("cylinder {g} {}", secs.join(" + "))
        }
        Shape::Clip { radius, .. } => format!("clip r{radius}"),
        Shape::Finger { .. } => "finger hinge".to_string(),
        Shape::Generic { .. } => "generic".to_string(),
    }
}

fn shape_family(connector: &Connector) -> String {
    match &connector.shape {
        Shape::Cylinder {
            gender, sections, ..
        } => {
            let g = if *gender == Gender::Male { "M" } else { "F" };
            let axle = sections.iter().any(|s| s.shape == SectionShape::Axle);
            format!("cylinder {g}{}", if axle { " axle" } else { "" })
        }
        Shape::Clip { .. } => "clip".to_string(),
        Shape::Finger { .. } => "finger hinge".to_string(),
        Shape::Generic { .. } => "generic (ball, magnet, …)".to_string(),
    }
}

fn source_key(source: Source) -> &'static str {
    match source {
        Source::Shadow => "tier 1 shadow",
        Source::Primitive => "tier 2 primitive",
        Source::Inferred => "tier 4 inferred",
    }
}

fn issue_key(issue: &Issue) -> String {
    match issue {
        Issue::Meta { error, .. } => format!("meta error {error:?}"),
        Issue::IgnoredParameter { parameter, .. } => {
            format!(
                "ignored parameter {}",
                parameter.split('=').next().unwrap_or(parameter)
            )
        }
        Issue::UnresolvedInclude { reference, .. } => format!("unresolved include {reference}"),
        Issue::TooDeep { .. } => "too deep".to_string(),
        Issue::ScaledFixedShape { source, .. } => {
            format!(
                "{}: scaled reference to a fixed-size snap",
                source_key(*source)
            )
        }
        Issue::UnpairedHoleEnd { primitive, .. } => format!("unpaired hole end {primitive}"),
        Issue::UndrawnHoleInterior { primitive, .. } => {
            format!("hole ends {primitive} without a drawn bore between them")
        }
        Issue::SectionDisagreement { kept, lower, .. } => format!(
            "section disagreement: {} kept over {}",
            source_key(kept.0),
            source_key(lower.0)
        ),
        Issue::Uninferred { reason, .. } => format!("tier 4: {}", uninferred_key(reason)),
    }
}

fn uninferred_key(reason: &Uninferred) -> &'static str {
    match reason {
        Uninferred::UnidentifiedSize { .. } => "size or length not in the section vocabulary",
        Uninferred::UnidentifiedOrigin => "origin not on the 1/16-LDU grid",
        Uninferred::LooseCavity { .. } => {
            "probe free, blocked along the four lattice axes, touching nothing"
        }
        Uninferred::EntranceInsideCavity => {
            "gripped entrance inside a column that opens further out (recessed receptor)"
        }
        Uninferred::SleeveOfReceptor => "outward wall that is the sleeve of a stud receptor",
        Uninferred::SlidingCavity => {
            "probe gripped but free to slide a half-grid step (the cavity does not locate it)"
        }
        Uninferred::OffCentreCavity { .. } => {
            "probe gripped but its free travel along a lattice line is not centred on the grid point"
        }
        Uninferred::UnpairedThroughCavity { .. } => "through cavity whose far end was not probed",
        Uninferred::TiltedRound { .. } => "round feature on a tilted axis",
        Uninferred::UnknownFacing { .. } => "round feature without BFC facing",
        Uninferred::OpenArc { .. } => "inward open arc wider than half a circle",
        Uninferred::Unflattened => "part does not flatten",
    }
}

fn shadow_texts(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("dat"))
            {
                if let Ok(bytes) = fs::read(&path) {
                    out.push(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
        }
    }
    out
}

type FaceKey = (u8, [i64; 3], [i64; 3]);

fn face_key(face: &MatingFace) -> FaceKey {
    let sixteenths = |c: f64| {
        let steps = (c * SIXTEENTHS).round();
        if (c - steps / SIXTEENTHS).abs() <= IDENTIFY_LDU {
            steps as i64 * FACE_KEY_STEPS as i64
        } else {
            (c * SIXTEENTHS * FACE_KEY_STEPS).round() as i64
        }
    };
    (
        u8::from(face.gender == Gender::Female),
        face.origin.map(sixteenths),
        face.axis.map(|c| (c * FACE_KEY_STEPS).round() as i64),
    )
}

fn faces_of(connectors: &[Connector], source: Option<Source>) -> Vec<MatingFace> {
    connectors
        .iter()
        .filter(|c| source.is_none_or(|s| c.source == s))
        .filter_map(|c| mating_faces(c).ok())
        .flatten()
        .collect()
}

fn face_family(face: &MatingFace) -> String {
    let gender = if face.gender == Gender::Male {
        "M"
    } else {
        "F"
    };
    let code = match face.sections.first().map(|s| s.code) {
        Some(0) => "R",
        Some(1) => "A",
        Some(2) => "S",
        Some(_) => "flared",
        None => "none",
    };
    format!("{gender} {code}")
}

fn section_agreement(kept: &MatingFace, inferred: &MatingFace) -> &'static str {
    let same = |a: f64, b: f64| (a - b).abs() <= 0.0005;
    let identical = kept.sections.len() == inferred.sections.len()
        && kept
            .sections
            .iter()
            .zip(&inferred.sections)
            .all(|(a, b)| a.code == b.code && same(a.size, b.size) && same(a.length, b.length))
        && kept.caps == inferred.caps;
    if identical {
        return "identical sections and caps";
    }
    let (Some(a), Some(b)) = (kept.sections.first(), inferred.sections.first()) else {
        return "profile differs";
    };
    match (a.code == b.code, same(a.size, b.size)) {
        (true, true) => "same profile; length or caps differ",
        (false, true) => "same size; profile code differs",
        _ => "profile size differs",
    }
}

#[derive(Default)]
struct Coverage {
    parts: usize,
    before: usize,
    after: usize,
    before_female: usize,
    after_female: usize,
    gained: usize,
    completed: usize,
    inferred_faces: usize,
    examples_gained: Vec<String>,
    examples_without: Vec<String>,
}

#[derive(Default)]
struct Oracle {
    parts: usize,
    inferred: usize,
    inferred_matching: usize,
    curated_by_family: BTreeMap<String, [usize; 2]>,
    inferred_by_family: BTreeMap<String, [usize; 2]>,
    agreement: BTreeMap<&'static str, usize>,
    unmatched: BTreeMap<&'static str, usize>,
    false_positive_parts: BTreeMap<String, usize>,
}

const OMR_MATCH_LDU: f64 = 0.05;

struct Worldly {
    instance: usize,
    origin: Vec3,
    axis: Vec3,
}

fn to_world(matrix: &Affine, face: &MatingFace) -> (Vec3, Vec3) {
    let origin = matrix.apply(face.origin);
    let tip = matrix.apply([0, 1, 2].map(|k| face.origin[k] + face.axis[k]));
    (origin, unit(sub(tip, origin)))
}

fn omr_tube_check(
    omr: &Path,
    library: &LazyLibrary,
    extractor: &mut ConnectorExtractor<LazyLibrary, LazyLibrary>,
    primitives: &mut PrimitiveConnectors<LazyLibrary>,
    inferred: &mut InferredFeatures<LazyLibrary>,
) -> Result<Value, String> {
    let mut models: Vec<PathBuf> = fs::read_dir(omr)
        .map_err(|e| format!("{}: {e}", omr.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "mpd"))
        .collect();
    models.sort();
    type PartFaces = (Vec<MatingFace>, Vec<MatingFace>, Vec<bool>);
    let mut cache: HashMap<String, PartFaces> = HashMap::new();
    let mut totals: BTreeMap<&str, usize> = BTreeMap::new();
    let mut per_model: Vec<Value> = Vec::new();
    let mut violations: Vec<Value> = Vec::new();
    let mut by_part: BTreeMap<String, [usize; 4]> = BTreeMap::new();
    for model_path in &models {
        let source = fs::read_to_string(model_path).map_err(|e| e.to_string())?;
        let baked = bake_model(&source).map_err(|e| format!("{}: {e}", model_path.display()))?;
        let mut studs: Vec<Worldly> = Vec::new();
        let mut candidates: Vec<(Worldly, bool, String, Vec3)> = Vec::new();
        let mut seen_candidates: std::collections::HashSet<(usize, [i64; 3])> =
            std::collections::HashSet::new();
        for (index, instance) in baked.instances.iter().enumerate() {
            let reference = instance
                .inline
                .as_deref()
                .map_or_else(|| instance.part.clone(), official_reference);
            let Some(path) = resolve_reference(library, Lod::Standard, &reference) else {
                continue;
            };
            let (faces, tube_faces, open) = cache.entry(path.clone()).or_insert_with(|| {
                let faces = faces_of(&extractor.extract(&path).connectors, None);
                let tube = primitives.where_open(&path);
                let opened = inferred.open(&path, tube.clone());
                let open_faces: Vec<FaceKey> = faces_of(&opened.connectors, None)
                    .iter()
                    .map(face_key)
                    .collect();
                let tube_faces = faces_of(&tube, None);
                let open = tube_faces
                    .iter()
                    .map(|f| open_faces.contains(&face_key(f)))
                    .collect();
                (faces, tube_faces, open)
            });
            for face in faces.iter() {
                if face.gender == Gender::Male && face.sections.first().is_some_and(|s| s.code == 0)
                {
                    let (origin, axis) = to_world(&instance.matrix, face);
                    studs.push(Worldly {
                        instance: index,
                        origin,
                        axis,
                    });
                }
            }
            for (face, open) in tube_faces.iter().zip(open.iter()) {
                let (origin, axis) = to_world(&instance.matrix, face);
                if !seen_candidates.insert((index, face_key(face).1)) {
                    continue;
                }
                candidates.push((
                    Worldly {
                        instance: index,
                        origin,
                        axis,
                    },
                    *open,
                    path.clone(),
                    face.origin,
                ));
            }
        }
        let cell = |p: Vec3| p.map(|c| (c / 10.0).floor() as i64);
        let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
        for (k, stud) in studs.iter().enumerate() {
            grid.entry(cell(stud.origin)).or_default().push(k);
        }
        let mut counts = [0usize; 5];
        for (candidate, open, part, local) in &candidates {
            counts[0] += 1;
            counts[1] += usize::from(*open);
            let tally = by_part.entry(part.clone()).or_default();
            tally[0] += 1;
            let home = cell(candidate.origin);
            let mut seated = false;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let key = [home[0] + dx, home[1] + dy, home[2] + dz];
                        for &k in grid.get(&key).map(Vec::as_slice).unwrap_or(&[]) {
                            let stud = &studs[k];
                            seated |= stud.instance != candidate.instance
                                && norm(sub(stud.origin, candidate.origin)) <= OMR_MATCH_LDU
                                && dot(stud.axis, candidate.axis) <= -1.0 + PARALLEL;
                        }
                    }
                }
            }
            if seated {
                counts[2] += 1;
                let tally = by_part.entry(part.clone()).or_default();
                tally[1] += 1;
                if *open {
                    counts[3] += 1;
                    tally[2] += 1;
                } else {
                    counts[4] += 1;
                    tally[3] += 1;
                    if violations.len() < 100 {
                        violations.push(json!({
                            "model": model_path.file_name().map(|n| n.to_string_lossy().into_owned()),
                            "part": part,
                            "at": candidate.origin,
                            "partLocal": local,
                        }));
                    }
                }
            }
        }
        for (label, value) in [
            ("tubeNeighbourCandidates", counts[0]),
            ("emittedOpen", counts[1]),
            ("studSeatedAtACandidate", counts[2]),
            ("studSeatedAtAnEmittedReceptor", counts[3]),
            ("studSeatedAtARejectedCandidate", counts[4]),
        ] {
            *totals.entry(label).or_default() += value;
        }
        per_model.push(json!({
            "model": model_path.file_name().map(|n| n.to_string_lossy().into_owned()),
            "instances": baked.instances.len(),
            "candidates": counts[0],
            "emitted": counts[1],
            "studsAtCandidates": counts[2],
            "studsAtEmitted": counts[3],
            "studsAtRejected": counts[4],
        }));
    }
    let parts: Vec<Value> = by_part
        .iter()
        .map(|(part, t)| {
            json!({
                "part": part,
                "title": title_of(library, part),
                "candidates": t[0],
                "studsAtCandidates": t[1],
                "studsAtEmitted": t[2],
                "studsAtRejected": t[3],
            })
        })
        .collect();
    Ok(json!({
        "matchLdu": OMR_MATCH_LDU,
        "parts": parts,
        "totals": totals,
        "models": per_model,
        "studsAtRejectedCandidates": violations,
    }))
}

fn category(title: &str) -> &'static str {
    let t = title.trim_start_matches(['~', '_', '=', '|']);
    let words: Vec<&str> = t.split_whitespace().collect();
    let has = |w: &str| words.iter().any(|x| x.eq_ignore_ascii_case(w));
    if title.starts_with(MOVED) {
        "~Moved alias"
    } else if has("Sticker") {
        "sticker"
    } else if has("Hinge") && has("Plate") {
        "hinge plate"
    } else if has("Plate") && has("Round") {
        "round plate"
    } else if has("Plate")
        && (has("Jumper") || title.contains("Centre Stud") || title.contains("Center Stud"))
    {
        "jumper plate"
    } else if words.first() == Some(&"Technic") && has("Pin") {
        "Technic pin"
    } else if words.first() == Some(&"Technic") && has("Axle") && !has("Hole") {
        "Technic axle"
    } else if words.first() == Some(&"Tile") {
        "tile"
    } else if words.first() == Some(&"Slope") {
        "slope"
    } else if words.first() == Some(&"Brick") {
        "brick"
    } else if words.first() == Some(&"Plate") {
        "plate"
    } else if words.first() == Some(&"Train") {
        "train"
    } else {
        "other"
    }
}

struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

fn parts(values: &HashMap<String, String>, ldraw: &Path) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(file) = values.get("--parts") {
        out.extend(
            fs::read_to_string(file)
                .map_err(|e| format!("{file}: {e}"))?
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string),
        );
    }
    if let Some(count) = values.get("--sample") {
        let count: usize = count.parse().map_err(|_| "--sample takes a number")?;
        let seed: u64 = values
            .get("--seed")
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let mut all: Vec<String> = fs::read_dir(ldraw.join("parts"))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().to_lowercase())
            .filter(|n| n.ends_with(".dat"))
            .collect();
        all.sort();
        let mut rng = SplitMix(seed);
        for i in (1..all.len()).rev() {
            let j = (rng.next() % (i as u64 + 1)) as usize;
            all.swap(i, j);
        }
        out.extend(all.into_iter().take(count));
    }
    Ok(out)
}

#[derive(Default)]
struct Tally {
    parts: usize,
    with_connectors: usize,
    with_female: usize,
    examples_without: Vec<String>,
}

fn table(rows: BTreeMap<String, usize>) -> Value {
    let mut rows: Vec<(String, usize)> = rows.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Value::Array(
        rows.into_iter()
            .map(|(k, v)| json!({ "kind": k, "count": v }))
            .collect(),
    )
}

fn digest(value: &impl std::fmt::Debug) -> u64 {
    let mut hasher = DefaultHasher::new();
    format!("{value:?}").hash(&mut hasher);
    hasher.finish()
}

fn run() -> Result<(), String> {
    let mut values = HashMap::new();
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        values.insert(flag, raw.next().unwrap_or_default());
    }
    let take = |k: &str| values.get(k).cloned().ok_or(format!("missing {k}"));
    let ldraw = PathBuf::from(take("--ldraw")?);
    let library = LazyLibrary::new(ldraw.clone());
    let shadow_root = PathBuf::from(take("--shadow")?);
    let shadow = LazyLibrary::new(shadow_root.clone());
    let vocabulary =
        SectionVocabulary::from_metas(shadow_texts(&shadow_root).iter().map(String::as_str));
    let revived = LazyLibrary::reviving_commented_snaps(shadow_root);
    let mut revived_snaps = ShadowSnaps::new(&library, &revived);
    let mut commented_fills: Vec<Value> = Vec::new();
    let mut commented_fill_counts: BTreeMap<&str, usize> = BTreeMap::new();
    let mut disagreements: Vec<Value> = Vec::new();
    let table_path = take("--primitives")?;
    let table_json: Value =
        serde_json::from_slice(&fs::read(&table_path).map_err(|e| format!("{table_path}: {e}"))?)
            .map_err(|e| format!("{table_path}: {e}"))?;
    let primitive_table = PrimitiveTable::from_json(&table_json)?;
    let inferred_path = take("--inferred")?;
    let inferred_json: Value = serde_json::from_slice(
        &fs::read(&inferred_path).map_err(|e| format!("{inferred_path}: {e}"))?,
    )
    .map_err(|e| format!("{inferred_path}: {e}"))?;
    let probe_part = inferred_json["cavityProbe"]
        .as_str()
        .ok_or(format!("{inferred_path}: cavityProbe must be a part path"))?
        .to_string();
    let axle_part = inferred_json["axleProbe"]
        .as_str()
        .ok_or(format!("{inferred_path}: axleProbe must be a part path"))?
        .to_string();
    let focus: Vec<String> = values
        .get("--focus")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_default();
    let list = parts(&values, &ldraw)?;
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, primitive_table.clone()),
        InferredFeatures::new(&library, vocabulary.clone(), &probe_part)?
            .with_axle_probe(&axle_part)?,
    );
    let mut tier4_alone =
        InferredFeatures::new(&library, vocabulary, &probe_part)?.with_axle_probe(&axle_part)?;
    if let Some(out) = values.get("--unidentified-tube-receptors") {
        let mut primitives = PrimitiveConnectors::new(&library, primitive_table.clone());
        let mut rows: Vec<Value> = Vec::new();
        for part in &list {
            let Some(path) = resolve_reference(&library, Lod::Standard, part) else {
                continue;
            };
            let candidates = primitives.where_open(&path);
            let opened = tier4_alone.open(&path, candidates);
            if opened.off_lattice.is_empty() {
                continue;
            }
            let extraction = extractor.extract(&path);
            let held = faces_of(&extraction.connectors, None);
            let mut anchors: Vec<Vec3> = Vec::new();
            for connector in &opened.off_lattice {
                let anchor = translation(&connector.placement);
                if anchors.iter().any(|a| norm(sub(*a, anchor)) <= SAME_LDU) {
                    continue;
                }
                anchors.push(anchor);
                for face in faces_of(std::slice::from_ref(connector), None) {
                    let holder = |source: Option<Source>| {
                        held.iter()
                            .filter(|h| source.is_none_or(|s| h.source == s))
                            .find(|h| {
                                h.gender == Gender::Female
                                    && dot(h.axis, face.axis) >= 1.0 - PARALLEL
                                    && norm(sub(h.origin, face.origin)) <= SAME_LDU
                            })
                            .map(|h| json!({ "source": source_key(h.source), "sections": h.sections.iter().map(|s| [s.size, s.length]).collect::<Vec<_>>() }))
                    };
                    rows.push(json!({
                        "part": part,
                        "title": title_of(&library, &path),
                        "anchor": anchor,
                        "face": face.origin,
                        "axis": face.axis,
                        "connector": sections_key(connector),
                        "tier1": holder(Some(Source::Shadow)),
                        "anyTier": holder(None),
                    }));
                }
            }
        }
        return fs::write(
            out,
            serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("{out}: {e}"));
    }
    if let Some(out) = values.get("--hole-pairs") {
        let mut primitives = PrimitiveConnectors::new(&library, primitive_table.clone());
        let mut lines = String::new();
        for part in &list {
            let Some(path) = resolve_reference(&library, Lod::Standard, part) else {
                continue;
            };
            let (connectors, issues) = primitives.connectors(&path);
            lines += &format!("{part}\t{connectors:?}\t{issues:?}\n");
        }
        return fs::write(out, lines).map_err(|e| format!("{out}: {e}"));
    }
    if let Some(out) = values.get("--digest") {
        let mut lines = String::new();
        let mut dump = String::new();
        for part in &list {
            let Some(path) = resolve_reference(&library, Lod::Standard, part) else {
                continue;
            };
            let extraction = extractor.extract(&path);
            let started = Instant::now();
            let inference = tier4_alone.infer(&path);
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            if values.contains_key("--dump") {
                dump += &format!("{part}\n{extraction:#?}\n{inference:#?}\n");
            }
            lines += &format!(
                "{part}\t{:016x}\t{:016x}\t{ms:.3}\n",
                digest(&extraction),
                digest(&inference)
            );
        }
        if let Some(path) = values.get("--dump") {
            fs::write(path, dump).map_err(|e| format!("{path}: {e}"))?;
        }
        return fs::write(out, lines).map_err(|e| format!("{out}: {e}"));
    }
    if let Some(omr) = values.get("--omr") {
        let mut primitives = PrimitiveConnectors::new(&library, primitive_table.clone());
        let report = omr_tube_check(
            Path::new(omr),
            &library,
            &mut extractor,
            &mut primitives,
            &mut tier4_alone,
        )?;
        let out = take("--out")?;
        return fs::write(
            &out,
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("{out}: {e}"));
    }
    let mut coverage: BTreeMap<&str, Coverage> = BTreeMap::new();
    let mut oracle = Oracle::default();
    let mut tubes: BTreeMap<String, usize> = BTreeMap::new();
    let mut tube_examples: Vec<Value> = Vec::new();
    let mut loose: BTreeMap<i64, usize> = BTreeMap::new();
    let mut tier4_timings: Vec<(f64, String, usize)> = Vec::new();
    let mut focused: Vec<Value> = Vec::new();
    let mut axle_census = [0usize; 4];
    let mut axle_by_primitive: BTreeMap<String, [usize; 2]> = BTreeMap::new();
    let mut axle_parts_without_any: Vec<String> = Vec::new();
    let mut axle_parts_with_a_primitive_outside: Vec<String> = Vec::new();
    let mut tube_oracle = [0usize; 2];
    let mut axle_examples: Vec<Value> = Vec::new();
    let mut disagreeing_faces: Vec<Value> = Vec::new();
    let mut tier2_alone = PrimitiveConnectors::new(&library, primitive_table);
    let mut duplicate_faces = [0usize; 2];
    let mut duplicate_pairs: BTreeMap<String, usize> = BTreeMap::new();
    let mut duplicate_examples: Vec<Value> = Vec::new();
    let mut by_source: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_family: BTreeMap<String, usize> = BTreeMap::new();
    let mut tier2_shapes: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_issue: BTreeMap<String, usize> = BTreeMap::new();
    let mut issue_examples: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut checks: BTreeMap<&str, [usize; 2]> = BTreeMap::new();
    let mut misses: Vec<Value> = Vec::new();
    let mut tallies: BTreeMap<&str, Tally> = BTreeMap::new();
    let mut completed: Vec<Value> = Vec::new();
    let mut completed_count = 0usize;
    let mut cross = [0usize; 2];
    let mut cross_misses: Vec<Value> = Vec::new();
    let mut timings: Vec<(f64, String, usize)> = Vec::new();
    let mut counts = [0usize; 5];
    for part in &list {
        let Some(path) = resolve_reference(&library, Lod::Standard, part) else {
            counts[4] += 1;
            continue;
        };
        let title = title_of(&library, &path);
        let started = Instant::now();
        let extraction = extractor.extract(&path);
        timings.push((
            started.elapsed().as_secs_f64() * 1000.0,
            part.clone(),
            extraction.connectors.len(),
        ));
        counts[0] += 1;
        counts[1] += usize::from(!extraction.connectors.is_empty());
        counts[2] += usize::from(extraction.curated);
        let tier2_added = extraction
            .connectors
            .iter()
            .filter(|c| c.source == Source::Primitive)
            .count();
        counts[3] += usize::from(tier2_added > 0);
        let lower_added = extraction
            .connectors
            .iter()
            .filter(|c| c.source != Source::Shadow)
            .count();
        if lower_added > 0 {
            let live: std::collections::HashSet<AuditSlot> = extraction
                .connectors
                .iter()
                .filter(|c| c.source == Source::Shadow)
                .flat_map(audit_slots)
                .collect();
            let revived_connectors = revived_snaps.snaps(&path).connectors;
            let commented: std::collections::HashSet<AuditSlot> = revived_connectors
                .iter()
                .flat_map(audit_slots)
                .filter(|slot| !live.contains(slot))
                .collect();
            let live_faces: std::collections::HashSet<FaceKey> =
                faces_of(&extraction.connectors, Some(Source::Shadow))
                    .iter()
                    .map(face_key)
                    .collect();
            let commented_faces: std::collections::HashSet<FaceKey> =
                faces_of(&revived_connectors, None)
                    .iter()
                    .map(face_key)
                    .filter(|key| !live_faces.contains(key))
                    .collect();
            for connector in extraction
                .connectors
                .iter()
                .filter(|c| c.source != Source::Shadow)
            {
                let at_commented = audit_slots(connector)
                    .iter()
                    .any(|slot| commented.contains(slot))
                    || faces_of(std::slice::from_ref(connector), None)
                        .iter()
                        .any(|face| commented_faces.contains(&face_key(face)));
                if at_commented {
                    *commented_fill_counts
                        .entry(source_key(connector.source))
                        .or_default() += 1;
                }
                if at_commented && commented_fills.len() < 400 {
                    commented_fills.push(json!({
                        "part": part,
                        "title": title,
                        "tier": source_key(connector.source),
                        "connector": sections_key(connector),
                        "at": translation(&connector.placement),
                    }));
                }
            }
        }
        if extraction.curated && tier2_added > 0 {
            completed_count += 1;
            if completed.len() < 200 {
                completed.push(json!({ "part": part, "title": title, "tier2Added": tier2_added }));
            }
        }
        for connector in &extraction.connectors {
            let n = poses(connector).len();
            *by_source
                .entry(source_key(connector.source).to_string())
                .or_default() += n;
            *by_family
                .entry(format!(
                    "{} — {}",
                    source_key(connector.source),
                    shape_family(connector)
                ))
                .or_default() += n;
            if connector.source == Source::Primitive {
                *tier2_shapes.entry(sections_key(connector)).or_default() += n;
            }
        }
        for issue in &extraction.issues {
            if let Issue::SectionDisagreement {
                origin,
                kept,
                lower,
            } = issue
            {
                if disagreements.len() < 400 {
                    disagreements.push(json!({
                        "part": part,
                        "title": title,
                        "origin": origin,
                        "tier1": shape_key(&kept.1),
                        "lower": shape_key(&lower.1),
                    }));
                }
            }
            let key = issue_key(issue);
            *by_issue.entry(key.clone()).or_default() += 1;
            let examples = issue_examples.entry(key).or_default();
            if examples.len() < EXAMPLES && !examples.contains(part) {
                examples.push(part.clone());
            }
        }
        let tally = tallies.entry(category(&title)).or_default();
        tally.parts += 1;
        tally.with_connectors += usize::from(!extraction.connectors.is_empty());
        tally.with_female += usize::from(
            extraction
                .connectors
                .iter()
                .any(|c| gender_of(c) == Some(Gender::Female)),
        );
        if extraction.connectors.is_empty() && tally.examples_without.len() < EXAMPLES {
            tally.examples_without.push(part.clone());
        }
        let started_tier4 = Instant::now();
        let inference = tier4_alone.infer(&path);
        let alone_issues = inference.issues;
        let mut alone = inference.connectors;
        alone.extend(inference.off_lattice);
        tier4_timings.push((
            started_tier4.elapsed().as_secs_f64() * 1000.0,
            part.clone(),
            alone.len(),
        ));
        for issue in &alone_issues {
            if let Issue::Uninferred {
                reason: Uninferred::LooseCavity { clearance },
                ..
            } = issue
            {
                *loose
                    .entry((clearance * CLEARANCE_STEPS).round() as i64)
                    .or_default() += 1;
            }
        }
        let all_faces = faces_of(&extraction.connectors, None);
        let females: Vec<&MatingFace> = all_faces
            .iter()
            .filter(|f| f.gender == Gender::Female)
            .collect();
        let mut part_duplicates = 0;
        for (index, face) in females.iter().enumerate() {
            let earlier = females[..index].iter().find(|other| {
                dot(face.axis, other.axis) >= 1.0 - PARALLEL
                    && norm(sub(face.origin, other.origin)) <= SAME_LDU
            });
            if let Some(other) = earlier {
                part_duplicates += 1;
                let same_size = match (face.sections.first(), other.sections.first()) {
                    (Some(a), Some(b)) => a.code == b.code && (a.size - b.size).abs() <= SAME_LDU,
                    _ => false,
                };
                *duplicate_pairs
                    .entry(format!(
                        "{} then {}{}",
                        source_key(other.source),
                        source_key(face.source),
                        if same_size {
                            ", same section size"
                        } else {
                            ", different section"
                        }
                    ))
                    .or_default() += 1;
                if duplicate_examples.len() < 40 {
                    duplicate_examples.push(json!({
                        "part": part,
                        "at": face.origin,
                        "held": [source_key(other.source), other.sections.first().map(|s| s.length)],
                        "second": [source_key(face.source), face.sections.first().map(|s| s.length)],
                    }));
                }
            }
        }
        duplicate_faces[0] += part_duplicates;
        duplicate_faces[1] += usize::from(part_duplicates > 0);
        let inferred_kept = faces_of(&extraction.connectors, Some(Source::Inferred));
        let before_any = extraction
            .connectors
            .iter()
            .any(|c| c.source != Source::Inferred);
        let before_female = extraction
            .connectors
            .iter()
            .any(|c| c.source != Source::Inferred && gender_of(c) == Some(Gender::Female));
        let after_female = extraction
            .connectors
            .iter()
            .any(|c| gender_of(c) == Some(Gender::Female));
        let cell = coverage.entry(category(&title)).or_default();
        cell.parts += 1;
        cell.before += usize::from(before_any);
        cell.after += usize::from(!extraction.connectors.is_empty());
        cell.before_female += usize::from(before_female);
        cell.after_female += usize::from(after_female);
        cell.inferred_faces += inferred_kept.len();
        cell.completed += usize::from(extraction.curated && !inferred_kept.is_empty());
        if !before_any && !extraction.connectors.is_empty() {
            cell.gained += 1;
            if cell.examples_gained.len() < EXAMPLES {
                cell.examples_gained.push(part.clone());
            }
        }
        if extraction.connectors.is_empty() && cell.examples_without.len() < EXAMPLES {
            cell.examples_without.push(part.clone());
        }
        let mut found = Vec::new();
        features(&library, &path, &Affine::IDENTITY, 0, &mut found);
        let tubes_here: Vec<Affine> = found
            .iter()
            .filter(|(feature, _, _)| *feature == Feature::Tube)
            .map(|(_, _, at)| *at)
            .collect();
        if extraction.curated {
            let curated_faces = faces_of(&extraction.connectors, Some(Source::Shadow));
            let alone_faces = faces_of(&alone, None);
            let curated_keys: HashMap<FaceKey, &MatingFace> =
                curated_faces.iter().map(|f| (face_key(f), f)).collect();
            let inferred_keys: std::collections::HashSet<FaceKey> =
                alone_faces.iter().map(face_key).collect();
            oracle.parts += 1;
            for face in &alone_faces {
                oracle.inferred += 1;
                let family = oracle
                    .inferred_by_family
                    .entry(face_family(face))
                    .or_default();
                family[0] += 1;
                match curated_keys.get(&face_key(face)) {
                    Some(kept) => {
                        oracle.inferred_matching += 1;
                        family[1] += 1;
                        *oracle
                            .agreement
                            .entry(section_agreement(kept, face))
                            .or_default() += 1;
                    }
                    None => {
                        let at_tube = tubes_here.iter().any(|at| on_tube_axis(at, face));
                        let curator_covers_gender =
                            curated_faces.iter().any(|f| f.gender == face.gender);
                        let kind = match (at_tube, curator_covers_gender) {
                            (true, _) => "tube interior (tier 1's tube snap is commented out)",
                            (false, false) => "gap fill: tier 1 has no face of this gender",
                            (false, true) => "unmatched where tier 1 covers this gender",
                        };
                        *oracle.unmatched.entry(kind).or_default() += 1;
                        if !at_tube && curator_covers_gender {
                            *oracle.false_positive_parts.entry(part.clone()).or_default() += 1;
                            let nearest = curated_faces
                                .iter()
                                .filter(|f| f.gender == face.gender)
                                .min_by(|a, b| {
                                    norm(sub(a.origin, face.origin))
                                        .total_cmp(&norm(sub(b.origin, face.origin)))
                                });
                            let column_mate = curated_faces.iter().find(|f| {
                                let v = sub(f.origin, face.origin);
                                f.gender == face.gender
                                    && dot(f.axis, face.axis) >= 1.0 - PARALLEL
                                    && norm(sub(v, face.axis.map(|c| c * dot(v, face.axis))))
                                        <= SAME_LDU
                            });
                            if disagreeing_faces.len() < 5000 {
                                disagreeing_faces.push(json!({
                                    "part": part,
                                    "title": title,
                                    "category": category(&title),
                                    "family": face_family(face),
                                    "origin": face.origin,
                                    "axis": face.axis,
                                    "sections": face.sections.iter().map(|s| [f64::from(s.code), s.size, s.length]).collect::<Vec<_>>(),
                                    "caps": face.caps,
                                    "nearestTier1": nearest.map(|f| json!({
                                        "distance": norm(sub(f.origin, face.origin)),
                                        "origin": f.origin,
                                        "axis": f.axis,
                                        "sections": f.sections.iter().map(|s| [f64::from(s.code), s.size, s.length]).collect::<Vec<_>>(),
                                    })),
                                    "tier1OnTheSameAxisLine": column_mate.map(|f| json!({ "origin": f.origin, "axis": f.axis })),
                                }));
                            }
                        }
                    }
                }
            }
            for face in &curated_faces {
                let family = oracle
                    .curated_by_family
                    .entry(face_family(face))
                    .or_default();
                family[0] += 1;
                family[1] += usize::from(inferred_keys.contains(&face_key(face)));
            }
        }
        if focus.contains(part) {
            let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
            for face in &all_faces {
                *by_kind
                    .entry(format!(
                        "{} — {}",
                        source_key(face.source),
                        face_family(face)
                    ))
                    .or_default() += 1;
            }
            let listed = |faces: &[MatingFace]| -> Vec<Value> {
                faces
                    .iter()
                    .map(|f| {
                        json!({
                            "source": source_key(f.source),
                            "family": face_family(f),
                            "origin": f.origin,
                            "axis": f.axis,
                            "sections": f.sections.iter().map(|s| [f64::from(s.code), s.size, s.length]).collect::<Vec<_>>(),
                            "caps": f.caps,
                        })
                    })
                    .collect()
            };
            focused.push(json!({
                "part": part,
                "title": title,
                "faces": table(by_kind),
                "kept": listed(&all_faces),
                "tier4Alone": listed(&faces_of(&alone, None)),
                "tier4Issues": alone_issues.iter().map(|i| format!("{i:?}")).collect::<Vec<_>>(),
            }));
        }
        let axles: Vec<&(Feature, String, Affine)> =
            found.iter().filter(|f| f.0 == Feature::Axle).collect();
        if !axles.is_empty() {
            let uncovered = axles
                .iter()
                .filter(|(_, _, at)| !axle_connector(at, &all_faces))
                .count();
            axle_census[0] += 1;
            axle_census[1] += axles.len();
            axle_census[2] += uncovered;
            axle_census[3] += usize::from(uncovered > 0);
            if uncovered > 0 && axle_examples.len() < 40 {
                axle_examples.push(json!({ "part": part, "title": title, "axleFeatures": axles.len(), "withoutAxleConnector": uncovered }));
            }
            let mut outside_any = false;
            for (_, primitive, at) in &axles {
                let outside = !inside_axle_connector(at, &all_faces);
                let counts = axle_by_primitive.entry(primitive.clone()).or_default();
                counts[0] += 1;
                counts[1] += usize::from(outside);
                outside_any |= outside;
            }
            if outside_any {
                axle_parts_with_a_primitive_outside.push(part.clone());
            }
            if !all_faces
                .iter()
                .any(|f| f.sections.iter().any(|s| s.code == 1))
            {
                axle_parts_without_any.push(part.clone());
            }
        }
        for (feature, primitive, at) in found {
            if feature == Feature::Axle {
                continue;
            }
            if feature == Feature::Tube {
                let verdict = match (tube_receptor(&at, &all_faces), extraction.curated) {
                    (Some(Source::Inferred), true) => "curated part: tier 4 receptor",
                    (Some(Source::Inferred), false) => "uncurated part: tier 4 receptor",
                    (Some(_), _) => "receptor from tier 1 or 2",
                    (None, true) => "curated part: no receptor",
                    (None, false) => "uncurated part: no receptor",
                };
                *tubes.entry(verdict.to_string()).or_default() += 1;
                if verdict.ends_with("no receptor") && tube_examples.len() < 40 {
                    tube_examples.push(json!({
                        "part": part,
                        "title": title,
                        "tube": primitive,
                        "at": y_up_point(translation(&at)),
                    }));
                }
                continue;
            }
            let label = match feature {
                Feature::Stud => "male stud primitive (#247 census) → male cylinder at its frame",
                Feature::HoleEnd => "peghole.dat → coaxial female cylinder",
                Feature::Tube | Feature::Axle => continue,
            };
            let entry = checks.entry(label).or_default();
            entry[0] += 1;
            if agrees(feature, &at, &extraction.connectors) {
                entry[1] += 1;
            } else if misses.len() < 400 {
                misses.push(json!({
                    "part": part,
                    "title": title,
                    "primitive": primitive,
                    "at": y_up_point(translation(&at)),
                    "curated": extraction.curated,
                }));
            }
        }
        if extraction.curated {
            let tube_candidates = tier2_alone.where_open(&path);
            let opened = tier4_alone.open(&path, tube_candidates);
            let curated_female: std::collections::HashSet<FaceKey> =
                faces_of(&extraction.connectors, Some(Source::Shadow))
                    .iter()
                    .filter(|f| f.gender == Gender::Female)
                    .map(face_key)
                    .collect();
            if !curated_female.is_empty() {
                for face in faces_of(&opened.connectors, None) {
                    tube_oracle[0] += 1;
                    tube_oracle[1] += usize::from(curated_female.contains(&face_key(&face)));
                }
            }
            let (alone, _) = tier2_alone.connectors(&path);
            for candidate in &alone {
                cross[0] += 1;
                let matched = extraction.connectors.iter().any(|existing| {
                    existing.source == Source::Shadow
                        && gender_of(existing) == gender_of(candidate)
                        && poses(existing).iter().any(|p| {
                            poses(candidate).iter().any(|q| {
                                let v = sub(q.origin, p.origin);
                                dot(p.axis, q.axis).abs() >= 1.0 - PARALLEL
                                    && norm(sub(v, p.axis.map(|c| c * dot(v, p.axis)))) <= SAME_LDU
                            })
                        })
                });
                if matched {
                    cross[1] += 1;
                } else if cross_misses.len() < 100 {
                    cross_misses.push(json!({
                        "part": part,
                        "title": title,
                        "tier2": sections_key(candidate),
                        "at": translation(&candidate.placement),
                    }));
                }
            }
        }
    }
    let mut sorted: Vec<f64> = timings.iter().map(|t| t.0).collect();
    sorted.sort_by(f64::total_cmp);
    let pick = |p: f64| {
        sorted
            .get(((sorted.len() as f64 - 1.0) * p).round() as usize)
            .copied()
            .unwrap_or(0.0)
    };
    timings.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut tier4_sorted: Vec<f64> = tier4_timings.iter().map(|t| t.0).collect();
    tier4_sorted.sort_by(f64::total_cmp);
    let tier4_pick = |p: f64| {
        tier4_sorted
            .get(((tier4_sorted.len() as f64 - 1.0) * p).round() as usize)
            .copied()
            .unwrap_or(0.0)
    };
    tier4_timings.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut false_positive_parts: Vec<(String, usize)> =
        oracle.false_positive_parts.clone().into_iter().collect();
    false_positive_parts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let disagreeing = oracle
        .unmatched
        .get("unmatched where tier 1 covers this gender")
        .copied()
        .unwrap_or(0);
    let strict_precision =
        oracle.inferred_matching as f64 / (oracle.inferred_matching + disagreeing).max(1) as f64;
    let tier4 = json!({
        "coverageByCategory": coverage.iter().map(|(k, c)| json!({
            "category": k,
            "parts": c.parts,
            "withConnectorsBefore": c.before,
            "withConnectorsAfter": c.after,
            "withFemaleBefore": c.before_female,
            "withFemaleAfter": c.after_female,
            "partsGainingTheirFirstConnector": c.gained,
            "curatedPartsCompleted": c.completed,
            "inferredFacesKept": c.inferred_faces,
            "examplesGained": c.examples_gained,
            "examplesStillWithout": c.examples_without,
        })).collect::<Vec<_>>(),
        "oracleOnCuratedParts": {
            "parts": oracle.parts,
            "inferredFaces": oracle.inferred,
            "inferredFacesAtATier1Face": oracle.inferred_matching,
            "precision": oracle.inferred_matching as f64 / oracle.inferred.max(1) as f64,
            "unmatchedInferredFaces": oracle.unmatched.iter().map(|(k, v)| json!({ "kind": k, "count": v })).collect::<Vec<_>>(),
            "precisionWhereTier1CoversTheGender": strict_precision,
            "inferredByFamily": oracle.inferred_by_family.iter().map(|(k, v)| json!({ "family": k, "inferred": v[0], "atATier1Face": v[1] })).collect::<Vec<_>>(),
            "tier1ByFamily": oracle.curated_by_family.iter().map(|(k, v)| json!({ "family": k, "tier1": v[0], "alsoInferred": v[1], "recall": v[1] as f64 / v[0].max(1) as f64 })).collect::<Vec<_>>(),
            "sectionsAtMatchedFaces": oracle.agreement.iter().map(|(k, v)| json!({ "kind": k, "count": v })).collect::<Vec<_>>(),
            "partsWithMostUnmatchedInferredFacesWhereTier1CoversTheGender": false_positive_parts.iter().take(40).map(|(p, n)| json!({ "part": p, "unmatched": n })).collect::<Vec<_>>(),
        },
        "tubeNeighbourReceptorsOnCuratedPartsWithFemales": { "emitted": tube_oracle[0], "atATier1Female": tube_oracle[1] },
        "tubeInteriors": table(tubes),
        "femaleFacesHeldTwice": {
            "faces": duplicate_faces[0],
            "parts": duplicate_faces[1],
            "byPair": table(duplicate_pairs),
            "examples": duplicate_examples,
        },
        "axleFeatures": {
            "partsWithAxlePrimitives": axle_census[0],
            "axlePrimitives": axle_census[1],
            "axlePrimitivesWithoutAnAxleConnector": axle_census[2],
            "partsLeftWithoutAxleConnectors": axle_census[3],
            "examples": axle_examples,
            "partsWithAxlePrimitivesAndNoAxleConnector": axle_parts_without_any,
            "partsWithAnAxlePrimitiveOutsideEveryAxleConnector": axle_parts_with_a_primitive_outside,
            "byPrimitive": axle_by_primitive.iter().map(|(k, v)| json!({ "primitive": k, "instances": v[0], "outsideEveryAxleConnector": v[1] })).collect::<Vec<_>>(),
        },
        "disagreeingInferredFaces": disagreeing_faces,
        "tubeInteriorExamplesWithoutReceptor": tube_examples,
        "looseCavityClearancesLdu": loose.iter().map(|(k, v)| json!({ "clearance": *k as f64 / CLEARANCE_STEPS, "count": v })).collect::<Vec<_>>(),
        "focus": focused,
        "timingMs": {
            "total": tier4_sorted.iter().sum::<f64>(),
            "median": tier4_pick(0.5),
            "p95": tier4_pick(0.95),
            "max": tier4_sorted.last(),
            "slowest": tier4_timings.iter().take(8).map(|t| json!({ "part": t.1, "ms": t.0, "connectors": t.2 })).collect::<Vec<_>>(),
        },
    });
    let report = json!({
        "tier4": tier4,
        "parts": list.len(),
        "extracted": counts[0],
        "unresolved": counts[4],
        "withConnectors": counts[1],
        "curated": counts[2],
        "withTier2": counts[3],
        "curatedCompletedByTier2": completed_count,
        "connectorPosesBySource": table(by_source),
        "connectorPosesByFamily": table(by_family),
        "tier2Shapes": table(tier2_shapes),
        "curatedPartsCompletedByTier2": completed,
        "lowerTierFillsAtCommentedOutSnaps": commented_fills,
        "lowerTierFillsAtCommentedOutSnapsByTier": commented_fill_counts,
        "sectionDisagreements": disagreements,
        "tier2AgainstTier1OnCuratedParts": {
            "tier2Connectors": cross[0],
            "coaxialWithATier1Connector": cross[1],
            "misses": cross_misses,
        },
        "checks": checks.iter().map(|(k, v)| json!({ "check": k, "features": v[0], "agree": v[1] })).collect::<Vec<_>>(),
        "checkMisses": misses,
        "byCategory": tallies.iter().map(|(k, t)| json!({
            "category": k,
            "parts": t.parts,
            "withConnectors": t.with_connectors,
            "withFemale": t.with_female,
            "examplesWithout": t.examples_without,
        })).collect::<Vec<_>>(),
        "issues": table(by_issue),
        "issueExamples": issue_examples,
        "timingMs": {
            "total": sorted.iter().sum::<f64>(),
            "median": pick(0.5),
            "p95": pick(0.95),
            "max": sorted.last(),
            "slowest": timings.iter().take(5).map(|t| json!({ "part": t.1, "ms": t.0, "connectors": t.2 })).collect::<Vec<_>>(),
        },
    });
    if let Some(path) = values.get("--timings") {
        let lines: String = tier4_timings
            .iter()
            .map(|(ms, part, _)| format!("{part} {ms}\n"))
            .collect();
        fs::write(path, lines).map_err(|e| format!("{path}: {e}"))?;
    }
    let out = take("--out")?;
    fs::write(
        &out,
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("{out}: {e}"))
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("connector-audit: {message}");
            ExitCode::FAILURE
        }
    }
}
