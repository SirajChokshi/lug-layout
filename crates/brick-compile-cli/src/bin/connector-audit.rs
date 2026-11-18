use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use brick_compile::affine::{Affine, Vec3};
use brick_compile::connect::{
    Connector, ConnectorExtractor, Gender, Issue, PrimitiveConnectors, PrimitiveTable,
    SectionShape, ShadowSnaps, Shape, Source,
};
use brick_compile::flatten::{resolve_reference, Library, Lod};
use brick_compile::ldraw::{parse, Line};
use serde_json::{json, Value};

const SAME_LDU: f64 = 0.01;
const PARALLEL: f64 = 1e-6;
const MALE_STUD_TITLES: [&str; 3] = ["Stud", "Stud Open", "Stud Truncated"];
const HOLE_END: &str = "p/peghole.dat";
const MOVED: &str = "~Moved";
const EXAMPLES: usize = 12;

struct LazyLibrary {
    root: PathBuf,
    loaded: RefCell<HashMap<String, Option<&'static str>>>,
}

impl LazyLibrary {
    fn new(root: PathBuf) -> Self {
        LazyLibrary {
            root,
            loaded: RefCell::new(HashMap::new()),
        }
    }
}

impl Library for LazyLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        if let Some(found) = self.loaded.borrow().get(path) {
            return *found;
        }
        let found: Option<&'static str> = fs::read(self.root.join(path)).ok().map(|bytes| {
            &*Box::leak(
                String::from_utf8_lossy(&bytes)
                    .into_owned()
                    .into_boxed_str(),
            )
        });
        self.loaded.borrow_mut().insert(path.to_string(), found);
        found
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Feature {
    Stud,
    HoleEnd,
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
        })
    })
}

fn sections_key(connector: &Connector) -> String {
    match &connector.shape {
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
    }
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

fn run() -> Result<(), String> {
    let mut values = HashMap::new();
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        values.insert(flag, raw.next().unwrap_or_default());
    }
    let take = |k: &str| values.get(k).cloned().ok_or(format!("missing {k}"));
    let ldraw = PathBuf::from(take("--ldraw")?);
    let library = LazyLibrary::new(ldraw.clone());
    let shadow = LazyLibrary::new(PathBuf::from(take("--shadow")?));
    let table_path = take("--primitives")?;
    let table_json: Value =
        serde_json::from_slice(&fs::read(&table_path).map_err(|e| format!("{table_path}: {e}"))?)
            .map_err(|e| format!("{table_path}: {e}"))?;
    let primitive_table = PrimitiveTable::from_json(&table_json)?;
    let list = parts(&values, &ldraw)?;
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, primitive_table.clone()),
    );
    let mut tier2_alone = PrimitiveConnectors::new(&library, primitive_table);
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
        let mut found = Vec::new();
        features(&library, &path, &Affine::IDENTITY, 0, &mut found);
        for (feature, primitive, at) in found {
            let label = match feature {
                Feature::Stud => "male stud primitive (#247 census) → male cylinder at its frame",
                Feature::HoleEnd => "peghole.dat → coaxial female cylinder",
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
    let report = json!({
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
