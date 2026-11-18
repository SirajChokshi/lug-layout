use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use brick_compile::bake::{drawn_lattice, LatticeShape, ModelBaker};
use brick_compile::colors::{parse_ldconfig, Colour};
use brick_compile::compile::{modified_note, MODIFIED_NOTE};
use brick_compile::connect::{
    record_json, ConnectorExtractor, InferredFeatures, PartRecords, PrimitiveConnectors,
    PrimitiveTable, ShadowPatches, ShadowSnaps, TierRecord, CONNECTIVITY_LICENSE,
};
use brick_compile::cover::ModelCover;
use brick_compile::glb::{self, UintArray};
use brick_compile::inline::compare_inline_part;
use brick_compile::ldraw::{normalize_reference, parse as parse_ldraw, Header};
use brick_compile::model::{bake_model, ModelInstance};
use brick_compile::vehicle::{GuideKind, RailHeadBand, Vehicle, VehicleSignatures};
use brick_compile::voxel::{greedy_mesh, CELL_LDU, CELL_MARGIN_LDU, VOXEL_NOTE};
use brick_compile::{compile_part, CompileOptions, CompiledPart, Library, Lod, TechnicPrimitives};
use brick_compile_cli::{read_section_vocabulary, verified_patch_paths, LazyLibrary};
use serde_json::{json, Value};

const DISCLAIMER: &str =
    "LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.";
const LDCONFIG: &str = "ldconfig.ldr";
const COMPILER_FILE: &str = "brick-compile.wasm";
const CONNECTOR_INDEX_FILE: &str = "connector-index.json";
const CONNECTIVITY_INDEX_FILE: &str = "connectivity-index.json";
const PATCH_MANIFEST: &str = "manifest.json";
const SHADOW_AUTHORS: &str = "Roland Melkert and the LDCad Shadow Library contributors";
const PATCH_ATTRIBUTION: &str =
    "Brick Railroad shadow patches (tools/asset-pipeline/shadow-patches), CC BY-SA 4.0";

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
    primitives: PathBuf,
    inferred: PathBuf,
    vocabulary: PathBuf,
    shadow: PathBuf,
    patches: PathBuf,
    out: PathBuf,
    lod: Lod,
    compiler: Option<PathBuf>,
    cover_cache: Option<PathBuf>,
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
        primitives: take("--primitives")?.into(),
        inferred: take("--inferred")?.into(),
        vocabulary: take("--vocabulary")?.into(),
        shadow: take("--shadow")?.into(),
        patches: take("--patches")?.into(),
        out: take("--out")?.into(),
        cover_cache: values.get("--cover-cache").map(PathBuf::from),
        lod,
        compiler: values.get("--compiler").map(PathBuf::from),
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

fn cover_json(cover: &ModelCover) -> Value {
    let cells = cover.cells.as_ref().map(|cells| {
        json!({
            "origin": cells.origin,
            "size": [cells.width, cells.depth],
            "bottomY": cells.bottom_y,
            "footprint": cells.footprint,
            "flat": cells.flat,
            "columnBottom": cells.column_bottom,
            "columnTop": cells.column_top,
        })
    });
    json!({
        "studs": cover.visible.len(),
        "coveredStuds": cover.covered_count(),
        "keptOpenBelow": cover.open_below,
        "visibleBits": cover.visible_bits(),
        "cells": cells,
    })
}

fn cover_summary(cover: &ModelCover) -> Value {
    let cells = cover.cells.as_ref().map(|cells| {
        json!({
            "footprintCells": cells.footprint.len(),
            "flatCells": cells.flat.len(),
            "restY": cells.bottom_y,
            "size": [cells.width, cells.depth],
            "heightPlates": cells.height_plates(),
        })
    });
    json!({
        "studs": cover.visible.len(),
        "coveredStuds": cover.covered_count(),
        "keptOpenBelow": cover.open_below,
        "cells": cells,
    })
}

