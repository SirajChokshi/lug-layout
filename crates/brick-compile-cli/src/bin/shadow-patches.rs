use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::affine::Vec3;
use brick_compile::bands::{end_faces, outward_round_bands, EndFace};
use brick_compile::connect::{mating_faces, Gender, ShadowPatches, ShadowSnaps, Source, Status};
use brick_compile::flatten::{resolve_reference, Flattener, Library, Lod};
use brick_compile::ldraw::{parse, Line};
use brick_compile::sixteenths;
use brick_compile::technic::is_circular_primitive;
use brick_compile_cli::LazyLibrary;
use serde_json::{json, Value};

const WIDEST_BAND_END_FACES: &str = "widestOutwardRoundBandEndFaces";
const PART_FOLDER: &str = "parts/";
const LDRAW_LIBRARY: &str = "ldraw-library";
const DECIMALS: usize = 4;
const IDENTIFY_LDU: f64 = 0.0005;
const VERIFIED: &str = "verified";
const UNVERIFIED: &str = "unverified";

struct Entry {
    part: String,
    id: String,
    group: String,
    feature: String,
    status: String,
    added: String,
}

struct Measured {
    title: String,
    band: Value,
    faces: [EndFace; 2],
    clears: Vec<String>,
}

struct MemoryLibrary(HashMap<String, String>);

impl Library for MemoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }
}

enum ShadowFiles<'a> {
    Directory(&'a LazyLibrary),
    Generated(&'a MemoryLibrary),
}

impl Library for ShadowFiles<'_> {
    fn source(&self, path: &str) -> Option<&str> {
        match self {
            ShadowFiles::Directory(files) => files.source(path),
            ShadowFiles::Generated(files) => files.source(path),
        }
    }
}

fn text(value: &Value, key: &str) -> Result<String, String> {
    value[key]
        .as_str()
        .map(str::to_string)
        .ok_or(format!("manifest entry needs a string {key}"))
}

fn entries(manifest: &Value) -> Result<Vec<Entry>, String> {
    manifest["patches"]
        .as_array()
        .ok_or("manifest needs a patches array")?
        .iter()
        .map(|entry| {
            let status = text(entry, "status")?;
            if status != VERIFIED && status != UNVERIFIED {
                return Err(format!(
                    "status must be {VERIFIED} or {UNVERIFIED}, not {status}"
                ));
            }
            Ok(Entry {
                part: text(entry, "part")?,
                id: text(entry, "id")?,
                group: text(entry, "group")?,
                feature: text(entry, "feature")?,
                status,
                added: text(entry, "added")?,
            })
        })
        .collect()
}

fn patch_path(part: &str) -> String {
    format!("{PART_FOLDER}{part}.dat")
}

