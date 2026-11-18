mod common;

use std::cell::RefCell;
use std::collections::BTreeSet;

use brick_compile::flatten::FlattenError;
use brick_compile::license::LicenseVerdict;
use brick_compile::{compile_part, CompileError, CompileOptions, Library};
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
