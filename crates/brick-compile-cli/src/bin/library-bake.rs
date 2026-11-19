use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::compile::rolling_mode_from_studs;
use brick_compile::cover::PartSolid;
use brick_compile::record::BakeRecord;
use brick_compile::vehicle::part_bounds;
use brick_compile::{compile_part, CompileOptions, Library, Lod, TechnicPrimitives};
use serde_json::{json, Value};

const PART_FOLDER: &str = "parts";
const PART_EXTENSION: &str = ".dat";
const PART_ID_PREFIX: &str = "ldraw:";
const RECORD_FOLDER: &str = "records";
const GLB_FOLDER: &str = "standard";

struct Args {
    ldraw: PathBuf,
    palette: PathBuf,
    primitives: PathBuf,
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
        palette: take("--palette")?.into(),
        primitives: take("--primitives")?.into(),
        out: take("--out")?.into(),
        shard,
        shards,
    })
}

struct DirectoryLibrary {
    files: HashMap<String, PathBuf>,
    read: RefCell<HashMap<String, Option<&'static str>>>,
}

impl DirectoryLibrary {
    fn new(root: &Path) -> Result<Self, String> {
        let mut files = HashMap::new();
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.is_dir() {
                    folders.push(path);
                    continue;
                }
                let key = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase();
                files.entry(key).or_insert(path);
            }
        }
        Ok(DirectoryLibrary {
            files,
            read: RefCell::new(HashMap::new()),
        })
    }
}

impl Library for DirectoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        if let Some(&text) = self.read.borrow().get(path) {
            return text;
        }
        let text = self
            .files
            .get(path)
            .and_then(|file| fs::read(file).ok())
            .map(|bytes| {
                let text: &'static str = Box::leak(
                    String::from_utf8_lossy(&bytes)
                        .into_owned()
                        .into_boxed_str(),
                );
                text
            });
        self.read.borrow_mut().insert(path.to_string(), text);
        text
    }
}

fn library_parts(library: &DirectoryLibrary) -> Vec<String> {
    let prefix = format!("{PART_FOLDER}/");
    let mut parts: Vec<String> = library
        .files
        .keys()
        .filter_map(|path| path.strip_prefix(&prefix))
        .filter(|name| !name.contains('/') && name.ends_with(PART_EXTENSION))
        .map(str::to_string)
        .collect();
    parts.sort();
    parts
}

fn strings(palette: &Value, key: &str) -> Result<Vec<String>, String> {
    palette[key]
        .as_array()
        .ok_or(format!("palette.{key} must be an array"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or(format!("palette.{key} holds a non-string"))
        })
        .collect()
}

fn bake_part(
    library: &DirectoryLibrary,
    reference: &str,
    options: &CompileOptions,
    out: &Path,
    stem: &str,
) -> Result<Value, String> {
    let baked = compile_part(library, reference, options).and_then(|compiled| {
        let bounds = part_bounds(library, reference)?;
        Ok((compiled, bounds))
    });
    let (compiled, bounds) = match baked {
        Ok(baked) => baked,
        Err(error) if error.depends_on_machine() => {
            return Err(format!("{reference}: {error}; that depends on the machine that built it, so it is never recorded"))
        }
        Err(error) => return Ok(json!({ "failed": error.to_string() })),
    };
    let record = BakeRecord::of(&compiled, bounds)
        .encode()
        .map_err(|e| format!("{reference}: {e}"))?;
    let rebuilt = BakeRecord::decode(&record)
        .and_then(|decoded| PartSolid::from_record(&decoded))
        .map_err(|e| format!("{reference}: {e}"))?;
    if !rebuilt.same_bits(&PartSolid::from_mesh(&compiled.mesh)) {
        return Err(format!(
            "{reference}: its record does not rebuild its solid bit for bit"
        ));
    }
    let record_file = format!("{RECORD_FOLDER}/{stem}.bin");
    let glb_file = format!("{GLB_FOLDER}/{stem}.glb");
    fs::write(out.join(&record_file), record).map_err(|e| format!("{record_file}: {e}"))?;
    fs::write(out.join(&glb_file), compiled.to_glb()).map_err(|e| format!("{glb_file}: {e}"))?;
    let licenses: BTreeSet<&str> = compiled
        .flattened_files
        .iter()
        .map(|file| file.header.license.as_deref().unwrap_or_default())
        .collect();
    Ok(json!({ "record": record_file, "glb": glb_file, "licenses": licenses }))
}

fn run(args: &Args) -> Result<usize, String> {
    let palette: Value = serde_json::from_slice(
        &fs::read(&args.palette).map_err(|e| format!("{}: {e}", args.palette.display()))?,
    )
    .map_err(|e| format!("{}: {e}", args.palette.display()))?;
    let primitive_table: Value = serde_json::from_slice(
        &fs::read(&args.primitives).map_err(|e| format!("{}: {e}", args.primitives.display()))?,
    )
    .map_err(|e| format!("{}: {e}", args.primitives.display()))?;
    let library = DirectoryLibrary::new(&args.ldraw)?;
    let stud_primitives = strings(&palette, "studPrimitives")?;
    let options = CompileOptions {
        lod: Lod::Standard,
        rolling_mode: rolling_mode_from_studs(&library, &stud_primitives),
        stud_primitives,
        unofficial_allowlist: strings(&palette, "unofficialAllowlist")?,
        technic: TechnicPrimitives::from_table(&primitive_table)?,
    };
    for folder in [RECORD_FOLDER, GLB_FOLDER] {
        fs::create_dir_all(args.out.join(folder)).map_err(|e| format!("{folder}: {e}"))?;
    }
    let mut listing = Vec::new();
    for (_, reference) in library_parts(&library)
        .iter()
        .enumerate()
        .filter(|(i, _)| i % args.shards == args.shard)
    {
        let stem = reference.trim_end_matches(PART_EXTENSION);
        let mut entry = bake_part(&library, reference, &options, &args.out, stem)?;
        entry["id"] = json!(format!("{PART_ID_PREFIX}{stem}"));
        entry["part"] = json!(reference);
        listing.push(entry);
    }
    let file = args
        .out
        .join(format!("shard-{}-of-{}.json", args.shard, args.shards));
    let text = serde_json::to_string(&listing).map_err(|e| e.to_string())?;
    fs::write(&file, text).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(listing.len())
}

fn main() -> ExitCode {
    let result = parse_args().and_then(|args| run(&args));
    match result {
        Ok(parts) => {
            println!("{parts} parts");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("library-bake: {message}");
            ExitCode::FAILURE
        }
    }
}