fn number(v: f64) -> String {
    let fixed = format!("{:.*}", DECIMALS, v + 0.0);
    let trimmed = fixed.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn written(v: f64) -> Result<f64, String> {
    let shown: f64 = number(v).parse().map_err(|e| format!("{v}: {e}"))?;
    if (shown - v).abs() > IDENTIFY_LDU {
        return Err(format!(
            "{v} has no {DECIMALS}-decimal form within {IDENTIFY_LDU} LDU"
        ));
    }
    Ok(shown)
}

fn identified_radius(r: f64) -> Result<f64, String> {
    sixteenths::identified(r)
        .map(|steps| f64::from(steps) / f64::from(sixteenths::PER_LDU))
        .ok_or(format!(
            "radius {r} is not within {IDENTIFY_LDU} LDU of a 1/{} LDU step",
            sixteenths::PER_LDU
        ))
}

fn vector(v: Vec3) -> Value {
    json!(v.map(|c| number(c).parse::<f64>().unwrap_or(c)))
}

fn title(library: &LazyLibrary, path: &str) -> Result<String, String> {
    let source = library
        .source(path)
        .ok_or(format!("{path} is not in the library"))?;
    source
        .lines()
        .next()
        .and_then(|line| line.trim().strip_prefix('0'))
        .map(|rest| rest.trim().to_string())
        .ok_or(format!("{path} has no title line"))
}

fn closure(library: &LazyLibrary, path: &str, seen: &mut BTreeSet<String>) {
    let Some(source) = library.source(path) else {
        return;
    };
    for line in parse(source).lines {
        if let Line::Subfile { reference, .. } = line {
            if let Some(child) = resolve_reference(library, Lod::Standard, &reference) {
                if seen.insert(child.clone()) {
                    closure(library, &child, seen);
                }
            }
        }
    }
}

fn measure(
    library: &LazyLibrary,
    entry: &Entry,
    patched: &HashSet<String>,
) -> Result<Measured, String> {
    if entry.feature != WIDEST_BAND_END_FACES {
        return Err(format!("{}: unknown feature {}", entry.part, entry.feature));
    }
    let path = patch_path(&entry.part);
    let records = |reference: &str| is_circular_primitive(reference);
    let flattened = Flattener::new(library, Lod::Standard, &[])
        .recording_spans(&records)
        .flatten(&path)
        .map_err(|e| format!("{path}: {e:?}"))?;
    let bands = outward_round_bands(&flattened.spans, &flattened.triangles);
    let widest = bands
        .iter()
        .map(|band| band.radius)
        .fold(f64::NEG_INFINITY, f64::max);
    let candidates: Vec<_> = bands
        .iter()
        .filter(|band| (band.radius - widest).abs() <= IDENTIFY_LDU)
        .collect();
    let [band] = candidates.as_slice() else {
        return Err(format!(
            "{path}: {} outward round bands share the widest radius",
            candidates.len()
        ));
    };
    let faces = end_faces(band, &flattened.triangles)
        .ok_or(format!("{path}: the widest band has no planar end faces"))?;
    let mut inside = BTreeSet::new();
    closure(library, &path, &mut inside);
    Ok(Measured {
        title: title(library, &path)?,
        band: json!({
            "point": vector(band.point),
            "axis": vector(band.axis),
            "radius": identified_radius(band.radius)?,
            "from": written(band.from)?,
            "to": written(band.to)?,
        }),
        faces,
        clears: inside.into_iter().filter(|p| patched.contains(p)).collect(),
    })
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn unit(v: Vec3) -> Vec3 {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    v.map(|c| c / l + 0.0)
}

fn male_frame(normal: Vec3) -> [Vec3; 3] {
    let basis = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let across = basis
        .into_iter()
        .min_by(|a, b| {
            let along = |e: &Vec3| (e[0] * normal[0] + e[1] * normal[1] + e[2] * normal[2]).abs();
            along(a).total_cmp(&along(b))
        })
        .unwrap_or(basis[0]);
    let d = across[0] * normal[0] + across[1] * normal[1] + across[2] * normal[2];
    let x = unit([0, 1, 2].map(|k| across[k] - d * normal[k]));
    let y = normal.map(|c| -c + 0.0);
    [x, y, cross(x, y)]
}

fn ori(columns: [Vec3; 3]) -> String {
    (0..3)
        .flat_map(|row| columns.iter().map(move |column| number(column[row])))
        .collect::<Vec<_>>()
        .join(" ")
}

fn snap_line(entry: &Entry, gender: Gender, face: &EndFace) -> Result<String, String> {
    let [x, y, z] = male_frame(face.normal);
    let (letter, columns) = match gender {
        Gender::Male => ("M", [x, y, z]),
        Gender::Female => ("F", [x, y.map(|c| -c + 0.0), z.map(|c| -c + 0.0)]),
    };
    let pos: Vec<String> = face
        .origin
        .iter()
        .map(|&c| written(c).map(number))
        .collect::<Result<_, _>>()?;
    Ok(format!(
        "0 !LDCAD SNAP_GEN [id={}] [group={}] [gender={letter}] [bounding=cyl {} 0] [match=group] [pos={}] [ori={}]",
        entry.id,
        entry.group,
        number(identified_radius(face.radius)?),
        pos.join(" "),
        ori(columns),
    ))
}

fn patch_text(entry: &Entry, measured: &Measured, source: &Value) -> Result<String, String> {
    let commit = source["commit"].as_str().unwrap_or_default();
    let mut lines = vec![
        format!("0 LDCad shadow info for \"{}\"", measured.title),
        String::new(),
        "0 Author: Brick Railroad project additions".to_string(),
        "0 !LICENSE CC BY-SA 4.0, see LICENSE.md".to_string(),
        String::new(),
        format!(
            "0 !HISTORY {} {{Brick Railroad}} Measured from {}@{} geometry",
            entry.added,
            source["repo"].as_str().unwrap_or_default(),
            &commit[..commit.len().min(8)],
        ),
        String::new(),
    ];
    if !measured.clears.is_empty() {
        lines.push(format!("0 !LDCAD SNAP_CLEAR [id={}]", entry.id));
    }
    for face in &measured.faces {
        lines.push(snap_line(entry, Gender::Male, face)?);
        lines.push(snap_line(entry, Gender::Female, face)?);
    }
    Ok(lines.join("\n") + "\n")
}

fn y_up(v: Vec3) -> Vec3 {
    [v[0], -v[1], -v[2]].map(|c| c + 0.0)
}

fn round_trip(
    library: &LazyLibrary,
    shadow: &MemoryLibrary,
    patches: &MemoryLibrary,
    verified: &HashSet<String>,
    entry: &Entry,
    measured: &Measured,
) -> Result<(), String> {
    let path = patch_path(&entry.part);
    let extraction = ShadowSnaps::new(library, shadow)
        .patched(ShadowPatches {
            files: patches,
            verified,
        })
        .snaps(&path);
    let status = if entry.status == VERIFIED {
        Status::Verified
    } else {
        Status::Unverified
    };
    let mut faces = Vec::new();
    for connector in extraction
        .connectors
        .iter()
        .filter(|c| c.source == Source::Patch)
    {
        faces.extend(mating_faces(connector).map_err(|e| format!("{path}: {e:?}"))?);
    }
    for face in &measured.faces {
        for gender in [Gender::Male, Gender::Female] {
            let found = faces.iter().filter(|f| {
                f.gender == gender
                    && f.status == status
                    && f.group.as_deref() == Some(entry.group.as_str())
                    && (0..3).all(|k| {
                        (f.origin[k] - y_up(face.origin)[k]).abs() <= IDENTIFY_LDU
                            && (f.axis[k] - y_up(face.normal)[k]).abs() <= IDENTIFY_LDU
                    })
                    && f.sections.len() == 1
                    && identified_radius(face.radius).is_ok_and(|r| f.sections[0].size == r)
                    && f.sections[0].length == 0.0
                    && f.caps == 0
                    && !f.slide
            });
            if found.count() != 1 {
                return Err(format!(
                    "{path}: the patch does not read back as one {gender:?} face at {:?}",
                    face.origin
                ));
            }
        }
    }
    if faces.len() != 2 * measured.faces.len() {
        return Err(format!(
            "{path}: the patch reads back as {} faces",
            faces.len()
        ));
    }
    Ok(())
}

fn referrers(root: &Path) -> Result<HashMap<String, BTreeSet<String>>, String> {
    let mut by_child: HashMap<String, BTreeSet<String>> = HashMap::new();
    for folder in ["parts", "parts/s"] {
        let listing = fs::read_dir(root.join(folder)).map_err(|e| format!("{folder}: {e}"))?;
        for entry in listing.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.ends_with(".dat") {
                continue;
            }
            let path = format!("{folder}/{name}");
            let Ok(source) = fs::read_to_string(entry.path()) else {
                continue;
            };
            for line in parse(&source).lines {
                if let Line::Subfile { reference, .. } = line {
                    let child = reference.replace('\\', "/").to_lowercase();
                    for candidate in [format!("parts/{child}"), format!("p/{child}")] {
                        by_child.entry(candidate).or_default().insert(path.clone());
                    }
                }
            }
        }
    }
    Ok(by_child)
}

fn coverage(
    ldraw: &Path,
    library: &LazyLibrary,
    shadow: &LazyLibrary,
    patches: &MemoryLibrary,
    verified: &HashSet<String>,
    patched: &HashSet<String>,
) -> Result<Value, String> {
    let by_child = referrers(ldraw)?;
    let mut reached: BTreeSet<String> = patched.iter().cloned().collect();
    let mut queue: Vec<String> = reached.iter().cloned().collect();
    while let Some(path) = queue.pop() {
        for parent in by_child.get(&path).into_iter().flatten() {
            if reached.insert(parent.clone()) {
                queue.push(parent.clone());
            }
        }
    }
    let upstream = ShadowFiles::Directory(shadow);
    let generated = ShadowFiles::Generated(patches);
    let mut snaps = ShadowSnaps::new(library, &upstream).patched(ShadowPatches {
        files: &generated,
        verified,
    });
    let mut rows = Vec::new();
    for path in reached {
        let extraction = snaps.snaps(&path);
        let mut faces = Vec::new();
        for connector in extraction
            .connectors
            .iter()
            .filter(|c| c.source == Source::Patch)
        {
            for face in mating_faces(connector).map_err(|e| format!("{path}: {e:?}"))? {
                faces.push(json!({
                    "gender": format!("{:?}", face.gender),
                    "origin": vector(face.origin),
                    "sixteenths": face.sixteenths,
                    "axis": vector(face.axis),
                    "radius": face.sections.first().map(|s| s.size),
                    "status": format!("{:?}", face.status),
                }));
            }
        }
        rows.push(json!({
            "part": path,
            "title": title(library, &path).unwrap_or_default(),
            "patched": patched.contains(&path),
            "faces": faces,
        }));
    }
    Ok(Value::Array(rows))
}

fn ldraw_source(lock: &Value) -> Result<Value, String> {
    let entry = &lock["catalog"][LDRAW_LIBRARY];
    let files = entry["files"]
        .as_object()
        .ok_or("lock has no pinned LDraw archive")?;
    let (archive, sha256) = files
        .iter()
        .next()
        .ok_or("lock pins no LDraw archive file")?;
    Ok(json!({
        "repo": entry["source"]["repo"],
        "commit": entry["source"]["commit"],
        "archive": archive,
        "sha256": sha256,
    }))
}

fn run() -> Result<bool, String> {
    let mut values = HashMap::new();
    let mut check = false;
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        if flag == "--check" {
            check = true;
        } else {
            values.insert(flag, raw.next().unwrap_or_default());
        }
    }
    let take = |k: &str| values.get(k).cloned().ok_or(format!("missing {k}"));
    let ldraw_root = PathBuf::from(take("--ldraw")?);
    let library = LazyLibrary::new(ldraw_root.clone());
    let patches_root = PathBuf::from(take("--patches")?);
    let manifest_path = patches_root.join("manifest.json");
    let read_json = |path: &Path| -> Result<Value, String> {
        serde_json::from_slice(&fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
            .map_err(|e| format!("{}: {e}", path.display()))
    };
    let mut manifest = read_json(&manifest_path)?;
    let source = ldraw_source(&read_json(Path::new(&take("--lock")?))?)?;
    let list = entries(&manifest)?;
    let patched: HashSet<String> = list.iter().map(|e| patch_path(&e.part)).collect();
    let verified: HashSet<String> = list
        .iter()
        .filter(|e| e.status == VERIFIED)
        .map(|e| patch_path(&e.part))
        .collect();
    let mut texts = HashMap::new();
    let mut measured_all = Vec::new();
    for entry in &list {
        let measured = measure(&library, entry, &patched)?;
        texts.insert(
            patch_path(&entry.part),
            patch_text(entry, &measured, &source)?,
        );
        measured_all.push(measured);
    }
    let patch_library = MemoryLibrary(texts.clone());
    let no_upstream = MemoryLibrary(HashMap::new());
    for (entry, measured) in list.iter().zip(&measured_all) {
        round_trip(
            &library,
            &no_upstream,
            &patch_library,
            &verified,
            entry,
            measured,
        )?;
    }
    if let Some(report) = values.get("--report") {
        let shadow = LazyLibrary::new(PathBuf::from(take("--shadow")?));
        let rows = coverage(
            &ldraw_root,
            &library,
            &shadow,
            &patch_library,
            &verified,
            &patched,
        )?;
        let pretty = serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())? + "\n";
        fs::write(report, pretty).map_err(|e| format!("{report}: {e}"))?;
    }
    let mut updated = manifest.clone();
    updated["ldraw"] = source;
    if let Some(rows) = updated["patches"].as_array_mut() {
        for (row, measured) in rows.iter_mut().zip(&measured_all) {
            let faces: Vec<Value> = measured
                .faces
                .iter()
                .map(|face| {
                    Ok(json!({
                        "origin": face.origin.map(|c| written(c).unwrap_or(c)),
                        "normal": vector(face.normal),
                        "radius": identified_radius(face.radius)?,
                    }))
                })
                .collect::<Result<_, String>>()?;
            row["measured"] = json!({
                "title": measured.title,
                "band": measured.band,
                "faces": faces,
                "clearsInherited": measured.clears,
            });
        }
    }
    let mut drift = Vec::new();
    if updated != manifest {
        drift.push(manifest_path.display().to_string());
    }
    let mut paths: Vec<&String> = texts.keys().collect();
    paths.sort();
    for path in paths {
        let file = patches_root.join(path);
        if fs::read_to_string(&file).ok().as_ref() != texts.get(path) {
            drift.push(file.display().to_string());
        }
    }
    if check {
        for file in &drift {
            eprintln!("shadow-patches: {file} differs from its measurement");
        }
        return Ok(drift.is_empty());
    }
    manifest = updated;
    for (path, text) in &texts {
        let file = patches_root.join(path);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&file, text).map_err(|e| format!("{}: {e}", file.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())? + "\n";
    fs::write(&manifest_path, pretty).map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    for file in drift {
        println!("wrote {file}");
    }
    Ok(true)
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("shadow-patches: {error}");
            ExitCode::FAILURE
        }
    }
}
