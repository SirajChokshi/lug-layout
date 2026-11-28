use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::Instant;

use brick_compile::bake::ModelBaker;
use brick_compile::colors::{parse_ldconfig, translucent_codes};
use brick_compile::compile::stud_primitives_from_table;
use brick_compile::model::{bake_model_with, BakeOptions, ModelInstance};
use brick_compile_cli::{read_json, strings, DirectoryLibrary};
use serde_json::{json, Value};

const GLYPH_EXTENSION: &str = ".glyph";
const LISTING: &str = "glyphs.json";

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
}

impl Inputs {
    fn read(args: &Args) -> Result<Self, String> {
        let palette = read_json(&args.palette)?;
        let geometry = read_json(&args.geometry)?;
        let ldconfig = fs::read_to_string(&args.ldconfig)
            .map_err(|e| format!("{}: {e}", args.ldconfig.display()))?;
        Ok(Inputs {
            stud_primitives: stud_primitives_from_table(&read_json(&args.primitives)?)?,
            unofficial_allowlist: strings(&palette, "unofficialAllowlist")?,
            translucent: translucent_codes(&parse_ldconfig(&ldconfig)),
            table_depth: geometry["tablePlane"]["depthBelowTopLdu"]
                .as_f64()
                .ok_or("geometry.tablePlane.depthBelowTopLdu must be a number")?,
        })
    }
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
    let mut entry = match baker.glyph(&instances) {
        Ok(glyph) => {
            let file = format!("{index:03}-{name}{GLYPH_EXTENSION}");
            fs::write(args.out.join(&file), glyph.encode()).map_err(|e| format!("{file}: {e}"))?;
            json!({ "glyph": file })
        }
        Err(issue) => json!({ "glyphIssue": issue.to_string() }),
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

fn run(args: &Args) -> Result<usize, String> {
    let inputs = Inputs::read(args)?;
    fs::create_dir_all(&args.out).map_err(|e| format!("{}: {e}", args.out.display()))?;
    let paths = model_paths(args)?;
    let inputs = &inputs;
    let paths = &paths;
    let mut models = thread::scope(|scope| {
        let workers: Vec<_> = (0..args.threads)
            .map(|worker| {
                scope.spawn(move || {
                    paths
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| index % args.threads == worker)
                        .map(|(index, path)| Ok((index, model_glyph(args, inputs, index, path)?)))
                        .collect::<Result<Vec<_>, String>>()
                })
            })
            .collect();
        let mut models = Vec::new();
        for worker in workers {
            models.extend(worker.join().map_err(|_| "a glyph worker panicked")??);
        }
        Ok::<_, String>(models)
    })?;
    models.sort_by_key(|(index, _)| *index);
    let listing = json!({
        "options": {
            "studPrimitives": inputs.stud_primitives,
            "unofficialAllowlist": inputs.unofficial_allowlist,
            "translucentColors": inputs.translucent.iter().collect::<BTreeSet<_>>(),
            "tableDepthLdu": inputs.table_depth,
        },
        "models": models.into_iter().map(|(_, entry)| entry).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string(&listing).map_err(|e| e.to_string())?;
    fs::write(args.out.join(LISTING), text).map_err(|e| format!("{LISTING}: {e}"))?;
    Ok(paths.len())
}

fn main() -> ExitCode {
    let started = Instant::now();
    match parse_args().and_then(|args| run(&args)) {
        Ok(models) => {
            println!(
                "model-glyphs: {models} models in {:.1} s",
                started.elapsed().as_secs_f64()
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("model-glyphs: {message}");
            ExitCode::FAILURE
        }
    }
}
