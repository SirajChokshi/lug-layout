use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use brick_compile::affine::Vec3;
use brick_compile::connect::{
    mating_faces, Caps, Connector, ConnectorExtractor, FaceSection, Gender, Issue, MatingFace,
    PrimitiveConnectors, PrimitiveTable, Section, SectionShape, ShadowSnaps, Shape, Source,
    Unreadable, CAP_FAR, CAP_ROOT, ROUND,
};
use brick_compile::ldraw::{parse, Line};
use brick_compile::Library;
use serde_json::{json, Value};

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

fn pinned(folder: &str) -> MemoryLibrary {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.cache")
        .join(folder);
    let mut files = HashMap::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect(
            "pinned inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`",
        ) {
            let path = entry.expect("readable entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let key = path
                .strip_prefix(&root)
                .expect("under root")
                .to_string_lossy()
                .replace('\\', "/")
                .to_lowercase();
            files.insert(
                key,
                String::from_utf8_lossy(&fs::read(&path).expect("readable file")).into_owned(),
            );
        }
    }
    MemoryLibrary(files)
}

fn table_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/asset-pipeline/primitive-connectors.json")
}

fn origin(connector: &Connector) -> Vec3 {
    let m = &connector.placement.m;
    [m[3], m[7], m[11]]
}

fn axis(connector: &Connector) -> Vec3 {
    let m = &connector.placement.m;
    [m[1], m[5], m[9]]
}

fn poses(connector: &Connector) -> Vec<Vec3> {
    connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets())
        .into_iter()
        .map(|offset| connector.placement.apply(offset).map(|v| v + 0.0))
        .collect()
}

fn round(radius: f64, length: f64) -> Section {
    Section {
        shape: SectionShape::Round,
        radius,
        length,
    }
}

fn summary(connector: &Connector) -> (Source, Gender, Vec<Section>, Vec3) {
    let Shape::Cylinder {
        gender, sections, ..
    } = &connector.shape
    else {
        panic!("only cylinders in this fixture");
    };
    (
        connector.source,
        *gender,
        sections.clone(),
        origin(connector),
    )
}

const IDENTIFY_LDU: f64 = 0.0005;
const TOWARD_PLUS_Z: &str = "1 0 0 0 0 -1 0 1 0";
const TOWARD_MINUS_Z: &str = "1 0 0 0 0 1 0 -1 0";
const BORE_ALONG_Z: &str = "6 0 0 0 0 -6 0 16 0";

