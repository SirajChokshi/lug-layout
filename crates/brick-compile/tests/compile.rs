mod common;

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use brick_compile::flatten::FlattenError;
use brick_compile::license::LicenseVerdict;
use brick_compile::technic::{Line, Pin, TechnicPart};
use brick_compile::{compile_part, CompileError, CompileOptions, Library, TechnicPrimitives};
use common::{fixture_library, MemoryLibrary};

fn memory(files: &[(&str, &str)]) -> MemoryLibrary {
    MemoryLibrary(
        files
            .iter()
            .map(|(path, source)| (path.to_string(), source.to_string()))
            .collect(),
    )
}

const CA: &str = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";
const NON_CA: &str = "0 !LICENSE Not redistributable : see NonCAreadme.txt";

#[test]
fn license_gate_rejects_any_non_ca_or_unlicensed_file_in_the_closure() {
    let part =
        format!("0 Part\n{CA}\n0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\sub.dat\n");
    let cases = [
        (NON_CA, LicenseVerdict::NonContributorAgreement),
        ("0 Author: someone", LicenseVerdict::Missing),
    ];
    for (license_line, expected) in cases {
        let sub = format!("0 Sub\n{license_line}\n3 16 0 0 0 1 0 0 0 0 1\n");
        let library = memory(&[("parts/part.dat", &part), ("parts/s/sub.dat", &sub)]);
        let result = compile_part(&library, "part.dat", &CompileOptions::default());
        assert_eq!(
            result.err(),
            Some(CompileError::License {
                path: "parts/s/sub.dat".into(),
                verdict: expected,
            })
        );
    }
}

fn first_triangle_normal_y(part: &str) -> f32 {
    let face = "0 Face\n0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n3 16 0 0 0 0 0 1 1 0 0\n";
    let library = memory(&[("parts/part.dat", part), ("parts/face.dat", face)]);
    let compiled =
        compile_part(&library, "part.dat", &CompileOptions::default()).expect("compiles");
    compiled.mesh.normals[1]
}

#[test]
fn license_gate_rejects_unofficial_files_unless_allowlisted() {
    let part =
        format!("0 Part\n{CA}\n0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\sub.dat\n");
    let sub = format!("0 Sub\n0 !LDRAW_ORG Unofficial_Subpart\n{CA}\n3 16 0 0 0 1 0 0 0 0 1\n");
    let library = memory(&[("parts/part.dat", &part), ("parts/s/sub.dat", &sub)]);

    let rejected = compile_part(&library, "part.dat", &CompileOptions::default());
    assert_eq!(
        rejected.err(),
        Some(CompileError::Unofficial {
            path: "parts/s/sub.dat".into(),
            ldraw_org: "Unofficial_Subpart".into(),
        })
    );

    let allowlisted = CompileOptions {
        unofficial_allowlist: vec!["parts/s/sub.dat".into()],
        ..CompileOptions::default()
    };
    assert!(compile_part(&library, "part.dat", &allowlisted).is_ok());
}

struct AskedLibrary {
    files: MemoryLibrary,
    missing_asked: RefCell<BTreeSet<String>>,
}

impl Library for AskedLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        let found = self.files.source(path);
        if found.is_none() {
            self.missing_asked.borrow_mut().insert(path.to_string());
        }
        found
    }
}

#[test]
fn one_compile_pass_asks_for_every_missing_file_in_the_closure_and_reports_the_first() {
    let part = format!(
        "0 Part\n{CA}\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\present.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\gone-a.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\gone-b.dat\n"
    );
    let present = format!("0 Present\n{CA}\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 deep-gone.dat\n");
    let library = AskedLibrary {
        files: memory(&[("parts/part.dat", &part), ("parts/s/present.dat", &present)]),
        missing_asked: RefCell::new(BTreeSet::new()),
    };

    let result = compile_part(&library, "part.dat", &CompileOptions::default());

    assert_eq!(
        result.err(),
        Some(CompileError::Flatten(FlattenError::Unresolved {
            reference: "deep-gone.dat".into(),
            from: "parts/s/present.dat".into(),
        }))
    );
    let asked = library.missing_asked.borrow();
    for reference in ["s/gone-a.dat", "s/gone-b.dat", "deep-gone.dat"] {
        assert!(
            asked.contains(&format!("parts/{reference}")),
            "{reference} was not asked for in the same pass: {asked:?}"
        );
    }
}

