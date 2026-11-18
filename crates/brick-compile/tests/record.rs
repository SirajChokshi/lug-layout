mod common;

use std::fs;
use std::path::Path;

use brick_compile::cover::{tree_order, PartSolid};
use brick_compile::record::{BakeRecord, RecordError};
use brick_compile::vehicle::part_bounds;
use brick_compile::{compile_part, CompileOptions, Lod};
use serde_json::Value;

const PART_FOLDER: &str = "parts/";
const PART_EXTENSION: &str = ".dat";
const MIN_RECORDED_PARTS: usize = 100;

fn palette_list(palette: &Value, key: &str) -> Vec<String> {
    palette[key]
        .as_array()
        .expect("palette list")
        .iter()
        .map(|value| value.as_str().expect("palette string").to_string())
        .collect()
}

fn bits(values: &[f32]) -> Vec<u32> {
    values.iter().map(|value| value.to_bits()).collect()
}

#[test]
fn every_fixture_part_decodes_to_its_compiled_mesh_studs_bounds_and_the_same_solid() {
    let library = common::fixture_library();
    let palette: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/asset-pipeline/palette.json"),
        )
        .expect("palette"),
    )
    .expect("palette json");
    let options = CompileOptions {
        lod: Lod::Standard,
        stud_primitives: palette_list(&palette, "studPrimitives"),
        unofficial_allowlist: palette_list(&palette, "unofficialAllowlist"),
        ..CompileOptions::default()
    };
    let mut parts: Vec<&str> = library
        .0
        .keys()
        .filter_map(|path| path.strip_prefix(PART_FOLDER))
        .filter(|name| !name.contains('/') && name.ends_with(PART_EXTENSION))
        .collect();
    parts.sort_unstable();
    let mut recorded = 0;
    for reference in parts {
        let Ok(compiled) = compile_part(&library, reference, &options) else {
            continue;
        };
        let bounds = part_bounds(&library, reference).expect("bounds of a compiled part");
        let bytes = BakeRecord::of(&compiled, bounds).encode().expect("encode");
        let decoded = BakeRecord::decode(&bytes).expect("decode");
        assert_eq!(
            bits(&decoded.mesh.positions),
            bits(&compiled.mesh.positions),
            "{reference}"
        );
        assert_eq!(decoded.mesh.groups, compiled.mesh.groups, "{reference}");
        assert_eq!(decoded.studs.len(), compiled.studs.len(), "{reference}");
        for (kept, stud) in decoded.studs.iter().zip(&compiled.studs) {
            assert_eq!(kept.primitive, stud.primitive, "{reference}");
            assert_eq!(kept.color, stud.color, "{reference}");
            assert_eq!(
                kept.matrix.m.map(f64::to_bits),
                stud.matrix.m.map(f64::to_bits),
                "{reference}"
            );
        }
        assert_eq!(
            decoded.whole_bounds.map(|corner| corner.map(f64::to_bits)),
            bounds.map(|corner| corner.map(f64::to_bits)),
            "{reference}"
        );
        assert_eq!(
            decoded.tree_order,
            tree_order(&compiled.mesh),
            "{reference}"
        );
        let rebuilt = PartSolid::from_record(&decoded).expect("a decoded record rebuilds");
        assert!(
            rebuilt.same_bits(&PartSolid::from_mesh(&compiled.mesh)),
            "{reference}"
        );
        assert_eq!(decoded.encode().expect("re-encode"), bytes, "{reference}");
        recorded += 1;
    }
    assert!(
        recorded >= MIN_RECORDED_PARTS,
        "only {recorded} fixture parts compiled"
    );
}

#[test]
fn a_record_carrying_another_order_is_refused_or_rebuilds_a_different_solid() {
    let library = common::fixture_library();
    let compiled = compile_part(&library, "3001.dat", &CompileOptions::default()).expect("3001");
    let bounds = part_bounds(&library, "3001.dat").expect("bounds");
    let record = BakeRecord::of(&compiled, bounds);
    let built = PartSolid::from_mesh(&compiled.mesh);
    let mut duplicated = record.clone();
    duplicated.tree_order[1] = duplicated.tree_order[0];
    assert!(matches!(
        PartSolid::from_record(&duplicated),
        Err(RecordError::Order)
    ));
    let mut short = record.clone();
    short.tree_order.pop();
    assert!(matches!(
        PartSolid::from_record(&short),
        Err(RecordError::Order)
    ));
    let mut identity = record.clone();
    identity.tree_order = (0..record.tree_order.len()).collect();
    assert_ne!(identity.tree_order, record.tree_order);
    let other = PartSolid::from_record(&identity).expect("a permutation rebuilds");
    assert!(!other.same_bits(&built));
    assert!(PartSolid::from_record(&record)
        .expect("own order")
        .same_bits(&built));
}
