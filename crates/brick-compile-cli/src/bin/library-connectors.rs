use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::connect::{
    is_connectivity, mating_faces, record_json, source_code, ConnectorExtractor, Extraction,
    InferredFeatures, PartRecords, PrimitiveConnectors, PrimitiveTable, ShadowPatches, ShadowSnaps,
    TierRecord,
};
use brick_compile::ldraw::parse;
use brick_compile::Library;
use brick_compile_cli::{read_section_vocabulary, verified_patch_paths, LazyLibrary};
use serde_json::{json, Value};

const CONNECTIVITY_LICENSE: &str = "CC BY-SA 4.0";
const PATCH_MANIFEST: &str = "manifest.json";
const PART_FOLDER: &str = "parts";
const PART_EXTENSION: &str = ".dat";
const PART_ID_PREFIX: &str = "ldraw:";
const PACKAGES: [&str; 2] = ["connectivity", "connectors"];

struct Args {
    ldraw: PathBuf,
    shadow: PathBuf,
    patches: PathBuf,
    primitives: PathBuf,
    inferred: PathBuf,
    vocabulary: PathBuf,
    out: PathBuf,
    shard: usize,
    shards: usize,
}

fn parse_args() -> Result<Args, String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let take = |flag: &str| -> Result<String, String> {
        argv.iter()
            .position(|a| a == flag)
            .and_then(|i| argv.get(i + 1))
            .cloned()
            .ok_or(format!("missing {flag}"))
    };
    let (shard, shards) = match take("--shard") {
        Ok(spec) => {
            let (k, n) = spec
                .split_once('/')
                .ok_or(format!("--shard {spec} is not k/n"))?;
            let k: usize = k.parse().map_err(|e| format!("--shard {spec}: {e}"))?;
            let n: usize = n.parse().map_err(|e| format!("--shard {spec}: {e}"))?;
            if n == 0 || k >= n {
                return Err(format!("--shard {spec} needs 0 <= k < n"));
            }
            (k, n)
        }
        Err(_) => (0, 1),
    };
    Ok(Args {
        ldraw: take("--ldraw")?.into(),
        shadow: take("--shadow")?.into(),
        patches: take("--patches")?.into(),
        primitives: take("--primitives")?.into(),
        inferred: take("--inferred")?.into(),
        vocabulary: take("--vocabulary")?.into(),
        out: take("--out")?.into(),
        shard,
        shards,
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn library_parts(root: &Path) -> Result<Vec<String>, String> {
    let folder = root.join(PART_FOLDER);
    let mut parts: Vec<String> = fs::read_dir(&folder)
        .map_err(|e| format!("{}: {e}", folder.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .map(|name| name.to_lowercase())
        .filter(|name| name.ends_with(PART_EXTENSION))
        .map(|name| format!("{PART_FOLDER}/{name}"))
        .collect();
    parts.sort();
    Ok(parts)
}

fn write_record(
    out: &Path,
    package: &str,
    stem: &str,
    part: &str,
    license: &str,
    record: &TierRecord,
) -> Result<Option<String>, String> {
    if record.is_empty() {
        return Ok(None);
    }
    let file = format!("{package}/{stem}.json");
    let text =
        serde_json::to_string(&record_json(part, license, record)).map_err(|e| e.to_string())?;
    fs::write(out.join(&file), text).map_err(|e| format!("{file}: {e}"))?;
    Ok(Some(file))
}

fn faces_of_several_pieces(extraction: &Extraction) -> Vec<Value> {
    let mut next = [0usize; 2];
    let mut found = Vec::new();
    for connector in &extraction.connectors {
        let package = usize::from(!is_connectivity(connector.source));
        let Ok(faces) = mating_faces(connector) else {
            continue;
        };
        for _ in faces {
            if connector.pieces.len() > 1 {
                let name = PACKAGES[package];
                found.push(json!({
                    "package": name,
                    "face": next[package],
                    "source": source_code(connector.source),
                    "pieces": connector.pieces,
                }));
            }
            next[package] += 1;
        }
    }
    found
}

fn run(args: &Args) -> Result<usize, String> {
    let library = LazyLibrary::new(args.ldraw.clone());
    let shadow = LazyLibrary::new(args.shadow.clone());
    let patch_files = LazyLibrary::new(args.patches.clone());
    let verified = verified_patch_paths(&read_json(&args.patches.join(PATCH_MANIFEST))?);
    let inferred = read_json(&args.inferred)?;
    let probe_part = inferred["cavityProbe"].as_str().ok_or(format!(
        "{}: cavityProbe must be a part path",
        args.inferred.display()
    ))?;
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow).patched(ShadowPatches {
            files: &patch_files,
            verified: &verified,
        }),
        PrimitiveConnectors::new(
            &library,
            PrimitiveTable::from_json(&read_json(&args.primitives)?)?,
        ),
        InferredFeatures::new(
            &library,
            read_section_vocabulary(&args.vocabulary)?,
            probe_part,
        )?,
    );
    for package in PACKAGES {
        fs::create_dir_all(args.out.join(package)).map_err(|e| e.to_string())?;
    }
    let parts = library_parts(&args.ldraw)?;
    let mut summary = String::new();
    let mut written = 0;
    for path in parts
        .iter()
        .enumerate()
        .filter(|(index, _)| index % args.shards == args.shard)
        .map(|(_, path)| path)
    {
        let stem = path
            .trim_start_matches(&format!("{PART_FOLDER}/"))
            .trim_end_matches(PART_EXTENSION);
        let part = format!("{PART_ID_PREFIX}{stem}");
        let license = library
            .source(path)
            .and_then(|source| parse(source).header.license)
            .unwrap_or_default();
        let extraction = extractor.extract(path);
        let records = PartRecords::of(&extraction);
        let connectivity = write_record(
            &args.out,
            "connectivity",
            stem,
            &part,
            CONNECTIVITY_LICENSE,
            &records.connectivity,
        )?;
        let connectors = write_record(
            &args.out,
            "connectors",
            stem,
            &part,
            &license,
            &records.connectors,
        )?;
        let line = json!({
            "part": part,
            "path": path,
            "license": license,
            "connectivity": connectivity,
            "connectors": connectors,
            "severalPieces": faces_of_several_pieces(&extraction),
        });
        summary.push_str(&line.to_string());
        summary.push('\n');
        written += 1;
    }
    let listing = args
        .out
        .join(format!("parts-{}-of-{}.jsonl", args.shard, args.shards));
    fs::write(&listing, summary).map_err(|e| format!("{}: {e}", listing.display()))?;
    Ok(written)
}

fn main() -> ExitCode {
    match parse_args().and_then(|args| run(&args)) {
        Ok(written) => {
            eprintln!("library-connectors: {written} parts");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("library-connectors: {message}");
            ExitCode::FAILURE
        }
    }
}
