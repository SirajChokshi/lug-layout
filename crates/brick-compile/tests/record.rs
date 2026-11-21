mod common;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use brick_compile::bake::{BakeError, LatticeShape, ModelBaker, RecordShelf};
use brick_compile::compile::stud_primitives_from_table;
use brick_compile::cover::{tree_order, CoverShard, PartSolid};
use brick_compile::model::bake_model;
use brick_compile::record::{BakeRecord, RecordError};
use brick_compile::vehicle::part_bounds;
use brick_compile::vehicle::VehicleSignatures;
use brick_compile::{compile_part, CompileOptions, Lod};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

const PART_FOLDER: &str = "parts/";
const PART_EXTENSION: &str = ".dat";
const MIN_RECORDED_PARTS: usize = 100;

fn table_depth() -> f64 {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/verified-facts/geometry.json");
    let geometry: Value =
        serde_json::from_slice(&fs::read(path).expect("geometry facts are readable"))
            .expect("geometry facts are JSON");
    geometry["tablePlane"]["depthBelowTopLdu"]
        .as_f64()
        .expect("geometry facts record the table plane depth")
}

fn palette_list(palette: &Value, key: &str) -> Vec<String> {
    palette[key]
        .as_array()
        .expect("palette list")
        .iter()
        .map(|value| value.as_str().expect("palette string").to_string())
        .collect()
}

fn table_studs() -> Vec<String> {
    let table: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tools/asset-pipeline/primitive-connectors.json"),
        )
        .expect("the primitive table is readable"),
    )
    .expect("the primitive table is JSON");
    stud_primitives_from_table(&table).expect("the table names stud primitives")
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
        stud_primitives: table_studs(),
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
        assert_eq!(decoded.rounds, compiled.rounds, "{reference}");
        let rebuilt = PartSolid::from_record(&decoded).expect("a decoded record rebuilds");
        assert!(
            rebuilt.same_bits(&PartSolid::from_mesh(&compiled.mesh).with_rounds(&compiled.rounds)),
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
    let built = PartSolid::from_mesh(&compiled.mesh).with_rounds(&compiled.rounds);
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

const RECORDED_TRAIN: &str = "10013-1.mpd";

fn palette() -> Value {
    serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/asset-pipeline/palette.json"),
        )
        .expect("palette"),
    )
    .expect("palette json")
}

#[test]
fn a_model_baked_from_records_equals_the_model_baked_from_compiled_parts() {
    let library = common::fixture_library();
    let palette = palette();
    let stud_primitives = table_studs();
    let allowlist = palette_list(&palette, "unofficialAllowlist");
    let vehicle_parts = &palette["vehicleParts"];
    let signatures = VehicleSignatures {
        bogie_pivots: palette_list(vehicle_parts, "bogiePivots"),
        pivot_pins: palette_list(vehicle_parts, "pivotPins"),
        wheelsets: palette_list(vehicle_parts, "wheelsets"),
        wheels: palette_list(vehicle_parts, "wheels"),
        couplers: palette_list(vehicle_parts, "couplers"),
    };
    let source = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.cache/omr")
            .join(RECORDED_TRAIN),
    )
    .expect("the pinned OMR train is restored");
    let options = CompileOptions {
        lod: Lod::Standard,
        stud_primitives: stud_primitives.clone(),
        unofficial_allowlist: allowlist.clone(),
        ..CompileOptions::default()
    };
    let mut shelf = RecordShelf::new();
    let parts: BTreeSet<String> = bake_model(&source)
        .expect("model")
        .instances
        .into_iter()
        .map(|instance| instance.part)
        .collect();
    for reference in &parts {
        let Ok(compiled) = compile_part(&library, reference, &options) else {
            continue;
        };
        let bounds = part_bounds(&library, reference).expect("bounds");
        let bytes = BakeRecord::of(&compiled, bounds).encode().expect("encode");
        shelf.insert(
            reference.clone(),
            Arc::new(BakeRecord::decode(&bytes).expect("decode")),
        );
    }
    let drawn: Vec<_> = bake_model(&source)
        .expect("model")
        .instances
        .into_iter()
        .filter(|instance| shelf.contains_key(&instance.part))
        .collect();
    let bake = |records: Option<&RecordShelf>| {
        let baker = ModelBaker::new(
            &library,
            stud_primitives.clone(),
            allowlist.clone(),
            HashSet::new(),
            table_depth(),
        )
        .expect("baker");
        let mut baker = match records {
            Some(shelf) => baker.with_records(shelf),
            None => baker,
        };
        let shapes: Vec<LatticeShape> = drawn
            .iter()
            .map(|instance| baker.lattice_shape(&instance.part).expect("shape"))
            .collect();
        let lattice = baker
            .lattice(&drawn, &shapes.iter().collect::<Vec<_>>())
            .expect("lattice");
        let cover = baker
            .cover(&drawn, lattice.as_ref(), CoverShard::WHOLE)
            .expect("cover");
        let vehicles = baker.vehicles(&drawn, &signatures, &[]).expect("vehicles");
        let refused = drawn.iter().all(|instance| {
            matches!(
                baker.standard_part(&instance.part),
                Err(BakeError::Recorded { .. })
            )
        });
        (lattice, cover, vehicles, refused)
    };
    let compiled = bake(None);
    let recorded = bake(Some(&shelf));
    assert!(
        !drawn.is_empty() && !compiled.2.is_empty(),
        "the train bakes with a vehicle"
    );
    assert!(
        !compiled.3 && recorded.3,
        "only the recorded bake took every part from a record"
    );
    assert_eq!(recorded.0, compiled.0, "lattice");
    assert_eq!(recorded.1, compiled.1, "cover");
    assert_eq!(recorded.2, compiled.2, "vehicles");
}
