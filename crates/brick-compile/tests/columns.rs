mod common;

use std::fs;
use std::path::Path;

use brick_compile::affine::Affine;
use brick_compile::cover::{
    model_cover, CoverInstance, CoverShard, ModelCells, Opacity, PartSolid, StudShape,
};
use brick_compile::{compile_part, CompileOptions};
use common::fixture_library;

const STUD: StudShape = StudShape {
    height: 4.0,
    radius: 6.0,
    inscribed_radius: 6.0,
};
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

fn cells_of(part: &str) -> ModelCells {
    let options = CompileOptions {
        stud_primitives: vec!["stud.dat".to_string(), "stud2.dat".to_string()],
        ..CompileOptions::default()
    };
    let compiled = compile_part(&fixture_library(), part, &options).expect("part compiles");
    let studs: Vec<Affine> = compiled.studs.iter().map(|stud| stud.matrix).collect();
    let phase_of = |s: &Affine| {
        [
            s.m[3].rem_euclid(20.0) as u32,
            s.m[11].rem_euclid(20.0) as u32,
        ]
    };
    let phase = phase_of(studs.first().expect("the part has studs"));
    assert!(
        studs.iter().all(|s| phase_of(s) == phase),
        "{part} has all its studs on one lattice phase"
    );
    let solids = [PartSolid::from_mesh(&compiled.mesh)];
    let instances = [CoverInstance {
        matrix: &Affine::IDENTITY,
        color: 16,
        part: 0,
        studs: &studs,
    }];
    let stud_layer_y = studs.iter().map(|s| s.m[7]).fold(f64::INFINITY, f64::min);
    model_cover(
        &instances,
        &solids,
        &Opacity::new([]),
        Some((phase, stud_layer_y)),
        STUD,
        CoverShard::WHOLE,
        table_depth(),
    )
    .expect("a part's stud cover is allocated")
    .cells
    .expect("a lattice phase gives cells")
}

#[test]
fn a_slope_column_is_as_high_as_its_sloped_face_reaches_in_that_cell() {
    let brick = cells_of("3001.dat");
    assert_eq!(brick.column_top, [3; 8]);
    assert_eq!(brick.column_bottom, [0; 8]);

    let slope_3x1 = cells_of("4286.dat");
    assert_eq!([slope_3x1.width, slope_3x1.depth], [1, 3]);
    assert_eq!(slope_3x1.column_top, [3, 3, 2]);

    let slope_3x2 = cells_of("3298.dat");
    assert_eq!([slope_3x2.width, slope_3x2.depth], [2, 3]);
    assert_eq!(slope_3x2.column_top, [3, 3, 3, 3, 2, 2]);
}

#[test]
fn an_inverted_slope_column_starts_where_its_underside_does() {
    let inverted = cells_of("4287a.dat");
    assert_eq!([inverted.width, inverted.depth], [1, 3]);
    assert_eq!(inverted.column_bottom, [0, 0, 1]);
}

#[test]
fn a_round_corner_plate_claims_no_cell_its_arc_leaves_empty() {
    let corner = cells_of("30565.dat");
    assert_eq!([corner.width, corner.depth], [4, 4]);
    let empty: Vec<usize> = (0..16)
        .filter(|&cell| corner.column_top[cell] == -1)
        .collect();
    assert_eq!(empty, [15]);
    assert!(corner.column_top[..15].iter().all(|&top| top == 1));
}