fn credit(path: &str, header: &Header) -> Value {
    json!({
        "path": path,
        "title": header.title,
        "author": header.author,
        "license": header.license,
    })
}

fn record_credits(credits: &mut BTreeMap<String, Value>, part: &CompiledPart) {
    for file in &part.flattened_files {
        credits
            .entry(file.path.clone())
            .or_insert_with(|| credit(&file.path, &file.header));
    }
}

fn distinct<'a>(values: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = Vec::new();
    for value in values {
        if !value.is_empty() && !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

fn compile_entry(
    library: &FsLibrary,
    reference: &str,
    role: &Value,
    options: &CompileOptions,
    out: &Path,
    credits: &mut BTreeMap<String, Value>,
) -> Result<(Value, LatticeShape), String> {
    let compiled = compile_part(library, reference, options).map_err(|e| e.to_string())?;
    let id = stem(reference);
    let file = format!("{id}.glb");
    fs::write(out.join(&file), compiled.to_glb()).map_err(|e| e.to_string())?;
    record_credits(credits, &compiled);
    let header = &compiled.flattened_files[0].header;
    let mut summary = part_summary(&compiled);
    summary["id"] = json!(format!("ldraw:{id}"));
    summary["path"] = json!(compiled.path);
    summary["role"] = role.clone();
    summary["file"] = json!(file);
    summary["title"] = json!(header.title);
    summary["author"] = json!(header.author);
    summary["license"] = json!(header.license);
    Ok((summary, LatticeShape::of(&compiled)))
}

fn acknowledged_not_drawn(entry: &Value, file: &str) -> Result<BTreeMap<String, String>, String> {
    let mut acknowledged = BTreeMap::new();
    for item in entry["notDrawn"].as_array().cloned().unwrap_or_default() {
        let (Some(section), Some(reason)) = (item["section"].as_str(), item["reason"].as_str())
        else {
            return Err(format!(
                "{file}: notDrawn entries need a section and a reason"
            ));
        };
        acknowledged.insert(normalize_reference(section), reason.to_string());
    }
    Ok(acknowledged)
}

fn string_list(value: &Value, label: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or(format!("{label} must be an array"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or(format!("{label} must hold strings"))
        })
        .collect()
}

fn vehicle_signatures(palette: &Value) -> Result<VehicleSignatures, String> {
    let parts = &palette["vehicleParts"];
    Ok(VehicleSignatures {
        bogie_pivots: string_list(&parts["bogiePivots"], "vehicleParts.bogiePivots")?,
        pivot_pins: string_list(&parts["pivotPins"], "vehicleParts.pivotPins")?,
        wheelsets: string_list(&parts["wheelsets"], "vehicleParts.wheelsets")?,
        wheels: string_list(&parts["wheels"], "vehicleParts.wheels")?,
        couplers: string_list(&parts["couplers"], "vehicleParts.couplers")?,
    })
}

fn rail_head_bands(geometry: &Value) -> Result<Vec<RailHeadBand>, String> {
    geometry["rails"]
        .as_array()
        .ok_or("geometry.rails must be an array")?
        .iter()
        .map(|rail| {
            let part = rail["part"]
                .as_str()
                .ok_or("rails[].part must be a string")?;
            let heads = rail["railHeads"]
                .as_array()
                .ok_or("rails[].railHeads must be an array")?;
            let outward = heads
                .iter()
                .find(|head| head["from"].as_f64().is_some_and(|from| from > 0.0))
                .ok_or(format!("rail {part} has no rail head on the +z side"))?;
            Ok(RailHeadBand {
                rail_part: format!("ldraw:{}", stem(part)),
                inner: outward["from"]
                    .as_f64()
                    .ok_or("railHeads[].from must be a number")?,
                outer: outward["to"]
                    .as_f64()
                    .ok_or("railHeads[].to must be a number")?,
            })
        })
        .collect()
}

fn vehicle_json(vehicle: &Vehicle) -> Value {
    let coupler = |c: &Option<brick_compile::vehicle::Coupler>| {
        c.as_ref()
            .map(|c| json!({ "instance": c.instance, "face": c.face, "bogie": c.bogie, "obsoleteSources": c.obsolete_sources }))
            .unwrap_or(Value::Null)
    };
    json!({
        "origin": vehicle.origin,
        "yaw": vehicle.yaw,
        "guideKind": match vehicle.guide_kind { GuideKind::BogiePivot => "bogiePivot", GuideKind::FixedAxle => "fixedAxle" },
        "guides": vehicle.guides,
        "body": vehicle.body,
        "bogies": vehicle.bogies.iter().map(|b| json!({ "instances": b.instances, "pivot": b.pivot, "axles": b.axles })).collect::<Vec<_>>(),
        "fixedAxles": vehicle.fixed_axles,
        "wheelsets": vehicle.wheelsets.iter().map(|w| json!({ "instance": w.instance, "centre": w.centre })).collect::<Vec<_>>(),
        "frontCoupler": coupler(&vehicle.front_coupler),
        "rearCoupler": coupler(&vehicle.rear_coupler),
        "railContacts": vehicle.rail_contacts.iter().map(|r| json!({ "railPart": r.rail_part, "railTopY": r.rail_top_y, "spreadLdu": r.spread })).collect::<Vec<_>>(),
    })
}

const OPAQUE_ALPHA: u8 = 255;

fn far_mesh(
    baker: &mut ModelBaker<FsLibrary>,
    out: &Path,
    name: &str,
    drawn: &[ModelInstance],
    model_ldraw: &Value,
    credits: &mut BTreeMap<String, Value>,
) -> Result<Option<Value>, String> {
    let Some(grid) = baker.voxels(drawn).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let mut sources: BTreeMap<String, Value> = BTreeMap::new();
    for instance in drawn {
        let compiled = baker
            .standard_part(&instance.part)
            .map_err(|e| e.to_string())?;
        record_credits(credits, compiled);
        for file in &compiled.flattened_files {
            sources.entry(file.path.clone()).or_insert_with(|| {
                json!({ "path": file.path, "author": file.header.author, "license": file.header.license })
            });
        }
    }
    let mut ldraw = model_ldraw.clone();
    ldraw["note"] = json!(format!("{MODIFIED_NOTE}; {VOXEL_NOTE}"));
    ldraw["sources"] = json!(sources.into_values().collect::<Vec<_>>());
    let mesh = greedy_mesh(&grid);
    let dims = grid.dims.map(|d| d as u64);
    let voxels = json!({
        "cellLdu": CELL_LDU,
        "cellMarginLdu": CELL_MARGIN_LDU,
        "origin": grid.origin,
        "dims": dims,
        "count": grid.count(),
        "cellIndex": "x + dims[0] * (y + dims[1] * z)",
        "geometry": "standard LOD body triangles, studs excluded",
    });
    let file = format!("model-{}-far.glb", stem(name));
    let bytes = glb::write_with_arrays(
        &file,
        &mesh,
        json!({ "unit": "LDU", "upAxis": "+Y", "model": name, "ldraw": ldraw, "voxels": voxels }),
        &[
            UintArray {
                name: "voxelCells",
                values: &grid.cells,
            },
            UintArray {
                name: "voxelColors",
                values: &grid.colors,
            },
        ],
    );
    fs::write(out.join(&file), bytes).map_err(|e| e.to_string())?;
    Ok(Some(json!({
        "file": file,
        "voxels": grid.count(),
        "triangles": mesh.triangle_count(),
        "origin": grid.origin,
        "dims": dims,
    })))
}

struct ConnectorIndexes {
    connectors: BTreeMap<String, Value>,
    connector_licenses: BTreeSet<String>,
    connectivity: BTreeMap<String, Value>,
}

fn write_record(
    out: &Path,
    file: String,
    part: &str,
    license: &str,
    record: &TierRecord,
) -> Result<Value, String> {
    if record.is_empty() {
        return Ok(Value::Null);
    }
    let text =
        serde_json::to_string(&record_json(part, license, record)).map_err(|e| e.to_string())?;
    fs::write(out.join(&file), text).map_err(|e| format!("{file}: {e}"))?;
    Ok(json!({ "file": file }))
}

fn connector_records<L: Library, S: Library>(
    extractor: &mut ConnectorExtractor<'_, L, S>,
    parts: &[Value],
    out: &Path,
) -> Result<ConnectorIndexes, String> {
    let mut indexes = ConnectorIndexes {
        connectors: BTreeMap::new(),
        connector_licenses: BTreeSet::new(),
        connectivity: BTreeMap::new(),
    };
    for part in parts {
        let (Some(id), Some(path)) = (part["id"].as_str(), part["path"].as_str()) else {
            return Err(format!("part summary {part} needs an id and a path"));
        };
        let records = PartRecords::of(&extractor.extract(path));
        let part_license = part["license"].as_str().unwrap_or_default();
        if !records.connectors.is_empty() {
            indexes.connector_licenses.insert(part_license.to_string());
        }
        let name = stem(path.trim_start_matches("parts/"));
        indexes.connectors.insert(
            id.to_string(),
            write_record(
                out,
                format!("connectors-{name}.json"),
                id,
                part_license,
                &records.connectors,
            )?,
        );
        indexes.connectivity.insert(
            id.to_string(),
            write_record(
                out,
                format!("connectivity-{name}.json"),
                id,
                CONNECTIVITY_LICENSE,
                &records.connectivity,
            )?,
        );
    }
    Ok(indexes)
}

fn translucent_codes(colors: &[Colour]) -> HashSet<u32> {
    colors
        .iter()
        .filter(|c| c.alpha < OPAQUE_ALPHA)
        .map(|c| c.code)
        .collect()
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
    let primitive_table: Value = serde_json::from_slice(
        &fs::read(&args.primitives).map_err(|e| format!("{}: {e}", args.primitives.display()))?,
    )
    .map_err(|e| format!("{}: {e}", args.primitives.display()))?;
    let technic = TechnicPrimitives::from_table(&primitive_table)?;
    let section_vocabulary = read_section_vocabulary(&args.vocabulary)?;
    let inferred: Value = serde_json::from_slice(
        &fs::read(&args.inferred).map_err(|e| format!("{}: {e}", args.inferred.display()))?,
    )
    .map_err(|e| format!("{}: {e}", args.inferred.display()))?;
    let probe_part = inferred["cavityProbe"].as_str().ok_or(format!(
        "{}: cavityProbe must be a part path",
        args.inferred.display()
    ))?;
    let primitive_options = CompileOptions {
        lod: args.lod,
        stud_primitives: Vec::new(),
        unofficial_allowlist: unofficial_allowlist.clone(),
        technic: TechnicPrimitives::default(),
    };
    let compiler = match &args.compiler {
        Some(path) => {
            fs::create_dir_all(&args.out).map_err(|e| e.to_string())?;
            fs::copy(path, args.out.join(COMPILER_FILE))
                .map_err(|e| format!("{}: {e}", path.display()))?;
            json!({
                "file": COMPILER_FILE,
                "unofficialAllowlist": unofficial_allowlist,
                "primitives": primitive_table,
                "cavityProbe": probe_part,
            })
        }
        None => Value::Null,
    };
    let part_options = CompileOptions {
        lod: args.lod,
        stud_primitives: stud_primitives.clone(),
        unofficial_allowlist: unofficial_allowlist.clone(),
        technic,
    };
    fs::create_dir_all(&args.out).map_err(|e| e.to_string())?;
    let ldconfig = library
        .source(LDCONFIG)
        .ok_or("LDConfig.ldr is missing from the LDraw library")?;
    let mut baker = ModelBaker::new(
        &library,
        stud_primitives.clone(),
        unofficial_allowlist,
        translucent_codes(&parse_ldconfig(ldconfig)),
    )
    .map_err(|e| e.to_string())?;

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
        summary["path"] = json!(compiled.path);
        summary["file"] = json!(file);
        primitives.push(summary);
    }

    let mut parts = Vec::new();
    let mut shapes: Vec<LatticeShape> = Vec::new();
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
        if !entry["producedColors"].is_null() {
            summary["producedColors"] = entry["producedColors"].clone();
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

    let signatures = vehicle_signatures(&palette)?;
    let rails = rail_head_bands(&geometry)?;
    let mut compiler = compiler;
    if let Some(entry) = compiler.as_object_mut() {
        entry.insert(
            "vehicles".into(),
            json!({
                "parts": palette["vehicleParts"],
                "railHeads": rails
                    .iter()
                    .map(|rail| json!({ "railPart": rail.rail_part, "inner": rail.inner, "outer": rail.outer }))
                    .collect::<Vec<_>>(),
            }),
        );
    }
    let ldconfig_colours = library
        .source(LDCONFIG)
        .map(parse_ldconfig)
        .unwrap_or_default();
    if ldconfig_colours.is_empty() {
        return Err("LDConfig.ldr is missing or has no !COLOUR lines".into());
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
        let acknowledged = acknowledged_not_drawn(&entry, file)?;
        let mut not_drawn: Vec<Value> = Vec::new();
        let mut used: HashSet<String> = HashSet::new();
        for loose in &baked.loose_geometry {
            let Some(reason) = acknowledged.get(&loose.section) else {
                return Err(format!(
                    "{file}: model section {} has {} triangles and {} quads outside any part",
                    loose.section, loose.triangles, loose.quads
                ));
            };
            used.insert(loose.section.clone());
            not_drawn.push(json!({ "section": loose.section, "kind": "looseGeometry", "triangles": loose.triangles, "quads": loose.quads, "reason": reason }));
        }
        let mut inline_parts: Vec<Value> = Vec::new();
        for part in &baked.inline_parts {
            if let Some(reason) = acknowledged.get(&part.inline) {
                used.insert(part.inline.clone());
                let mut colors: BTreeMap<u32, usize> = BTreeMap::new();
                for instance in &baked.instances {
                    if instance.inline.as_deref() == Some(part.inline.as_str()) {
                        *colors.entry(instance.color).or_default() += 1;
                    }
                }
                let instances: usize = colors.values().sum();
                let colors: Vec<Value> = colors
                    .into_iter()
                    .map(|(color, count)| json!({ "color": color, "instances": count }))
                    .collect();
                not_drawn.push(json!({ "section": part.inline, "kind": "customPart", "instances": instances, "colors": colors, "reason": reason }));
                continue;
            }
            let comparison = compare_inline_part(&library, &text, &part.inline, &part.official)
                .map_err(|e| format!("{file}: {}: {e:?}", part.inline))?;
            if !comparison.equivalent() {
                return Err(format!(
                    "{file}: inline part {} differs from official {} (colours {:?} against {:?}, surface within weld {}, farthest measured point {:.4} LDU)",
                    part.inline,
                    part.official,
                    comparison.inline_colors,
                    comparison.official_colors,
                    comparison.surface_within_weld,
                    comparison.max_measured_distance
                ));
            }
            inline_parts.push(json!({ "inline": part.inline, "official": part.official, "maxMeasuredDistanceLdu": comparison.max_measured_distance }));
        }
        if let Some(stale) = acknowledged.keys().find(|section| !used.contains(*section)) {
            return Err(format!(
                "{file}: palette notDrawn lists {stale}, which the model does not drop"
            ));
        }
        let drawn: Vec<ModelInstance> = baked
            .instances
            .iter()
            .filter(|instance| {
                instance
                    .inline
                    .as_ref()
                    .is_none_or(|inline| !acknowledged.contains_key(inline))
            })
            .cloned()
            .collect();
        let vehicles: Vec<Value> = baker
            .vehicles(&drawn, &signatures, &rails)
            .map_err(|e| format!("{file}: {e}"))?
            .iter()
            .map(vehicle_json)
            .collect();
        let mut model_parts: Vec<Value> = Vec::new();
        let mut model_part_index: HashMap<usize, usize> = HashMap::new();
        let mut instance_parts = Vec::with_capacity(drawn.len());
        let mut instance_global_parts = Vec::with_capacity(drawn.len());
        let mut instance_colors = Vec::with_capacity(drawn.len());
        let mut instance_matrices = Vec::with_capacity(drawn.len() * 12);
        for instance in &drawn {
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
        let drawn_shapes: Vec<&LatticeShape> = instance_global_parts
            .iter()
            .map(|&index| &shapes[index])
            .collect();
        let lattice = drawn_lattice(&drawn, &drawn_shapes).map_err(|e| format!("{file}: {e}"))?;
        let total_studs = baker
            .stud_total(&drawn, &drawn_shapes)
            .map_err(|e| format!("{file}: {e}"))?;
        let cached = args
            .cover_cache
            .as_ref()
            .map(|dir| dir.join(format!("{}.json", stem(name))));
        let reuse = match (&cached, args.lod) {
            (Some(path), Lod::Low | Lod::Far) if path.exists() => Some(
                serde_json::from_slice::<Value>(&fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            ),
            _ => None,
        };
        let (cover_file, cover_manifest) = match reuse {
            Some(cached) => (cached["file"].clone(), cached["summary"].clone()),
            None => {
                let cover = baker
                    .cover(&drawn, lattice.as_ref())
                    .map_err(|e| format!("{file}: {e}"))?;
                let pair = (cover_json(&cover), cover_summary(&cover));
                if let (Some(path), Lod::Standard) = (&cached, args.lod) {
                    fs::create_dir_all(path.parent().unwrap_or(&args.out))
                        .map_err(|e| e.to_string())?;
                    fs::write(
                        path,
                        serde_json::to_vec(&json!({ "file": pair.0, "summary": pair.1 }))
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                }
                pair
            }
        };
        if cover_file["studs"].as_u64() != Some(total_studs as u64) {
            return Err(format!(
                "{file}: the stud cover lists {} studs but the model has {total_studs}",
                cover_file["studs"]
            ));
        }
        let lattice_json = match &lattice {
            Some(lattice) => json!({
                "phase": lattice.phase,
                "phaseLayerY": lattice.phase_layer_y,
                "phaseLayerStuds": lattice.phase_layer_studs,
                "phaseLayerAgreeing": lattice.phase_layer_agreeing,
                "aabb": { "min": lattice.aabb_min, "max": lattice.aabb_max },
            }),
            None => Value::Null,
        };
        let model_file = format!("model-{}.json", stem(name));
        let sections: Vec<Value> = baked
            .sections
            .iter()
            .map(|h| json!({ "name": h.name, "title": h.title, "author": h.author, "license": h.license, "ldrawOrg": h.ldraw_org }))
            .collect();
        let mut model = json!({
            "name": name,
            "file": file,
            "source": entry["source"],
            "retrieved": entry["retrieved"],
            "sha256": entry["sha256"],
            "sections": sections,
            "inlinePartsResolvedToOfficial": inline_parts,
            "parts": model_parts,
            "lattice": lattice_json,
            "cover": cover_file,
            "instances": { "part": instance_parts, "color": instance_colors, "matrix": instance_matrices },
            "vehicles": vehicles,
        });
        if !not_drawn.is_empty() {
            model["notDrawn"] = json!(not_drawn);
        }
        fs::write(
            args.out.join(&model_file),
            serde_json::to_string(&model).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let authors = distinct(baked.sections.iter().map(|h| h.author.as_str()));
        let licenses = distinct(baked.sections.iter().filter_map(|h| h.license.as_deref()));
        let mut manifest_entry = json!({
            "name": name,
            "file": model_file,
            "origin": entry["origin"],
            "set": entry["set"],
            "source": entry["source"],
            "authors": authors,
            "licenses": licenses,
            "sections": sections,
            "inlinePartsResolvedToOfficial": inline_parts,
            "instances": drawn.len(),
            "lattice": lattice_json,
            "vehicles": vehicles.len(),
            "sha256": entry["sha256"],
            "cover": cover_manifest,
        });
        if !not_drawn.is_empty() {
            manifest_entry["notDrawn"] = json!(not_drawn);
        }
        if !entry["role"].is_null() {
            manifest_entry["role"] = entry["role"].clone();
        }
        if args.lod == Lod::Far {
            let model_ldraw = json!({
                "file": file,
                "name": name,
                "source": entry["source"],
                "authors": authors,
                "licenses": licenses,
                "sections": sections,
            });
            manifest_entry["farMesh"] = far_mesh(
                &mut baker,
                &args.out,
                name,
                &drawn,
                &model_ldraw,
                &mut credits,
            )
            .map_err(|e| format!("{file}: {e}"))?
            .unwrap_or(Value::Null);
        }
        models.push(manifest_entry);
    }

    let shadow = LazyLibrary::new(args.shadow.clone());
    let patch_files = LazyLibrary::new(args.patches.clone());
    let patch_manifest_path = args.patches.join(PATCH_MANIFEST);
    let patch_manifest: Value = serde_json::from_slice(
        &fs::read(&patch_manifest_path)
            .map_err(|e| format!("{}: {e}", patch_manifest_path.display()))?,
    )
    .map_err(|e| format!("{}: {e}", patch_manifest_path.display()))?;
    let verified = verified_patch_paths(&patch_manifest);
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow).patched(ShadowPatches {
            files: &patch_files,
            verified: &verified,
        }),
        PrimitiveConnectors::new(&library, PrimitiveTable::from_json(&primitive_table)?),
        InferredFeatures::new(&library, section_vocabulary.clone(), probe_part)?,
    );
    let indexes = connector_records(&mut extractor, &parts, &args.out)?;
    let connectivity_source = &palette["connectivitySource"];
    let connectivity_index = json!({
        "package": "connectivity",
        "licenses": [CONNECTIVITY_LICENSE],
        "attribution": [
            format!(
                "LDCad Shadow Library by {SHADOW_AUTHORS}, github.com/{} at {}, {CONNECTIVITY_LICENSE}",
                connectivity_source["repo"].as_str().unwrap_or_default(),
                connectivity_source["commit"].as_str().unwrap_or_default(),
            ),
            PATCH_ATTRIBUTION,
        ],
        "source": connectivity_source,
        "parts": indexes.connectivity,
    });
    let connector_index = json!({
        "package": "connectors",
        "licenses": indexes.connector_licenses,
        "attribution": [],
        "source": palette["source"],
        "parts": indexes.connectors,
    });
    for (file, index) in [
        (CONNECTIVITY_INDEX_FILE, &connectivity_index),
        (CONNECTOR_INDEX_FILE, &connector_index),
    ] {
        let text = serde_json::to_string(index).map_err(|e| e.to_string())?;
        fs::write(args.out.join(file), text).map_err(|e| format!("{file}: {e}"))?;
    }

    let ldconfig_header = parse_ldraw(ldconfig).header;
    credits.insert(
        LDCONFIG.to_string(),
        credit(&ldconfig_header.name, &ldconfig_header),
    );
    let colors: Vec<Value> = parse_ldconfig(ldconfig)
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
        "modified": modified_note(args.lod),
        "disclaimer": DISCLAIMER,
        "compiler": compiler,
        "connectors": { "file": CONNECTOR_INDEX_FILE },
        "connectivity": { "file": CONNECTIVITY_INDEX_FILE },
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
