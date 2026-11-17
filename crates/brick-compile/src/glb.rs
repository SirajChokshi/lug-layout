use serde_json::{json, Value};

use crate::mesh::Mesh;

const GLB_MAGIC: u32 = 0x4654_6C67;
const GLB_VERSION: u32 = 2;
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;
const COMPONENT_FLOAT: u32 = 5126;
const COMPONENT_UNSIGNED_INT: u32 = 5125;
const TARGET_ARRAY_BUFFER: u32 = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER: u32 = 34963;
const MODE_TRIANGLES: u32 = 4;

fn pad_to_four(bytes: &mut Vec<u8>, fill: u8) {
    while !bytes.len().is_multiple_of(4) {
        bytes.push(fill);
    }
}

pub struct UintArray<'a> {
    pub name: &'a str,
    pub values: &'a [u32],
}

pub fn write(name: &str, mesh: &Mesh, extras: Value) -> Vec<u8> {
    write_with_arrays(name, mesh, extras, &[])
}

pub fn write_with_arrays(
    name: &str,
    mesh: &Mesh,
    mut extras: Value,
    arrays: &[UintArray],
) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let mut buffer_views = Vec::new();
    let mut accessors = Vec::new();

    let mut push_view = |bin: &mut Vec<u8>, data: &[u8], target: u32| -> usize {
        let offset = bin.len();
        bin.extend_from_slice(data);
        pad_to_four(bin, 0);
        buffer_views.push(json!({
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": data.len(),
            "target": target,
        }));
        buffer_views.len() - 1
    };

    let positions: Vec<u8> = mesh
        .positions
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    let normals: Vec<u8> = mesh.normals.iter().flat_map(|v| v.to_le_bytes()).collect();
    let position_view = push_view(&mut bin, &positions, TARGET_ARRAY_BUFFER);
    let normal_view = push_view(&mut bin, &normals, TARGET_ARRAY_BUFFER);
    let [min, max] = mesh.bounds().unwrap_or([[0.0; 3]; 2]);
    accessors.push(json!({
        "bufferView": position_view,
        "componentType": COMPONENT_FLOAT,
        "count": mesh.vertex_count(),
        "type": "VEC3",
        "min": min,
        "max": max,
    }));
    accessors.push(json!({
        "bufferView": normal_view,
        "componentType": COMPONENT_FLOAT,
        "count": mesh.vertex_count(),
        "type": "VEC3",
    }));

    let mut primitives = Vec::new();
    for group in &mesh.groups {
        let indices: Vec<u8> = group.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
        let view = push_view(&mut bin, &indices, TARGET_ELEMENT_ARRAY_BUFFER);
        accessors.push(json!({
            "bufferView": view,
            "componentType": COMPONENT_UNSIGNED_INT,
            "count": group.indices.len(),
            "type": "SCALAR",
        }));
        primitives.push(json!({
            "attributes": { "POSITION": 0, "NORMAL": 1 },
            "indices": accessors.len() - 1,
            "mode": MODE_TRIANGLES,
            "extras": { "ldrawColor": group.color },
        }));
    }

    let mut array_accessors = serde_json::Map::new();
    for array in arrays {
        let bytes: Vec<u8> = array.values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let view = push_view(&mut bin, &bytes, TARGET_ARRAY_BUFFER);
        accessors.push(json!({
            "bufferView": view,
            "componentType": COMPONENT_UNSIGNED_INT,
            "count": array.values.len(),
            "type": "SCALAR",
        }));
        array_accessors.insert(array.name.to_string(), json!(accessors.len() - 1));
    }
    if !arrays.is_empty() {
        extras["arrays"] = Value::Object(array_accessors);
    }

    let document = json!({
        "asset": { "version": "2.0", "generator": "brick-compile" },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0, "name": name }],
        "meshes": [{ "name": name, "primitives": primitives }],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{ "byteLength": bin.len() }],
        "extras": extras,
    });
    let mut json_bytes = serde_json::to_vec(&document).unwrap_or_default();
    pad_to_four(&mut json_bytes, b' ');

    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&GLB_MAGIC.to_le_bytes());
    out.extend_from_slice(&GLB_VERSION.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
    out.extend_from_slice(&bin);
    out
}