#[test]
fn bfc_keeps_the_front_face_under_mirroring_and_flips_it_on_invertnext() {
    let header = format!("0 Part\n{CA}\n0 BFC CERTIFY CCW\n");
    let plain = format!("{header}1 16 0 0 0 1 0 0 0 1 0 0 0 1 face.dat\n");
    let mirrored = format!("{header}1 16 0 0 0 -1 0 0 0 1 0 0 0 1 face.dat\n");
    let inverted = format!("{header}0 BFC INVERTNEXT\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 face.dat\n");
    let both = format!("{header}0 BFC INVERTNEXT\n1 16 0 0 0 -1 0 0 0 1 0 0 0 1 face.dat\n");

    let reference = first_triangle_normal_y(&plain);
    assert!(reference.abs() > 0.99);
    assert_eq!(first_triangle_normal_y(&mirrored), reference);
    assert_eq!(first_triangle_normal_y(&inverted), -reference);
    assert_eq!(first_triangle_normal_y(&both), -reference);
}

#[test]
fn brick_2x4_studs_are_split_out_onto_the_stud_lattice_above_the_body() {
    let library = fixture_library();
    let options = CompileOptions {
        stud_primitives: vec!["stud.dat".to_string()],
        ..CompileOptions::default()
    };
    let brick = compile_part(&library, "3001.dat", &options).expect("3001 compiles");

    let [min, max] = brick.mesh.bounds().expect("non-empty body");
    assert_eq!((min[1], max[1]), (-24.0, 0.0));

    let mut positions: Vec<(i64, i64, i64)> = brick
        .studs
        .iter()
        .map(|s| {
            (
                s.matrix.m[3] as i64,
                s.matrix.m[7] as i64,
                s.matrix.m[11] as i64,
            )
        })
        .collect();
    positions.sort();
    let mut expected: Vec<(i64, i64, i64)> = [-30, -10, 10, 30]
        .iter()
        .flat_map(|&x| [-10, 10].map(|z| (x, 0, z)))
        .collect();
    expected.sort();
    assert_eq!(positions, expected);
    assert!(brick.studs.iter().all(|s| s.primitive == "stud.dat"));
}

fn table_technic_options() -> CompileOptions {
    let table: serde_json::Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tools/asset-pipeline/primitive-connectors.json"),
        )
        .expect("the primitive table is readable"),
    )
    .expect("the primitive table is JSON");
    CompileOptions {
        stud_primitives: vec!["stud.dat".to_string(), "stud2.dat".to_string()],
        technic: TechnicPrimitives::from_table(&table).expect("the table names Technic primitives"),
        ..CompileOptions::default()
    }
}

fn technic_of(library: &MemoryLibrary, part: &str) -> Option<TechnicPart> {
    compile_part(library, part, &table_technic_options())
        .expect("part compiles")
        .technic
}

const COUNTERBORE: i32 = 8 * 16;
const BORE: i32 = 6 * 16;

fn technic_brick_hole() -> Vec<i32> {
    let mut radii = vec![COUNTERBORE; 2];
    radii.extend([BORE; 16]);
    radii.extend([COUNTERBORE; 2]);
    radii
}

