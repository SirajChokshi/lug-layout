use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::Instant;

use brick_compile::bake::ModelBaker;
use brick_compile::colors::parse_ldconfig;
use brick_compile::compile::{rolling_mode_from_studs, stud_primitives_from_table};
use brick_compile::glyph::{GlyphBaker, StudMeshes};
use brick_compile::model::{bake_model_with, BakeOptions, ModelInstance};
use brick_compile::{compile_part, CompileOptions, Lod, TechnicPrimitives};
use brick_compile_cli::{library_parts, read_json, strings, DirectoryLibrary, PART_EXTENSION};
use serde_json::{json, Value};

const PART_ID_PREFIX: &str = "ldraw:";
const PART_FOLDER: &str = "parts";
const MODEL_FOLDER: &str = "models";
const GLYPH_EXTENSION: &str = ".glyph";
const LISTING: &str = "glyphs.json";
const OPAQUE_ALPHA: u8 = 255;

struct Args {
    ldraw: PathBuf,
    palette: PathBuf,
    primitives: PathBuf,
    ldconfig: PathBuf,
    geometry: PathBuf,
    models: Vec<PathBuf>,
    out: PathBuf,
    threads: usize,
}

fn parse_args() -> Result<Args, String> {
    let mut values: HashMap<String, String> = HashMap::new();
    let mut models = Vec::new();
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        let value = raw.next().ok_or(format!("missing value for {flag}"))?;
        if flag == "--model" {
            models.push(PathBuf::from(value));
        } else {
            values.insert(flag, value);
        }
    }
    let take = |key: &str| values.get(key).cloned().ok_or(format!("missing {key}"));
    let threads = match values.get("--threads") {
        Some(count) => count
            .parse::<usize>()
            .map_err(|e| format!("--threads {count}: {e}"))?,
        None => thread::available_parallelism().map_or(1, usize::from),
    };
    Ok(Args {
        ldraw: take("--ldraw")?.into(),
        palette: take("--palette")?.into(),
        primitives: take("--primitives")?.into(),
        ldconfig: take("--ldconfig")?.into(),
        geometry: take("--geometry")?.into(),
        models,
        out: take("--out")?.into(),
        threads: threads.max(1),
    })
}

struct Inputs {
    stud_primitives: Vec<String>,
    unofficial_allowlist: Vec<String>,
    translucent: HashSet<u32>,
    table_depth: f64,
    technic: Value,
}

impl Inputs {
    fn read(args: &Args) -> Result<Self, String> {
        let palette = read_json(&args.palette)?;
        let technic = read_json(&args.primitives)?;
        let geometry = read_json(&args.geometry)?;
        let ldconfig = fs::read_to_string(&args.ldconfig)
            .map_err(|e| format!("{}: {e}", args.ldconfig.display()))?;
        Ok(Inputs {
            stud_primitives: stud_primitives_from_table(&technic)?,
            unofficial_allowlist: strings(&palette, "unofficialAllowlist")?,
            translucent: parse_ldconfig(&ldconfig)
                .into_iter()
                .filter(|colour| colour.alpha < OPAQUE_ALPHA)
                .map(|colour| colour.code)
                .collect(),
            table_depth: geometry["tablePlane"]["depthBelowTopLdu"]
                .as_f64()
                .ok_or("geometry.tablePlane.depthBelowTopLdu must be a number")?,
            technic,
        })
    }

    fn translucent_colors(&self) -> Vec<u32> {
        self.translucent
            .iter()
            .copied()
            .collect::<BTreeSet<u32>>()
            .into_iter()
            .collect()
    }
}

fn write_glyph(out: &Path, file: &str, bytes: &[u8]) -> Result<Value, String> {
    fs::write(out.join(file), bytes).map_err(|e| format!("{file}: {e}"))?;
    Ok(json!({ "glyph": file }))
}

fn part_glyphs(
    args: &Args,
    inputs: &Inputs,
    worker: usize,
) -> Result<Vec<(String, Value)>, String> {
    let library = DirectoryLibrary::new(&args.ldraw)?;
    let options = CompileOptions {
        lod: Lod::Standard,
        rolling_mode: rolling_mode_from_studs(&library, &inputs.stud_primitives),
        stud_primitives: inputs.stud_primitives.clone(),
        unofficial_allowlist: inputs.unofficial_allowlist.clone(),
        technic: TechnicPrimitives::from_table(&inputs.technic)?,
    };
    let studs = StudMeshes::compile(
        &library,
        &inputs.stud_primitives,
        &inputs.unofficial_allowlist,
    )
    .map_err(|e| format!("stud primitives: {e}"))?;
    let baker = GlyphBaker::new(&studs, &inputs.translucent);
    let mut entries = Vec::new();
    for (_, reference) in library_parts(&library)
        .iter()
        .enumerate()
        .filter(|(i, _)| i % args.threads == worker)
    {
        let stem = reference.trim_end_matches(PART_EXTENSION);
        let id = format!("{PART_ID_PREFIX}{stem}");
        let compiled = match compile_part(&library, reference, &options) {
            Ok(compiled) => compiled,
            Err(error) if error.depends_on_machine() => {
                return Err(format!("{reference}: {error}; that depends on the machine"));
            }
            Err(error) => {
                entries.push((
                    id,
                    json!({ "part": reference, "failed": error.to_string() }),
                ));
                continue;
            }
        };
        let glyph = baker
            .part(&compiled.mesh, &compiled.studs)
            .map_err(|e| e.to_string())
            .and_then(|glyph| glyph.encode().map_err(|e| e.to_string()));
        let mut entry = match glyph {
            Ok(bytes) => write_glyph(
                &args.out,
                &format!("{PART_FOLDER}/{stem}{GLYPH_EXTENSION}"),
                &bytes,
            )?,
            Err(issue) => json!({ "glyphIssue": issue }),
        };
        entry["part"] = json!(reference);
        entries.push((id, entry));
    }
    Ok(entries)
}

