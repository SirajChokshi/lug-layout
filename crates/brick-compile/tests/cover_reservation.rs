mod common;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use brick_compile::affine::Affine;
use brick_compile::bake::{BakeError, LatticeShape, ModelBaker, PartSpan};
use brick_compile::cover::{CellsCause, CellsTooLarge, CoverShard};
use brick_compile::model::ModelInstance;
use brick_compile::{compile_part, CompileError, CompileOptions};
use common::{fixture_library, MemoryLibrary};

const CA: &str = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";
const STUD_LDU: f64 = 20.0;
const SIDE_JUST_BEYOND_WASM32_LDU: f64 = 231_700.0;

fn square(side: f64) -> MemoryLibrary {
    MemoryLibrary(HashMap::from([(
        "parts/square.dat".to_string(),
        format!(
            "0 Custom square\n0 Name: square.dat\n{CA}\n0 BFC CERTIFY CCW\n4 16 0 0 0 {side} 0 0 {side} 0 {side} 0 0 {side}\n"
        ),
    )]))
}

fn compile_square(side: f64) -> Result<(), CompileError> {
    compile_part(&square(side), "square.dat", &CompileOptions::default()).map(drop)
}

fn refused(side: f64, cause: CellsCause) -> Result<(), CompileError> {
    let cells = (side / STUD_LDU) as i128 + 1;
    Err(CompileError::TooLarge {
        path: "parts/square.dat".to_string(),
        extent_ldu: [side, side],
        cells: CellsTooLarge {
            width: cells,
            depth: cells,
            cause,
        },
    })
}

fn table_depth() -> f64 {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/verified-facts/geometry.json");
    let geometry: serde_json::Value =
        serde_json::from_slice(&fs::read(path).expect("geometry facts are readable"))
            .expect("geometry facts are JSON");
    geometry["tablePlane"]["depthBelowTopLdu"]
        .as_f64()
        .expect("geometry facts record the table plane depth")
}

fn stud_cells(power: i32) -> f64 {
    STUD_LDU * 2f64.powi(power)
}

#[test]
fn a_part_whose_stud_cover_the_wasm_compiler_cannot_address_is_refused_alike_on_every_host() {
    assert_eq!(compile_square(STUD_LDU * 2.0), Ok(()));
    for side in [SIDE_JUST_BEYOND_WASM32_LDU, stud_cells(32)] {
        assert_eq!(
            compile_square(side),
            refused(side, CellsCause::BeyondAddressSpace)
        );
    }
    let refusal = compile_square(SIDE_JUST_BEYOND_WASM32_LDU).unwrap_err();
    assert_eq!(
        refusal.to_string(),
        "parts/square.dat spans 231700 × 231700 LDU, and a stud cover of 11586 × 11586 cells needs more memory than the 32-bit WASM compiler can address"
    );
    assert!(!refusal.depends_on_machine());
}

#[test]
fn only_a_refusal_for_memory_this_machine_could_not_reserve_depends_on_the_machine() {
    let refusal = |cause| CompileError::TooLarge {
        path: "parts/square.dat".to_string(),
        extent_ldu: [SIDE_JUST_BEYOND_WASM32_LDU; 2],
        cells: CellsTooLarge {
            width: 11_586,
            depth: 11_586,
            cause,
        },
    };
    assert!(refusal(CellsCause::MemoryUnavailable).depends_on_machine());
    assert!(!refusal(CellsCause::BeyondAddressSpace).depends_on_machine());
    assert!(!CompileError::NoStudRing.depends_on_machine());
}

fn placed(part: &str, at: f64) -> ModelInstance {
    ModelInstance {
        part: part.to_string(),
        inline: None,
        color: 4,
        matrix: Affine {
            m: [1.0, 0.0, 0.0, at, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, at],
        },
        submodel: None,
    }
}

#[test]
fn parts_placed_beyond_any_stud_cover_fail_the_bake_softly_naming_both_parts() {
    let library = fixture_library();
    let apart = stud_cells(32);
    let drawn = [placed("3001.dat", 0.0), placed("3003.dat", apart)];
    let mut baker = ModelBaker::new(
        &library,
        vec!["stud.dat".to_string()],
        Vec::new(),
        HashSet::new(),
        table_depth(),
    )
    .expect("the stud primitive compiles");
    let shapes: Vec<LatticeShape> = drawn
        .iter()
        .map(|instance| {
            LatticeShape::of(
                baker
                    .standard_part(&instance.part)
                    .expect("an official brick compiles"),
            )
        })
        .collect();
    let lattice = baker
        .lattice(&drawn, &shapes.iter().collect::<Vec<_>>())
        .expect("both bricks agree on one lattice phase")
        .expect("both bricks have studs on the lattice");
    let span = |ldu: f64| {
        Box::new(PartSpan {
            from: "3001.dat".to_string(),
            to: "3003.dat".to_string(),
            ldu,
        })
    };
    let cells_apart = (apart / STUD_LDU) as i128;

    assert_eq!(
        baker.cover(&drawn, Some(&lattice), CoverShard::WHOLE).err(),
        Some(BakeError::Cover {
            cells: CellsTooLarge {
                width: cells_apart + 3,
                depth: cells_apart + 2,
                cause: CellsCause::BeyondAddressSpace,
            },
            x: span(apart + 60.0),
            z: span(apart + 40.0),
        })
    );
}