#[test]
fn a_technic_brick_hole_is_read_from_its_peg_hole_ends_and_bore_through_the_brick_width() {
    let library = fixture_library();
    let one_by_two = technic_of(&library, "3700.dat").expect("3700 has Technic data");
    let one_by_four = technic_of(&library, "3701.dat").expect("3701 has Technic data");

    let holes = |part: &TechnicPart| -> Vec<(Line, i32, Vec<i32>)> {
        let mut found: Vec<_> = part
            .holes
            .iter()
            .map(|hole| (hole.line, hole.profile.from, hole.profile.radii.clone()))
            .collect();
        found.sort_by_key(|(line, _, _)| line.at);
        found
    };
    let across = |x: i32| {
        (
            Line {
                axis: 2,
                at: [x, -10],
            },
            -10,
            technic_brick_hole(),
        )
    };
    assert_eq!(holes(&one_by_two), vec![across(0)]);
    assert_eq!(
        holes(&one_by_four),
        vec![across(-20), across(0), across(20)]
    );
    assert!(one_by_two.shaft.is_none());
    assert_eq!(technic_of(&library, "3001.dat"), None);
}

#[test]
fn a_bore_that_something_crosses_or_a_capped_hole_is_not_a_technic_hole() {
    let mut library = fixture_library();
    let brick = library.0["parts/3700.dat"].clone();
    let crossed = format!("{brick}4 16 -2 10 -2 2 10 -2 2 10 2 -2 10 2\n");
    let capped = format!("{brick}4 16 -20 0 12 20 0 12 20 24 12 -20 24 12\n");
    library.0.insert("parts/crossed.dat".into(), crossed);
    library.0.insert("parts/capped.dat".into(), capped);

    assert_eq!(technic_of(&library, "crossed.dat"), None);
    assert_eq!(technic_of(&library, "capped.dat"), None);
}

#[test]
fn an_axle_fits_the_bore_along_its_whole_length_while_friction_pin_halves_need_their_declared_seat()
{
    let library = fixture_library();
    let axle = technic_of(&library, "3705.dat")
        .and_then(|part| part.shaft)
        .expect("3705 is a shaft");
    let pin = technic_of(&library, "2780.dat")
        .and_then(|part| part.shaft)
        .expect("2780 is a shaft");

    assert_eq!(
        axle.line,
        Line {
            axis: 0,
            at: [0, 0]
        }
    );
    assert_eq!(axle.components.len(), 1);
    let body = &axle.components[0];
    assert_eq!(
        (body.pin, body.profile.from, body.profile.radii.len()),
        (None, -40, 80)
    );
    assert!(body.profile.radii.iter().all(|&r| r <= BORE));

    let mut halves: Vec<_> = pin
        .components
        .iter()
        .map(|c| (c.pin, c.profile.from, c.profile.radii.len()))
        .collect();
    halves.sort_by_key(|(_, from, _)| *from);
    assert_eq!(
        halves,
        vec![
            (
                Some(Pin {
                    origin: 0,
                    direction: -1
                }),
                -20,
                20
            ),
            (
                Some(Pin {
                    origin: 0,
                    direction: 1
                }),
                0,
                20
            ),
        ]
    );
    let inward = pin
        .components
        .iter()
        .find(|c| c.pin.is_some_and(|p| p.direction == 1))
        .expect("the +x half");
    assert_eq!(inward.profile.radii[..2], [COUNTERBORE, COUNTERBORE]);
    assert!(inward.profile.radii[2..].iter().any(|&r| r > BORE));
}

#[test]
fn circular_primitives_have_16_48_and_8_segments_on_the_unit_circle() {
    let library = fixture_library();
    for (primitive, segments) in [
        ("4-4cyli.dat", 16),
        ("48/4-4cyli.dat", 48),
        ("8/4-4cyli.dat", 8),
    ] {
        let compiled = compile_part(&library, primitive, &CompileOptions::default())
            .expect("the primitive compiles");
        let mut angles: Vec<i64> = Vec::new();
        for vertex in compiled.mesh.positions.as_chunks::<3>().0 {
            let [x, _, z] = vertex.map(f64::from);
            assert!(
                (x.hypot(z) - 1.0).abs() < 1e-4,
                "{primitive} vertex off the unit circle"
            );
            angles
                .push((z.atan2(x).to_degrees().rem_euclid(360.0) * 100.0).round() as i64 % 36_000);
        }
        angles.sort_unstable();
        angles.dedup();
        assert_eq!(angles.len(), segments, "{primitive}");
    }
}