#[test]
fn lower_tiers_fill_only_empty_slots_and_never_slots_a_clear_wiped() {
    let part = format!(
        "0 Part\n\
         1 16 0 0 0 1 0 0 0 1 0 0 0 1 pin.dat\n\
         1 16 40 0 0 1 0 0 0 1 0 0 0 1 pin.dat\n\
         1 16 80 0 0 1 0 0 0 1 0 0 0 1 tube.dat\n\
         1 16 0 0 80 1 0 0 0 1 0 0 0 1 old.dat\n\
         1 16 0 0 -10 {TOWARD_PLUS_Z} end.dat\n\
         1 16 0 0 10 {TOWARD_MINUS_Z} end.dat\n\
         1 16 0 0 -8 {BORE_ALONG_Z} 4-4cyli.dat\n"
    );
    let library = memory(&[
        ("parts/part.dat", &part),
        ("p/pin.dat", "0 Pin\n"),
        ("p/tube.dat", "0 Tube\n"),
        ("p/old.dat", "0 Old\n"),
        ("p/end.dat", "0 End\n"),
        ("p/4-4cyli.dat", "0 Cylinder 1.0\n"),
    ]);
    let shadow = memory(&[
        (
            "parts/part.dat",
            "0 !LDCAD SNAP_CLEAR\n0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 4 6] [pos=40 0 0]\n",
        ),
        ("p/tube.dat", "0 //!LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 4]\n"),
        ("p/old.dat", "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 4 4]\n"),
    ]);
    let table = PrimitiveTable::from_json(&json!({
        "primitives": [
            { "file": "p/pin.dat", "snaps": ["SNAP_CYL [gender=M] [caps=one] [secs=R 4 4]"] },
            { "file": "p/tube.dat", "snaps": ["SNAP_CYL [gender=F] [caps=one] [secs=R 6 4]"] },
            { "file": "p/old.dat", "snaps": ["SNAP_CYL [gender=M] [caps=one] [secs=R 4 4]"] },
            { "file": "p/end.dat", "holeEnd": { "counterbore": { "radius": 8, "length": 2 }, "boreRadius": 6 } }
        ]
    }))
    .expect("table parses");
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, table),
    );
    let extraction = extractor.extract("parts/part.dat");
    assert!(extraction.curated);
    let mut found: Vec<_> = extraction.connectors.iter().map(summary).collect();
    found.sort_by(|a, b| {
        (a.3, a.0, a.1)
            .partial_cmp(&(b.3, b.0, b.1))
            .expect("finite")
    });
    assert_eq!(
        found,
        vec![
            (
                Source::Primitive,
                Gender::Male,
                vec![round(4.0, 4.0)],
                [0.0, 0.0, 0.0]
            ),
            (
                Source::Primitive,
                Gender::Female,
                vec![round(8.0, 2.0), round(6.0, 16.0), round(8.0, 2.0)],
                [0.0, 0.0, 0.0]
            ),
            (
                Source::Shadow,
                Gender::Male,
                vec![round(4.0, 6.0)],
                [40.0, 0.0, 0.0]
            ),
            (
                Source::Primitive,
                Gender::Female,
                vec![round(6.0, 4.0)],
                [80.0, 0.0, 0.0]
            ),
        ]
    );
    assert!(matches!(
        extraction.issues.as_slice(),
        [Issue::SectionDisagreement {
            kept: (Source::Shadow, _),
            lower: (Source::Primitive, _),
            ..
        }]
    ));
    let hole = extraction
        .connectors
        .iter()
        .find(|c| {
            matches!(
                c.shape,
                Shape::Cylinder {
                    gender: Gender::Female,
                    caps: Caps::None,
                    ..
                }
            )
        })
        .expect("a through hole");
    assert_eq!(axis(hole).map(f64::abs), [0.0, 0.0, 1.0]);
    assert!(matches!(
        hole.shape,
        Shape::Cylinder {
            caps: Caps::None,
            center: true,
            slide: true,
            ..
        }
    ));
}

#[test]
fn hole_ends_become_a_hole_only_with_a_partner_and_a_drawn_bore() {
    let table = || {
        PrimitiveTable::from_json(&json!({
            "primitives": [
                { "file": "p/end.dat", "holeEnd": { "counterbore": { "radius": 8, "length": 2 }, "boreRadius": 6 } }
            ]
        }))
        .expect("table parses")
    };
    let lone = format!("0 Part\n1 16 0 0 -10 {TOWARD_PLUS_Z} end.dat\n");
    let undrawn = format!(
        "0 Part\n1 16 0 0 -10 {TOWARD_PLUS_Z} end.dat\n1 16 0 0 10 {TOWARD_MINUS_Z} end.dat\n"
    );
    for (part, expected) in [(lone, "unpaired"), (undrawn, "undrawn")] {
        let library = memory(&[("parts/part.dat", &part), ("p/end.dat", "0 End\n")]);
        let (connectors, issues) =
            PrimitiveConnectors::new(&library, table()).connectors("parts/part.dat");
        assert!(connectors.is_empty(), "{expected}");
        let reported = match issues.as_slice() {
            [Issue::UnpairedHoleEnd { .. }] => "unpaired",
            [Issue::UndrawnHoleInterior { .. }] => "undrawn",
            other => panic!("{other:?}"),
        };
        assert_eq!(reported, expected);
    }
}

