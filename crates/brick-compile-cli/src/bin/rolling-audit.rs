use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use brick_compile::compile::{required_stud_roundness, RollingMode};
use brick_compile::flatten::{Library, Lod};
use brick_compile::{compile_part, CompileOptions};
use serde_json::json;

const DEFAULT_STUDS: &str = "stud.dat,stud2.dat";
const DEFAULT_REPEAT: usize = 3;

struct LazyLibrary {
    root: PathBuf,
    loaded: RefCell<HashMap<String, Option<&'static str>>>,
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

struct Args {
    ldraw: PathBuf,
    parts: Vec<String>,
    studs: Vec<String>,
    repeat: usize,
    lod: Lod,
}

fn parse_args() -> Result<Args, String> {
    let mut values: HashMap<String, String> = HashMap::new();
    let mut flags = std::env::args().skip(1);
    while let Some(flag) = flags.next() {
        let value = flags.next().ok_or(format!("{flag} needs a value"))?;
        values.insert(flag, value);
    }
    let ldraw = PathBuf::from(
        values
            .get("--ldraw")
            .ok_or("--ldraw <library root> is required")?,
    );
    let parts = match values.get("--parts").map(String::as_str) {
        Some("all") => {
            let mut names: Vec<String> = fs::read_dir(ldraw.join("parts"))
                .map_err(|e| e.to_string())?
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().is_file())
                .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
                .filter(|name| name.ends_with(".dat"))
                .collect();
            names.sort();
            names
        }
        Some(list) => fs::read_to_string(list)
            .map_err(|e| format!("{list}: {e}"))?
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
        None => return Err("--parts <file with one reference per line | all> is required".into()),
    };
    let studs = values
        .get("--studs")
        .map_or(DEFAULT_STUDS, String::as_str)
        .split(',')
        .map(str::to_string)
        .collect();
    let repeat = values
        .get("--repeat")
        .map(|r| r.parse::<usize>().map_err(|e| e.to_string()))
        .transpose()?
        .unwrap_or(DEFAULT_REPEAT)
        .max(1);
    let lod = match values.get("--lod").map(String::as_str) {
        None | Some("standard") => Lod::Standard,
        Some("low") => Lod::Low,
        Some("far") => Lod::Far,
        Some(other) => return Err(format!("--lod {other} is not standard, low or far")),
    };
    Ok(Args {
        ldraw,
        parts,
        studs,
        repeat,
        lod,
    })
}

fn fastest(repeat: usize, mut run: impl FnMut()) -> Duration {
    (0..repeat)
        .map(|_| {
            let started = Instant::now();
            run();
            started.elapsed()
        })
        .min()
        .unwrap_or_default()
}

fn run(args: &Args) -> Result<(), String> {
    let library = LazyLibrary {
        root: args.ldraw.clone(),
        loaded: RefCell::new(HashMap::new()),
    };
    let roundness = required_stud_roundness(&library, &args.studs)?;
    let without = CompileOptions {
        lod: args.lod,
        stud_primitives: args.studs.clone(),
        unofficial_allowlist: Vec::new(),
        rolling_mode: RollingMode::Skip,
    };
    let with = CompileOptions {
        rolling_mode: RollingMode::ReadBy(roundness),
        ..without.clone()
    };
    eprintln!(
        "roundness: standard {} facets, coarse {} facets",
        roundness.standard_facets, roundness.coarse_facets
    );
    let lod_name = match args.lod {
        Lod::Standard => "standard",
        Lod::Low => "low",
        Lod::Far => "far",
    };
    for part in &args.parts {
        let title = library
            .source(&format!("parts/{part}"))
            .and_then(|text| text.lines().next())
            .map(|line| line.trim_start_matches('0').trim().to_string())
            .unwrap_or_default();
        let line = match compile_part(&library, part, &with) {
            Err(error) => json!({ "part": part, "title": title, "error": error.to_string() }),
            Ok(compiled) => {
                let without_time = fastest(args.repeat, || {
                    let _ = compile_part(&library, part, &without);
                });
                let with_time = fastest(args.repeat, || {
                    let _ = compile_part(&library, part, &with);
                });
                json!({
                    "part": part,
                    "title": title,
                    "lod": lod_name,
                    "bounds": compiled.mesh.bounds(),
                    "triangles": compiled.mesh.triangle_count(),
                    "withoutMicros": without_time.as_secs_f64() * 1e6,
                    "withMicros": with_time.as_secs_f64() * 1e6,
                    "rolling": compiled.rolling.map(|rolling| rolling.to_json()),
                })
            }
        };
        println!("{line}");
    }
    Ok(())
}

fn main() -> ExitCode {
    match parse_args().and_then(|args| run(&args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("rolling-audit: {message}");
            ExitCode::FAILURE
        }
    }
}
