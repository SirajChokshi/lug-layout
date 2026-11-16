mod tracking;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::process::ExitCode;

use brick_compile::flatten::FlattenError;
use brick_compile::inline::inline_part_distance;
use brick_compile::ldraw::Header;
use brick_compile::mesh::WELD_EPSILON_LDU;
use brick_compile::model::bake_model;
use brick_compile::studio::{read_io, StudioError};
use brick_compile::{compile_part, CompileError, CompileOptions, Lod};
use serde_json::{json, Map, Value};

use tracking::TrackingLibrary;

const HEADER_LENGTH_BYTES: usize = 4;
const JSON_REQUEST_START: u8 = b'{';

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn header_json(header: &Header) -> Value {
    json!({
        "name": header.name,
        "title": header.title,
        "author": header.author,
        "license": header.license,
        "ldrawOrg": header.ldraw_org,
    })
}

fn bake(request: &Value) -> Result<Vec<u8>, String> {
    let source = request["source"].as_str().ok_or("bake needs a source")?;
    let baked = bake_model(source).map_err(|e| e.to_string())?;
    let mut part_ids: Vec<&str> = Vec::new();
    let mut part_index: HashMap<&str, usize> = HashMap::new();
    let mut parts = Vec::with_capacity(baked.instances.len());
    let mut colors = Vec::with_capacity(baked.instances.len());
    let mut matrices = Vec::with_capacity(baked.instances.len() * 12);
    for instance in &baked.instances {
        let index = *part_index.entry(&instance.part).or_insert_with(|| {
            part_ids.push(&instance.part);
            part_ids.len() - 1
        });
        parts.push(index);
        colors.push(instance.color);
        matrices.extend(instance.matrix.m);
    }
    let response = json!({
        "sections": baked.sections.iter().map(header_json).collect::<Vec<_>>(),
        "parts": part_ids,
        "instances": { "part": parts, "color": colors, "matrix": matrices },
        "inlineParts": baked
            .inline_parts
            .iter()
            .map(|p| json!({ "inline": p.inline, "official": p.official }))
            .collect::<Vec<_>>(),
    });
    serde_json::to_vec(&response).map_err(|e| e.to_string())
}

fn parse_lod(value: &Value) -> Result<Lod, String> {
    match value.as_str() {
        Some("standard") => Ok(Lod::Standard),
        Some("low") => Ok(Lod::Low),
        Some("far") => Ok(Lod::Far),
        other => Err(format!("unknown lod {other:?}")),
    }
}

fn failure(kind: &str, message: String) -> Value {
    json!({ "status": "failed", "kind": kind, "message": message })
}

fn compile_failure(error: &CompileError) -> Value {
    let message = error.to_string();
    match error {
        CompileError::Flatten(FlattenError::Unresolved { reference, from }) => {
            let mut entry = failure("unresolved", message);
            entry["missing"] = json!(reference);
            entry["from"] = json!(from);
            entry
        }
        CompileError::Flatten(FlattenError::TooDeep { .. }) => failure("tooDeep", message),
        CompileError::License { path, .. } => {
            let mut entry = failure("license", message);
            entry["path"] = json!(path);
            entry
        }
        CompileError::Unofficial { path, ldraw_org } => {
            let mut entry = failure("unofficial", message);
            entry["path"] = json!(path);
            entry["ldrawOrg"] = json!(ldraw_org);
            entry
        }
    }
}

fn flatten_failure(error: &FlattenError) -> Value {
    compile_failure(&CompileError::Flatten(error.clone()))
}

fn need(paths: Vec<String>) -> Value {
    json!({ "status": "need", "paths": paths })
}