#[test]
fn a_shadow_grid_steps_along_the_snaps_own_axes_after_its_orientation() {
    let library = memory(&[("parts/part.dat", "0 Part\n")]);
    let shadow = memory(&[(
        "parts/part.dat",
        "0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 4] [pos=-30 0 10] [ori=0 -1 0 1 0 0 0 0 1] [grid=2 1 40 0]\n",
    )]);
    let extraction = ShadowSnaps::new(&library, &shadow).snaps("parts/part.dat");
    let mut found: Vec<Vec3> = extraction.connectors.iter().flat_map(poses).collect();
    found.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    assert_eq!(found, vec![[-30.0, -40.0, -10.0], [-30.0, 0.0, -10.0]]);
}

#[test]
fn plate_two_by_four_bakes_studs_up_and_receptors_up_into_the_body() {
    let library = pinned("ldraw");
    let shadow = pinned("ldcad-shadow");
    let extraction = ShadowSnaps::new(&library, &shadow).snaps("parts/3020.dat");
    assert!(extraction.curated);
    assert!(extraction.issues.is_empty(), "{:?}", extraction.issues);
    let mut studs = Vec::new();
    let mut receptors = Vec::new();
    for connector in &extraction.connectors {
        let Shape::Cylinder {
            gender, sections, ..
        } = &connector.shape
        else {
            panic!("3020 has only cylinder snaps");
        };
        assert_eq!(sections, &vec![round(6.0, 4.0)]);
        assert_eq!(axis(connector), [0.0, 1.0, 0.0]);
        match gender {
            Gender::Male => studs.extend(poses(connector)),
            Gender::Female => receptors.extend(poses(connector)),
        }
    }
    let grid = |y: f64| -> Vec<Vec3> {
        let mut out: Vec<Vec3> = [-30.0, -10.0, 10.0, 30.0]
            .iter()
            .flat_map(|&x| [-10.0, 10.0].map(|z| [x, y, z]))
            .collect();
        out.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
        out
    };
    studs.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    receptors.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    assert_eq!(studs, grid(0.0));
    assert_eq!(receptors, grid(-8.0));
}

fn subfiles(library: &MemoryLibrary, path: &str) -> Vec<(String, [f64; 12])> {
    parse(library.source(path).expect("pinned primitive"))
        .lines
        .into_iter()
        .filter_map(|line| match line {
            Line::Subfile {
                matrix, reference, ..
            } => Some((reference, matrix.m)),
            _ => None,
        })
        .collect()
}

fn ring_radii(library: &MemoryLibrary, reference: &str) -> (f64, f64) {
    let source = library
        .source(&format!("p/{reference}"))
        .expect("pinned ring primitive");
    let radii: Vec<f64> = parse(source)
        .lines
        .into_iter()
        .filter_map(|line| match line {
            Line::Quad { points, .. } => Some(points.to_vec()),
            Line::Triangle { points, .. } => Some(points.to_vec()),
            _ => None,
        })
        .flatten()
        .map(|p| p[0].hypot(p[2]))
        .collect();
    (
        radii.iter().copied().fold(f64::INFINITY, f64::min),
        radii.iter().copied().fold(0.0, f64::max),
    )
}

