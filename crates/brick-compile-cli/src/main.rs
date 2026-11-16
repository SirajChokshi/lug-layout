use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::colors::parse_ldconfig;
use brick_compile::{compile_part, CompiledPart, Library, Lod};
use serde_json::{json, Value};

const DISCLAIMER: &str =
    "LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.";
const LDCONFIG: &str = "ldconfig.ldr";

struct FsLibrary {
    files: HashMap<String, String>,
}

impl Library for FsLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(String::as_str)
    }
}

fn collect(root: &Path, dir: &Path, files: &mut HashMap<String, String>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(root, &path, files)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(std::io::Error::other)?
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        files.insert(
            relative,
            String::from_utf8_lossy(&fs::read(&path)?).into_owned(),
        );
    }
    Ok(())
}

struct Args {
    ldraw: PathBuf,
    palette: PathBuf,
    out: PathBuf,
    lod: Lod,
}

fn parse_args() -> Result<Args, String> {
    let mut values: HashMap<String, String> = HashMap::new();
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        let value = raw.next().ok_or(format!("missing value for {flag}"))?;
        values.insert(flag, value);
    }
    let take = |key: &str| values.get(key).cloned().ok_or(format!("missing {key}"));
    let lod = match values.get("--lod").map(String::as_str) {
        None | Some("standard") => Lod::Standard,
        Some("low") => Lod::Low,
        Some(other) => return Err(format!("unknown --lod {other}")),
    };
    Ok(Args {
        ldraw: take("--ldraw")?.into(),
        palette: take("--palette")?.into(),
        out: take("--out")?.into(),
        lod,
    })
}

fn stem(reference: &str) -> String {
    reference.trim_end_matches(".dat").replace('/', "-")
}

fn part_summary(part: &CompiledPart) -> Value {
    let [min, max] = part.mesh.bounds().unwrap_or([[0.0; 3]; 2]);
    json!({
        "triangles": part.mesh.triangle_count(),
        "vertices": part.mesh.vertex_count(),
        "studs": part.studs.len(),
        "bounds": { "min": min, "max": max },
        "colors": part.mesh.groups.iter().map(|g| g.color).collect::<Vec<_>>(),
    })
}

fn run(args: &Args) -> Result<(), String> {
    let mut files = HashMap::new();
    collect(&args.ldraw, &args.ldraw, &mut files).map_err(|e| e.to_string())?;
    let library = FsLibrary { files };
    let palette: Value = serde_json::from_slice(
        &fs::read(&args.palette).map_err(|e| format!("{}: {e}", args.palette.display()))?,
    )
    .map_err(|e| e.to_string())?;
    let stud_primitives: Vec<String> = palette["studPrimitives"]
        .as_array()
        .ok_or("palette.studPrimitives must be an array")?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    fs::create_dir_all(&args.out).map_err(|e| e.to_string())?;

    let mut credits: BTreeMap<String, Value> = BTreeMap::new();
    let mut record_credits = |part: &CompiledPart| {
        for file in &part.flattened_files {
            credits.entry(file.path.clone()).or_insert_with(|| {
                json!({
                    "path": file.path,
                    "title": file.header.title,
                    "author": file.header.author,
                    "license": file.header.license,
                })
            });
        }
    };

    let mut primitives = Vec::new();
    for name in &stud_primitives {
        let compiled = compile_part(&library, name, args.lod, &[]).map_err(|e| e.to_string())?;
        let file = format!("stud-primitive-{}.glb", stem(name));
        fs::write(args.out.join(&file), compiled.to_glb()).map_err(|e| e.to_string())?;
        record_credits(&compiled);
        let mut summary = part_summary(&compiled);
        summary["name"] = json!(name);
        summary["file"] = json!(file);
        primitives.push(summary);
    }

    let mut parts = Vec::new();
    for entry in palette["parts"]
        .as_array()
        .ok_or("palette.parts must be an array")?
    {
        let id = entry["id"].as_str().ok_or("part id must be a string")?;
        let compiled = compile_part(&library, &format!("{id}.dat"), args.lod, &stud_primitives)
            .map_err(|e| e.to_string())?;
        let file = format!("{}.glb", stem(id));
        fs::write(args.out.join(&file), compiled.to_glb()).map_err(|e| e.to_string())?;
        record_credits(&compiled);
        let header = &compiled.flattened_files[0].header;
        let mut summary = part_summary(&compiled);
        summary["id"] = json!(format!("ldraw:{id}"));
        summary["role"] = entry["role"].clone();
        summary["file"] = json!(file);
        summary["title"] = json!(header.title);
        summary["author"] = json!(header.author);
        summary["license"] = json!(header.license);
        parts.push(summary);
    }

    let colors: Vec<Value> = library
        .source(LDCONFIG)
        .map(parse_ldconfig)
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            json!({
                "code": c.code,
                "name": c.name,
                "rgb": format!("#{:02X}{:02X}{:02X}", c.rgb[0], c.rgb[1], c.rgb[2]),
                "alpha": c.alpha,
            })
        })
        .collect();
    if colors.is_empty() {
        return Err("LDConfig.ldr is missing or has no !COLOUR lines".into());
    }

    let manifest = json!({
        "unit": "LDU",
        "upAxis": "+Y",
        "lod": match args.lod { Lod::Standard => "standard", Lod::Low => "low" },
        "source": palette["source"],
        "parts": parts,
        "studPrimitives": primitives,
        "colors": colors,
        "credits": credits.into_values().collect::<Vec<_>>(),
        "disclaimer": DISCLAIMER,
    });
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(args.out.join("manifest.json"), text + "\n").map_err(|e| e.to_string())?;
    Ok(())
}

fn main() -> ExitCode {
    match parse_args().and_then(|args| run(&args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("brick-compile: {message}");
            ExitCode::FAILURE
        }
    }
}
