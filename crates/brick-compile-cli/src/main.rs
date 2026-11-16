use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::affine::Vec3;
use brick_compile::colors::parse_ldconfig;
use brick_compile::inline::inline_part_distance;
use brick_compile::lattice::{model_lattice, LatticeInstance};
use brick_compile::mesh::WELD_EPSILON_LDU;
use brick_compile::model::bake_model;
use brick_compile::{compile_part, CompileOptions, CompiledPart, Library, Lod};
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
    geometry: PathBuf,
    fixtures: PathBuf,
    omr: PathBuf,
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
        Some("far") => Lod::Far,
        Some(other) => return Err(format!("unknown --lod {other}")),
    };
    Ok(Args {
        ldraw: take("--ldraw")?.into(),
        fixtures: take("--fixtures")?.into(),
        omr: take("--omr")?.into(),
        geometry: take("--geometry")?.into(),
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

struct PartShape {
    studs: Vec<Vec3>,
    bounds: [Vec3; 2],
}

fn part_shape(part: &CompiledPart) -> PartShape {
    PartShape {
        studs: part
            .studs
            .iter()
            .map(|stud| [stud.matrix.m[3], stud.matrix.m[7], stud.matrix.m[11]])
            .collect(),
        bounds: part
            .mesh
            .bounds()
            .unwrap_or([[0.0; 3]; 2])
            .map(|corner| corner.map(f64::from)),
    }
}

fn record_credits(credits: &mut BTreeMap<String, Value>, part: &CompiledPart) {
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
}

fn compile_entry(
    library: &FsLibrary,
    reference: &str,
    role: &Value,
    options: &CompileOptions,
    out: &Path,
    credits: &mut BTreeMap<String, Value>,
) -> Result<(Value, PartShape), String> {
    let compiled = compile_part(library, reference, options).map_err(|e| e.to_string())?;
    let id = stem(reference);
    let file = format!("{id}.glb");
    fs::write(out.join(&file), compiled.to_glb()).map_err(|e| e.to_string())?;
    record_credits(credits, &compiled);
    let header = &compiled.flattened_files[0].header;
    let mut summary = part_summary(&compiled);
    summary["id"] = json!(format!("ldraw:{id}"));
    summary["role"] = role.clone();
    summary["file"] = json!(file);
    summary["title"] = json!(header.title);
    summary["author"] = json!(header.author);
    summary["license"] = json!(header.license);
    Ok((summary, part_shape(&compiled)))
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
    let unofficial_allowlist: Vec<String> = palette["unofficialAllowlist"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let primitive_options = CompileOptions {
        lod: args.lod,
        stud_primitives: Vec::new(),
        unofficial_allowlist: unofficial_allowlist.clone(),
    };
    let part_options = CompileOptions {
        lod: args.lod,
        stud_primitives: stud_primitives.clone(),
        unofficial_allowlist,
    };
    fs::create_dir_all(&args.out).map_err(|e| e.to_string())?;

    let mut credits: BTreeMap<String, Value> = BTreeMap::new();

    let mut primitives = Vec::new();
    for name in &stud_primitives {
        let compiled =
            compile_part(&library, name, &primitive_options).map_err(|e| e.to_string())?;
        let file = format!("stud-primitive-{}.glb", stem(name));
        fs::write(args.out.join(&file), compiled.to_glb()).map_err(|e| e.to_string())?;
        record_credits(&mut credits, &compiled);
        let mut summary = part_summary(&compiled);
        summary["name"] = json!(name);
        summary["file"] = json!(file);
        primitives.push(summary);
    }

    let mut parts = Vec::new();
    let mut shapes: Vec<PartShape> = Vec::new();
    let mut part_index: HashMap<String, usize> = HashMap::new();
    for entry in palette["parts"]
        .as_array()
        .ok_or("palette.parts must be an array")?
    {
        let id = entry["id"].as_str().ok_or("part id must be a string")?;
        let reference = format!("{id}.dat");
        let (mut summary, shape) = compile_entry(
            &library,
            &reference,
            &entry["role"],
            &part_options,
            &args.out,
            &mut credits,
        )?;
        if !entry["displayColor"].is_null() {
            summary["displayColor"] = entry["displayColor"].clone();
        }
        part_index.insert(reference, parts.len());
        parts.push(summary);
        shapes.push(shape);
    }

    let geometry: Value = serde_json::from_slice(
        &fs::read(&args.geometry).map_err(|e| format!("{}: {e}", args.geometry.display()))?,
    )
    .map_err(|e| e.to_string())?;
    for entry in geometry["trackEnds"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let Some(id) = entry["part"].as_str() else {
            continue;
        };
        if let Some(&index) = part_index.get(&format!("{id}.dat")) {
            parts[index]["trackEnds"] = entry["relative"].clone();
        }
    }

    let mut models = Vec::new();
    for entry in palette["models"].as_array().cloned().unwrap_or_default() {
        let name = entry["name"]
            .as_str()
            .ok_or("model name must be a string")?;
        let file = entry["file"]
            .as_str()
            .ok_or("model file must be a string")?;
        let root = match entry["origin"].as_str() {
            Some("omr") => &args.omr,
            Some("generated") => &args.fixtures,
            other => return Err(format!("{file}: unknown model origin {other:?}")),
        };
        let path = root.join(file);
        let source = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let text = String::from_utf8_lossy(&source);
        let baked = bake_model(&text).map_err(|e| format!("{file}: {e}"))?;
        let mut model_parts: Vec<Value> = Vec::new();
        let mut model_part_index: HashMap<usize, usize> = HashMap::new();
        let mut instance_parts = Vec::with_capacity(baked.instances.len());
        let mut instance_global_parts = Vec::with_capacity(baked.instances.len());
        let mut instance_colors = Vec::with_capacity(baked.instances.len());
        let mut instance_matrices = Vec::with_capacity(baked.instances.len() * 12);
        for instance in &baked.instances {
            let index = match part_index.get(&instance.part) {
                Some(&index) => index,
                None => {
                    let (summary, shape) = compile_entry(
                        &library,
                        &instance.part,
                        &json!("model"),
                        &part_options,
                        &args.out,
                        &mut credits,
                    )
                    .map_err(|e| format!("{file}: {e}"))?;
                    part_index.insert(instance.part.clone(), parts.len());
                    parts.push(summary);
                    shapes.push(shape);
                    parts.len() - 1
                }
            };
            let local = *model_part_index.entry(index).or_insert_with(|| {
                model_parts.push(parts[index]["id"].clone());
                model_parts.len() - 1
            });
            instance_parts.push(local);
            instance_global_parts.push(index);
            instance_colors.push(instance.color);
            instance_matrices.extend(instance.matrix.m.map(|v| v as f32));
        }
        let lattice_instances: Vec<LatticeInstance> = baked
            .instances
            .iter()
            .zip(&instance_global_parts)
            .map(|(instance, &index)| LatticeInstance {
                matrix: &instance.matrix,
                studs: &shapes[index].studs,
                bounds_min: shapes[index].bounds[0],
                bounds_max: shapes[index].bounds[1],
            })
            .collect();
        let lattice = model_lattice(&lattice_instances).map_err(|e| format!("{file}: {e}"))?;
        let lattice_json = json!({
            "phase": lattice.phase,
            "phaseLayerY": lattice.phase_layer_y,
            "phaseLayerStuds": lattice.phase_layer_studs,
            "phaseLayerAgreeing": lattice.phase_layer_agreeing,
            "aabb": { "min": lattice.aabb_min, "max": lattice.aabb_max },
        });
        let model_file = format!("model-{}.json", stem(name));
        let sections: Vec<Value> = baked
            .sections
            .iter()
            .map(|h| json!({ "name": h.name, "title": h.title, "author": h.author, "license": h.license, "ldrawOrg": h.ldraw_org }))
            .collect();
        let mut inline_parts: Vec<Value> = Vec::new();
        for part in &baked.inline_parts {
            let distance = inline_part_distance(&library, &text, &part.inline, &part.official)
                .map_err(|e| format!("{file}: {}: {e:?}", part.inline))?;
            if distance > WELD_EPSILON_LDU {
                return Err(format!(
                    "{file}: inline part {} draws different geometry from official {} (max vertex distance {distance:.4} LDU)",
                    part.inline, part.official
                ));
            }
            inline_parts.push(json!({ "inline": part.inline, "official": part.official, "maxVertexDistanceLdu": distance }));
        }
        let model = json!({
            "name": name,
            "file": file,
            "source": entry["source"],
            "retrieved": entry["retrieved"],
            "sha256": entry["sha256"],
            "sections": sections,
            "inlinePartsResolvedToOfficial": inline_parts,
            "parts": model_parts,
            "lattice": lattice_json,
            "instances": { "part": instance_parts, "color": instance_colors, "matrix": instance_matrices },
        });
        fs::write(
            args.out.join(&model_file),
            serde_json::to_string(&model).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        models.push(json!({
            "name": name,
            "file": model_file,
            "origin": entry["origin"],
            "source": entry["source"],
            "sections": sections,
            "inlinePartsResolvedToOfficial": inline_parts,
            "instances": baked.instances.len(),
            "lattice": lattice_json,
        }));
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
        "lod": match args.lod { Lod::Standard => "standard", Lod::Low => "low", Lod::Far => "far" },
        "source": palette["source"],
        "parts": parts,
        "models": models,
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