fn compile(request: &Value) -> Result<Vec<u8>, String> {
    let files: HashMap<String, String> = request["files"]
        .as_object()
        .map(|files| {
            files
                .iter()
                .filter_map(|(path, text)| Some((path.clone(), text.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let absent: HashSet<String> = strings(request, "absent").into_iter().collect();
    let library = TrackingLibrary::new(files, absent);
    let options = CompileOptions {
        lod: parse_lod(&request["lod"])?,
        stud_primitives: strings(request, "studPrimitives"),
        unofficial_allowlist: strings(request, "unofficialAllowlist"),
    };
    let mut blob: Vec<u8> = Vec::new();
    let mut parts = Vec::new();
    for reference in strings(request, "parts") {
        let result = compile_part(&library, &reference, &options);
        let requested = library.take_requested();
        let mut entry = match result {
            _ if !requested.is_empty() => need(requested),
            Ok(compiled) => {
                let glb = compiled.to_glb();
                let header = &compiled.flattened_files[0].header;
                let entry = json!({
                    "status": "compiled",
                    "offset": blob.len(),
                    "length": glb.len(),
                    "file": compiled.path,
                    "header": header_json(header),
                    "files": compiled.flattened_files.len(),
                });
                blob.extend(glb);
                entry
            }
            Err(error) => compile_failure(&error),
        };
        entry["reference"] = json!(reference);
        parts.push(entry);
    }
    let model = request["model"].as_str().unwrap_or_default();
    let mut inline = Vec::new();
    for check in request["inlineChecks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let (Some(inline_name), Some(official)) =
            (check["inline"].as_str(), check["official"].as_str())
        else {
            continue;
        };
        let result = inline_part_distance(&library, model, inline_name, official);
        let requested = library.take_requested();
        let mut entry = match result {
            _ if !requested.is_empty() => need(requested),
            Ok(distance) => json!({
                "status": "measured",
                "maxVertexDistanceLdu": distance,
                "withinWeld": distance <= WELD_EPSILON_LDU,
            }),
            Err(error) => flatten_failure(&error),
        };
        entry["inline"] = json!(inline_name);
        entry["official"] = json!(official);
        inline.push(entry);
    }
    let mut header = Map::new();
    header.insert("parts".into(), Value::Array(parts));
    header.insert("inline".into(), Value::Array(inline));
    header.insert("weldEpsilonLdu".into(), json!(WELD_EPSILON_LDU));
    let header = serde_json::to_vec(&Value::Object(header)).map_err(|e| e.to_string())?;
    let length = u32::try_from(header.len()).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(HEADER_LENGTH_BYTES + header.len() + blob.len());
    out.extend(length.to_le_bytes());
    out.extend(header);
    out.extend(blob);
    Ok(out)
}

fn read_studio(payload: &[u8]) -> Result<Vec<u8>, String> {
    let response = match read_io(payload) {
        Ok(archive) => json!({
            "status": "read",
            "entry": archive.entry,
            "ldraw": archive.ldraw,
            "studioVersion": archive.studio_version,
            "convertedLines": archive.converted_lines,
            "unconvertedLines": archive.unconverted_lines,
            "bricklinkIds": archive.bricklink_ids,
            "customParts": archive.custom_parts,
        }),
        Err(error) => {
            let kind = match error {
                StudioError::NotZip(_) => "notZip",
                StudioError::Encrypted => "encrypted",
                StudioError::NoModel { .. } => "noModel",
            };
            json!({ "status": "rejected", "kind": kind, "message": error.to_string() })
        }
    };
    serde_json::to_vec(&response).map_err(|e| e.to_string())
}

fn split_request(input: &[u8]) -> Result<(Value, &[u8]), String> {
    if input.first() == Some(&JSON_REQUEST_START) {
        let request = serde_json::from_slice(input).map_err(|e| e.to_string())?;
        return Ok((request, &[]));
    }
    let length_bytes: [u8; HEADER_LENGTH_BYTES] = input
        .get(..HEADER_LENGTH_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("framed request is shorter than its length prefix")?;
    let header_end = HEADER_LENGTH_BYTES
        + usize::try_from(u32::from_le_bytes(length_bytes)).map_err(|e| e.to_string())?;
    let header = input
        .get(HEADER_LENGTH_BYTES..header_end)
        .ok_or("framed request is shorter than its header")?;
    let request = serde_json::from_slice(header).map_err(|e| e.to_string())?;
    Ok((request, &input[header_end..]))
}

fn run() -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .read_to_end(&mut input)
        .map_err(|e| e.to_string())?;
    let (request, payload) = split_request(&input)?;
    match request["op"].as_str() {
        Some("bake") => bake(&request),
        Some("compile") => compile(&request),
        Some("readStudio") => read_studio(payload),
        other => Err(format!("unknown op {other:?}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(bytes) => {
            let mut stdout = std::io::stdout().lock();
            if stdout
                .write_all(&bytes)
                .and_then(|()| stdout.flush())
                .is_err()
            {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("brick-compile-wasm: {message}");
            ExitCode::FAILURE
        }
    }
}