fn drawable(baker: &mut ModelBaker<'_, DirectoryLibrary>, instances: &[ModelInstance]) -> Vec<u8> {
    let mut parts: HashMap<&str, bool> = HashMap::new();
    instances
        .iter()
        .map(|instance| {
            let compiles = *parts
                .entry(&instance.part)
                .or_insert_with(|| baker.lattice_shape(&instance.part).is_ok());
            u8::from(compiles)
        })
        .collect()
}

fn model_glyph(args: &Args, inputs: &Inputs, index: usize, path: &Path) -> Result<Value, String> {
    let source = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let model = bake_model_with(&source, BakeOptions::default())
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let library = DirectoryLibrary::new(&args.ldraw)?;
    let mut baker = ModelBaker::new(
        &library,
        inputs.stud_primitives.clone(),
        inputs.unofficial_allowlist.clone(),
        inputs.translucent.clone(),
        inputs.table_depth,
    )
    .map_err(|e| e.to_string())?;
    let drawn = drawable(&mut baker, &model.instances);
    let instances: Vec<ModelInstance> = model
        .instances
        .into_iter()
        .zip(&drawn)
        .filter(|(_, &kept)| kept != 0)
        .map(|(instance, _)| instance)
        .collect();
    let name = path
        .file_stem()
        .map_or_else(String::new, |stem| stem.to_string_lossy().into_owned());
    let glyph = baker
        .glyph(&instances)
        .map_err(|e| e.to_string())
        .and_then(|glyph| glyph.encode().map_err(|e| e.to_string()));
    let mut entry = match glyph {
        Ok(bytes) => write_glyph(
            &args.out,
            &format!("{MODEL_FOLDER}/{index:03}-{name}{GLYPH_EXTENSION}"),
            &bytes,
        )?,
        Err(issue) => json!({ "glyphIssue": issue }),
    };
    entry["file"] = json!(path.to_string_lossy());
    entry["drawn"] = json!(drawn);
    Ok(entry)
}

fn model_paths(args: &Args) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for path in &args.models {
        if path.is_dir() {
            let mut files: Vec<PathBuf> = fs::read_dir(path)
                .map_err(|e| format!("{}: {e}", path.display()))?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|file| file.is_file())
                .collect();
            files.sort();
            paths.extend(files);
        } else {
            paths.push(path.clone());
        }
    }
    Ok(paths)
}

fn run(args: &Args) -> Result<(usize, usize), String> {
    let inputs = Inputs::read(args)?;
    for folder in [PART_FOLDER, MODEL_FOLDER] {
        fs::create_dir_all(args.out.join(folder)).map_err(|e| format!("{folder}: {e}"))?;
    }
    let models = model_paths(args)?;
    let inputs = &inputs;
    let models = &models;
    let (parts, models) = thread::scope(|scope| {
        let workers: Vec<_> = (0..args.threads)
            .map(|worker| {
                scope.spawn(move || {
                    let parts = part_glyphs(args, inputs, worker)?;
                    let mut entries = Vec::new();
                    for (index, path) in models.iter().enumerate() {
                        if index % args.threads == worker {
                            entries.push((index, model_glyph(args, inputs, index, path)?));
                        }
                    }
                    Ok::<_, String>((parts, entries))
                })
            })
            .collect();
        let mut parts = Vec::new();
        let mut entries = Vec::new();
        for worker in workers {
            let (worker_parts, worker_models) =
                worker.join().map_err(|_| "a glyph worker panicked")??;
            parts.extend(worker_parts);
            entries.extend(worker_models);
        }
        entries.sort_by_key(|(index, _)| *index);
        Ok::<_, String>((
            parts,
            entries
                .into_iter()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>(),
        ))
    })?;
    let parts: serde_json::Map<String, Value> = parts
        .into_iter()
        .collect::<std::collections::BTreeMap<String, Value>>()
        .into_iter()
        .collect();
    let listing = json!({
        "options": {
            "studPrimitives": inputs.stud_primitives,
            "unofficialAllowlist": inputs.unofficial_allowlist,
            "translucentColors": inputs.translucent_colors(),
            "tableDepthLdu": inputs.table_depth,
        },
        "parts": parts,
        "models": models,
    });
    let text = serde_json::to_string(&listing).map_err(|e| e.to_string())?;
    fs::write(args.out.join(LISTING), text).map_err(|e| format!("{LISTING}: {e}"))?;
    Ok((
        listing["parts"].as_object().map_or(0, serde_json::Map::len),
        listing["models"].as_array().map_or(0, Vec::len),
    ))
}

fn main() -> ExitCode {
    let started = Instant::now();
    match parse_args().and_then(|args| run(&args)) {
        Ok((parts, models)) => {
            println!(
                "library-glyphs: {parts} parts and {models} models in {:.1} s",
                started.elapsed().as_secs_f64()
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("library-glyphs: {message}");
            ExitCode::FAILURE
        }
    }
}
