use std::collections::HashMap;
use std::fs;
use std::path::Path;

use brick_compile::license::LicenseVerdict;
use brick_compile::{compile_part, CompileError, CompileOptions, Library};

struct MemoryLibrary(HashMap<String, String>);

impl Library for MemoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }
}

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

fn fixture_library() -> MemoryLibrary {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cache/ldraw");
    let mut files = HashMap::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)
            .expect("pinned LDraw inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`")
        {
            let path = entry.expect("fixture entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let key = path
                .strip_prefix(&root)
                .expect("fixture under root")
                .to_string_lossy()
                .replace('\\', "/")
                .to_lowercase();
            let bytes = fs::read(&path).expect("fixture file is readable");
            files.insert(key, String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    MemoryLibrary(files)
}

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

#[test]
fn technic_brick_hole_ends_are_recorded_facing_into_the_part_and_still_meshed() {
    let library = fixture_library();
    let with_holes = CompileOptions {
        technic_hole_primitives: vec!["peghole.dat".to_string()],
        ..CompileOptions::default()
    };
    let brick = compile_part(&library, "3701.dat", &with_holes).expect("3701 compiles");
    let plain = compile_part(&library, "3701.dat", &CompileOptions::default()).expect("3701");
    assert_eq!(brick.mesh, plain.mesh);
    assert!(plain.technic_holes.is_empty());

    let mut mouths: Vec<(i64, i64, i64)> = Vec::new();
    for hole in &brick.technic_holes {
        let m = hole.matrix.m;
        let position = [m[3], m[7], m[11]];
        let inward = [-m[1], -m[5], -m[9]];
        let length = inward.iter().map(|v| v * v).sum::<f64>().sqrt();
        assert!((length - 1.0).abs() < 1e-9);
        assert!(inward[2] * -position[2] > 0.0);
        assert_eq!((inward[0], inward[1]), (0.0, 0.0));
        mouths.push((
            position[0].round() as i64,
            position[1].round() as i64,
            position[2].round() as i64,
        ));
    }
    mouths.sort_unstable();
    let mut expected: Vec<(i64, i64, i64)> = [-20, 0, 20]
        .iter()
        .flat_map(|&x| [(x, -10, -10), (x, -10, 10)])
        .collect();
    expected.sort_unstable();
    assert_eq!(mouths, expected);
}