#[test]
fn the_primitive_table_matches_the_pinned_primitive_geometry() {
    let library = pinned("ldraw");
    let table: Value =
        serde_json::from_slice(&fs::read(table_path()).expect("table file")).expect("table json");
    PrimitiveTable::from_json(&table).expect("the shipped table parses");
    let entries = table["primitives"].as_array().expect("entries");
    assert!(!entries.is_empty());
    for entry in entries {
        let file = entry["file"].as_str().expect("file");
        let lines = subfiles(&library, file);
        let cylinder = |radius: f64, from: f64, to: f64| {
            lines.iter().any(|(reference, m)| {
                reference == "4-4cyli.dat"
                    && m[0].hypot(m[8]) == radius
                    && (m[7].min(m[7] + m[5]), m[7].max(m[7] + m[5])) == (from, to)
            })
        };
        if let Some(snaps) = entry["snaps"].as_array() {
            for snap in snaps {
                let line = format!("0 !LDCAD {}", snap.as_str().expect("snap text"));
                let parsed = brick_compile::connect::parse_metas(&line);
                let Ok(brick_compile::connect::ParsedMeta {
                    meta: brick_compile::connect::Meta::Snap(connector),
                    ..
                }) = &parsed[0]
                else {
                    panic!("{file}: snap descriptor");
                };
                let Shape::Cylinder { sections, caps, .. } = &connector.shape else {
                    panic!("{file}: cylinder descriptor");
                };
                let mut depth = 0.0;
                for section in sections {
                    assert!(
                        cylinder(section.radius, -(depth + section.length), -depth),
                        "{file}: no cylinder of radius {} from {} to {}",
                        section.radius,
                        -depth,
                        -(depth + section.length)
                    );
                    depth += section.length;
                }
                if *caps == Caps::One {
                    let last = sections.last().expect("a section").radius;
                    assert!(
                        lines.iter().any(|(reference, m)| reference == "4-4disc.dat"
                            && m[7] == -depth
                            && m[0] == last),
                        "{file}: no closing disc at {}",
                        -depth
                    );
                }
            }
        }
        let hole = &entry["holeEnd"];
        if hole.is_object() {
            let counterbore = hole["counterbore"]["radius"].as_f64().expect("radius");
            let length = hole["counterbore"]["length"].as_f64().expect("length");
            let bore = hole["boreRadius"].as_f64().expect("bore");
            assert!(cylinder(counterbore, 0.0, length), "{file}: counterbore");
            let step = lines
                .iter()
                .find(|(reference, m)| reference.contains("ring") && m[7] == length)
                .expect("a ring at the counterbore floor");
            let (inner, outer) = ring_radii(&library, &step.0);
            assert!(
                (inner * step.1[0] - bore).abs() <= IDENTIFY_LDU
                    && (outer * step.1[0] - counterbore).abs() <= IDENTIFY_LDU,
                "{file}: step ring spans {} to {}",
                inner * step.1[0],
                outer * step.1[0]
            );
        }
    }
}

fn faces_of(connectors: &[Connector]) -> Vec<MatingFace> {
    connectors
        .iter()
        .flat_map(|c| mating_faces(c).expect("a readable snap"))
        .collect()
}

#[test]
fn a_stud_is_attached_only_at_its_root_so_a_deep_blind_receptor_takes_it() {
    let library = pinned("ldraw");
    let shadow = pinned("ldcad-shadow");
    let mut snaps = ShadowSnaps::new(&library, &shadow);
    let plate = faces_of(&snaps.snaps("parts/3020.dat").connectors);
    let brick = faces_of(&snaps.snaps("parts/3003.dat").connectors);
    let stud = plate
        .iter()
        .find(|f| f.gender == Gender::Male)
        .expect("3020 has studs");
    let receptor = brick
        .iter()
        .find(|f| {
            f.gender == Gender::Female
                && f.sections
                    == vec![FaceSection {
                        code: ROUND,
                        size: 6.0,
                        length: 20.0,
                    }]
        })
        .expect("3003 has 20 LDU deep round receptors");
    assert_eq!(stud.caps, CAP_ROOT);
    assert_eq!(
        stud.sections,
        vec![FaceSection {
            code: ROUND,
            size: 6.0,
            length: 4.0
        }]
    );
    assert_eq!((stud.axis, stud.origin[1]), ([0.0, 1.0, 0.0], 0.0));
    assert_eq!(receptor.caps, CAP_FAR);
    assert_eq!(
        (receptor.axis, receptor.origin[1]),
        ([0.0, -1.0, 0.0], -24.0)
    );
}

type FaceSummary = (Vec3, Vec3, u8, Vec<f64>);

#[test]
fn caps_read_as_attached_male_ends_and_blind_female_ends() {
    let cases: [(&str, Vec<FaceSummary>); 7] = [
        (
            "[gender=M] [caps=one] [secs=R 6 4]",
            vec![([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], CAP_ROOT, vec![4.0])],
        ),
        (
            "[gender=M] [caps=B] [secs=R 4.5 2   R 4 15.5]",
            vec![(
                [0.0, 17.5, 0.0],
                [0.0, -1.0, 0.0],
                CAP_ROOT,
                vec![15.5, 2.0],
            )],
        ),
        (
            "[gender=M] [caps=two] [secs=R 4 8] [center=true]",
            vec![(
                [0.0, -4.0, 0.0],
                [0.0, 1.0, 0.0],
                CAP_ROOT | CAP_FAR,
                vec![8.0],
            )],
        ),
        (
            "[gender=F] [caps=one] [secs=R 6 4]",
            vec![([0.0, 0.0, 0.0], [0.0, -1.0, 0.0], CAP_FAR, vec![4.0])],
        ),
        (
            "[gender=F] [caps=A] [secs=R 6 4]",
            vec![([0.0, 4.0, 0.0], [0.0, 1.0, 0.0], CAP_FAR, vec![4.0])],
        ),
        (
            "[gender=F] [caps=none] [secs=R 8 2   R 6 16   R 8 4] [center=true]",
            vec![
                ([0.0, -11.0, 0.0], [0.0, -1.0, 0.0], 0, vec![2.0, 16.0, 4.0]),
                ([0.0, 11.0, 0.0], [0.0, 1.0, 0.0], 0, vec![4.0, 16.0, 2.0]),
            ],
        ),
        (
            "[radius=4] [length=8] [center=true]",
            vec![
                ([0.0, -4.0, 0.0], [0.0, -1.0, 0.0], 0, vec![8.0]),
                ([0.0, 4.0, 0.0], [0.0, 1.0, 0.0], 0, vec![8.0]),
            ],
        ),
    ];
    for (descriptor, expected) in cases {
        let kind = if descriptor.starts_with("[radius") {
            "SNAP_CLP"
        } else {
            "SNAP_CYL"
        };
        let library = memory(&[("parts/part.dat", "0 Part\n")]);
        let text = format!("0 !LDCAD {kind} {descriptor}\n");
        let shadow = memory(&[("parts/part.dat", &text)]);
        let connectors = ShadowSnaps::new(&library, &shadow)
            .snaps("parts/part.dat")
            .connectors;
        let found: Vec<FaceSummary> = faces_of(&connectors)
            .into_iter()
            .map(|f| {
                (
                    f.origin,
                    f.axis,
                    f.caps,
                    f.sections.iter().map(|s| s.length).collect(),
                )
            })
            .collect();
        assert_eq!(found, expected, "{descriptor}");
    }
    for (kind, descriptor, unreadable) in [
        (
            "SNAP_CYL",
            "[gender=F] [caps=two] [secs=R 6 4]",
            Unreadable::ClosedAtBothEnds,
        ),
        (
            "SNAP_FGR",
            "[genderOfs=M] [seq=4 4 4] [radius=4]",
            Unreadable::FingerHinge,
        ),
        (
            "SNAP_GEN",
            "[gender=M] [bounding=sph 8]",
            Unreadable::Generic,
        ),
    ] {
        let library = memory(&[("parts/part.dat", "0 Part\n")]);
        let text = format!("0 !LDCAD {kind} {descriptor}\n");
        let shadow = memory(&[("parts/part.dat", &text)]);
        let connectors = ShadowSnaps::new(&library, &shadow)
            .snaps("parts/part.dat")
            .connectors;
        assert_eq!(
            mating_faces(&connectors[0]),
            Err(unreadable),
            "{descriptor}"
        );
    }
}
