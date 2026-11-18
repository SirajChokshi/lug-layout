use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use brick_compile::affine::Vec3;
use brick_compile::bands::{end_faces, outward_round_bands};
use brick_compile::connect::{
    mating_faces, Caps, Connector, ConnectorExtractor, FaceSection, Gender, InferredFeatures,
    Issue, MatingFace, PrimitiveConnectors, PrimitiveTable, Section, SectionShape,
    SectionVocabulary, ShadowPatches, ShadowSnaps, Shape, Source, Status, Uninferred, Unreadable,
    CAP_FAR, CAP_ROOT, FLARE_JOINS_NEXT, FLARE_JOINS_PREVIOUS, ROUND, SQUARE,
};
use brick_compile::flatten::{Flattener, Lod};
use brick_compile::ldraw::{parse, Line};
use brick_compile::technic::is_circular_primitive;
use brick_compile::Library;
use serde_json::{json, Value};
use std::collections::HashSet;

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

fn pinned_file(path: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.cache/ldraw")
            .join(path),
    )
    .expect("pinned inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`")
}

fn stud_probe() -> [(&'static str, String); 2] {
    [
        (
            "p/probe.dat",
            "0 Probe\n0 BFC CERTIFY CCW\n1 16 0 0 0 6 0 0 0 -4 0 0 0 6 probe-wall.dat\n"
                .to_string(),
        ),
        ("p/probe-wall.dat", pinned_file("p/4-4cyli.dat")),
    ]
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
    let [probe, probe_wall] = stud_probe();
    let library = memory(&[
        ("parts/part.dat", &part),
        ("p/pin.dat", "0 Pin\n"),
        ("p/tube.dat", "0 Tube\n"),
        ("p/old.dat", "0 Old\n"),
        ("p/end.dat", "0 End\n"),
        ("p/4-4cyli.dat", "0 Cylinder 1.0\n"),
        (probe.0, &probe.1),
        (probe_wall.0, &probe_wall.1),
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
    let vocabulary =
        SectionVocabulary::from_metas(["0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 4]"]);
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, table),
        InferredFeatures::new(&library, vocabulary, "p/probe.dat").expect("the probe measures"),
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
        if let Some(snaps) = entry["whereOpen"].as_array() {
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
                let Shape::Cylinder { sections, .. } = &connector.shape else {
                    panic!("{file}: cylinder descriptor");
                };
                let rim = connector.placement.m[7];
                let reach: f64 = sections.iter().map(|s| s.length).sum();
                let walls: Vec<f64> = lines
                    .iter()
                    .filter(|(reference, m)| {
                        reference == "4-4cyli.dat"
                            && (m[7].min(m[7] + m[5]), m[7].max(m[7] + m[5])) == (rim, rim + reach)
                    })
                    .map(|(_, m)| m[0].hypot(m[8]))
                    .collect();
                let outer = walls.iter().copied().fold(0.0, f64::max);
                let grid = connector.grid.expect("a neighbour grid");
                for offset in grid.offsets() {
                    let apart = offset[0].hypot(offset[2]);
                    assert!(
                        apart - outer >= sections[0].radius,
                        "{file}: a receptor at {offset:?} cuts the radius-{outer} wall"
                    );
                }
                assert!(
                    walls.len() >= 2,
                    "{file}: a tube wall spans the receptor's run"
                );
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
fn flare_codes_name_their_partner_in_face_order() {
    for descriptor in [
        "[gender=M] [caps=one] [secs=R 6 16   _L 6.25 2]",
        "[gender=M] [caps=B] [secs=R 6 16   _L 6.25 2]",
        "[gender=F] [caps=none] [secs=L_ 6.5 2   R 6 16   _L 6.5 2]",
    ] {
        let library = memory(&[("parts/part.dat", "0 Part\n")]);
        let text = format!("0 !LDCAD SNAP_CYL {descriptor}\n");
        let shadow = memory(&[("parts/part.dat", &text)]);
        let connectors = ShadowSnaps::new(&library, &shadow)
            .snaps("parts/part.dat")
            .connectors;
        let faces = faces_of(&connectors);
        assert!(!faces.is_empty(), "{descriptor}");
        for face in faces {
            let codes: Vec<u8> = face.sections.iter().map(|s| s.code).collect();
            for (i, &code) in codes.iter().enumerate() {
                let partner = match code {
                    FLARE_JOINS_PREVIOUS => i.checked_sub(1),
                    FLARE_JOINS_NEXT => Some(i + 1),
                    _ => continue,
                };
                assert_eq!(
                    partner.and_then(|p| codes.get(p)),
                    Some(&ROUND),
                    "{descriptor}: {codes:?}"
                );
            }
        }
    }
}

#[test]
fn caps_read_as_attached_male_ends_and_blind_female_ends() {
    let cases: [(&str, Vec<FaceSummary>); 8] = [
        (
            "[gender=M] [caps=one] [secs=R 6 4]",
            vec![([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], CAP_ROOT, vec![4.0])],
        ),
        (
            "[gender=M] [caps=none] [secs=R 6 4   R 8 2]",
            vec![
                ([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], 0, vec![4.0, 2.0]),
                ([0.0, 6.0, 0.0], [0.0, -1.0, 0.0], 0, vec![2.0, 4.0]),
            ],
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

fn custom_plate(columns: i32, rows: i32, hollow: &[(i32, i32)]) -> String {
    let (w, d) = (10 * columns, 10 * rows);
    let (wi, di) = (w - 4, d - 4);
    let mut text = String::from("0 Custom Plate\n0 BFC CERTIFY CCW\n");
    let interior = |count: i32, half: i32| (1..count).map(move |k| -half + 20 * k);
    let supports: Vec<(i32, i32, &str)> = if rows == 1 {
        interior(columns, w).map(|x| (x, 0, "stud3.dat")).collect()
    } else {
        interior(columns, w)
            .flat_map(|x| interior(rows, d).map(move |z| (x, z, "stud4.dat")))
            .collect()
    };
    for (x, z, support) in supports {
        text += &format!("1 16 {x} 4 {z} 1 0 0 0 -1 0 0 0 1 {support}\n");
    }
    text += &format!("0 BFC INVERTNEXT\n1 16 0 8 0 {wi} 0 0 0 -4 0 0 0 {di} box5.dat\n");
    text += &format!("4 16 {w} 8 {d} {wi} 8 {di} -{wi} 8 {di} -{w} 8 {d}\n");
    text += &format!("4 16 -{w} 8 -{d} -{wi} 8 -{di} {wi} 8 -{di} {w} 8 -{d}\n");
    text += &format!("4 16 {w} 8 -{d} {wi} 8 -{di} {wi} 8 {di} {w} 8 {d}\n");
    text += &format!("4 16 -{w} 8 {d} -{wi} 8 {di} -{wi} 8 -{di} -{w} 8 -{d}\n");
    text += &format!("1 16 0 8 0 {w} 0 0 0 -8 0 0 0 {d} box5.dat\n");
    for i in 0..columns {
        for j in 0..rows {
            let (x, z) = (-w + 10 + 20 * i, -d + 10 + 20 * j);
            let stud = if hollow.contains(&(x, z)) {
                "stud2.dat"
            } else {
                "stud.dat"
            };
            text += &format!("1 16 {x} 0 {z} 1 0 0 0 1 0 0 0 1 {stud}\n");
        }
    }
    text
}

fn custom_pockets(count: i32, half_length: f64) -> String {
    let (w, d) = (10 * count, 10);
    let mut text = String::from("0 Custom Pockets\n0 BFC CERTIFY CCW\n");
    text += &format!("1 16 0 8 0 {w} 0 0 0 -8 0 0 0 {d} box5.dat\n");
    let centres: Vec<f64> = (0..count).map(|k| f64::from(-w + 10 + 20 * k)).collect();
    let mut xs = vec![f64::from(-w)];
    for &c in &centres {
        text +=
            &format!("0 BFC INVERTNEXT\n1 16 {c} 8 0 {half_length} 0 0 0 -4 0 0 0 6 box5.dat\n");
        xs.extend([c - half_length, c + half_length]);
    }
    xs.push(f64::from(w));
    let zs = [-10.0, -6.0, 6.0, 10.0];
    for a in 0..xs.len() - 1 {
        for b in 0..zs.len() - 1 {
            if a % 2 == 1 && b == 1 {
                continue;
            }
            let (x0, x1, z0, z1) = (xs[a], xs[a + 1], zs[b], zs[b + 1]);
            text += &format!("4 16 {x1} 8 {z1} {x1} 8 {z0} {x0} 8 {z0} {x0} 8 {z1}\n");
        }
    }
    text
}

fn with_parts(base: MemoryLibrary, parts: &[(&str, String)]) -> MemoryLibrary {
    let mut files = base.0;
    for (path, text) in parts {
        files.insert(path.to_string(), text.clone());
    }
    MemoryLibrary(files)
}

fn shadow_vocabulary(shadow: &MemoryLibrary) -> SectionVocabulary {
    SectionVocabulary::from_metas(shadow.0.values().map(String::as_str))
}

type FaceKey = (Gender, [i64; 3], [i64; 3], Vec<(u8, i64, i64)>);

fn face_keys(connectors: &[Connector]) -> Vec<FaceKey> {
    let sixteenths = |v: f64| (v * 16.0).round() as i64;
    let mut keys: Vec<FaceKey> = faces_of(connectors)
        .into_iter()
        .map(|f| {
            (
                f.gender,
                f.origin.map(sixteenths),
                f.axis.map(|c| c.round() as i64),
                f.sections
                    .iter()
                    .map(|s| (s.code, sixteenths(s.size), sixteenths(s.length)))
                    .collect(),
            )
        })
        .collect();
    keys.sort();
    keys
}

fn round_face(gender: Gender, origin: [f64; 3], axis_y: i64, radius: f64, length: f64) -> FaceKey {
    (
        gender,
        origin.map(|v| (v * 16.0).round() as i64),
        [0, axis_y, 0],
        vec![(ROUND, (radius * 16.0) as i64, (length * 16.0) as i64)],
    )
}

#[test]
fn a_custom_plate_gets_its_studs_tube_interiors_and_hollow_stud_bore_and_reports_tube_gap_cavities()
{
    let hollow = (-30, -30);
    let library = with_parts(
        pinned("ldraw"),
        &[("parts/custom.dat", custom_plate(4, 4, &[hollow]))],
    );
    let shadow = pinned("ldcad-shadow");
    let mut inferred = InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
        .expect("the pinned stud measures");
    let inference = inferred.infer("parts/custom.dat");
    assert!(inference.off_lattice.is_empty());
    assert!(inference
        .connectors
        .iter()
        .all(|c| c.source == Source::Inferred));
    let lattice = [-30.0, -10.0, 10.0, 30.0];
    let mut expected = Vec::new();
    for &x in &lattice {
        for &z in &lattice {
            expected.push(round_face(Gender::Male, [x, 0.0, -z], 1, 6.0, 4.0));
        }
    }
    for x in [-20.0, 0.0, 20.0] {
        for z in [-20.0, 0.0, 20.0] {
            expected.push(round_face(Gender::Female, [x, -8.0, -z], -1, 6.0, 4.0));
        }
    }
    expected.push(round_face(
        Gender::Female,
        [f64::from(hollow.0), 4.0, -f64::from(hollow.1)],
        1,
        4.0,
        4.0,
    ));
    expected.sort();
    assert_eq!(face_keys(&inference.connectors), expected);
    let gap = 200f64.sqrt() - 8.0 - 6.0;
    let mut loose: Vec<[f64; 3]> = inference
        .issues
        .iter()
        .filter_map(|issue| match issue {
            Issue::Uninferred {
                origin,
                reason: Uninferred::LooseCavity { clearance },
            } => {
                assert!((clearance - gap).abs() <= 1e-9, "{clearance}");
                Some(*origin)
            }
            _ => None,
        })
        .collect();
    loose.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    assert_eq!(
        loose,
        vec![
            [-10.0, 8.0, -10.0],
            [-10.0, 8.0, 10.0],
            [10.0, 8.0, -10.0],
            [10.0, 8.0, 10.0]
        ]
    );
    let to_tube = 10.0 - (14f64.powi(2) - 10f64.powi(2)).sqrt();
    let mut against_walls: Vec<[f64; 3]> = inference
        .issues
        .iter()
        .filter_map(|issue| match issue {
            Issue::Uninferred {
                origin,
                reason: Uninferred::OffCentreCavity { offset },
            } => {
                assert!((offset - to_tube / 2.0).abs() <= 1e-4, "{offset}");
                Some(*origin)
            }
            _ => None,
        })
        .collect();
    against_walls.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let mut walls = Vec::new();
    for &x in &lattice {
        for &z in &lattice {
            if x.abs() == 30.0 || z.abs() == 30.0 {
                walls.push([x, 8.0, z]);
            }
        }
    }
    assert_eq!(against_walls, walls);
}

#[test]
fn inferred_connectors_fill_only_empty_slots_and_never_a_slot_a_clear_wiped() {
    let mut plate = custom_plate(3, 1, &[]);
    plate += "1 16 0 0 0 1 0 0 0 1 0 0 0 1 s/marker.dat\n";
    let library = with_parts(
        pinned("ldraw"),
        &[
            ("parts/custom.dat", plate),
            ("parts/s/marker.dat", "0 Marker\n".to_string()),
        ],
    );
    let shadow = with_parts(
        pinned("ldcad-shadow"),
        &[
            (
                "parts/s/marker.dat",
                "0 !LDCAD SNAP_CYL [id=gone] [gender=F] [caps=one] [secs=R 6 4] [pos=-20 8 0]\n"
                    .to_string(),
            ),
            (
                "parts/custom.dat",
                "0 !LDCAD SNAP_CLEAR [id=gone]\n0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=S 6 4] [pos=20 8 0]\n"
                    .to_string(),
            ),
        ],
    );
    let table =
        PrimitiveTable::from_json(&json!({ "primitives": [] })).expect("an empty table parses");
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, table),
        InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
            .expect("the pinned stud measures"),
    );
    let extraction = extractor.extract("parts/custom.dat");
    let receptors: Vec<(Source, [f64; 3], u8)> = faces_of(&extraction.connectors)
        .into_iter()
        .filter(|f| f.gender == Gender::Female)
        .map(|f| (f.source, f.origin, f.sections[0].code))
        .collect();
    let at = |origin: [f64; 3]| -> Vec<(Source, u8)> {
        receptors
            .iter()
            .filter(|r| r.1 == origin)
            .map(|r| (r.0, r.2))
            .collect()
    };
    assert_eq!(at([20.0, -8.0, 0.0]), vec![(Source::Shadow, SQUARE)]);
    assert_eq!(at([-20.0, -8.0, 0.0]), vec![]);
    assert_eq!(at([0.0, -8.0, 0.0]), vec![(Source::Inferred, ROUND)]);
    assert_eq!(receptors.len(), 2);
    let males: Vec<Source> = faces_of(&extraction.connectors)
        .into_iter()
        .filter(|f| f.gender == Gender::Male)
        .map(|f| f.source)
        .collect();
    assert_eq!(males, vec![Source::Shadow; 5]);
    assert!(extraction.issues.iter().any(|issue| matches!(
        issue,
        Issue::SectionDisagreement {
            kept: (Source::Shadow, _),
            lower: (Source::Inferred, _),
            ..
        }
    )));
}

#[test]
fn inferred_origins_identify_to_sixteenths_or_stay_off_lattice_and_reported() {
    let plate = custom_plate(1, 1, &[]);
    let library = with_parts(
        pinned("ldraw"),
        &[
            ("parts/custom.dat", plate),
            (
                "parts/sixteenth.dat",
                "0 Shifted\n0 BFC CERTIFY CCW\n1 16 0.0625 0 0 1 0 0 0 1 0 0 0 1 custom.dat\n"
                    .to_string(),
            ),
            (
                "parts/dusty.dat",
                "0 Shifted\n0 BFC CERTIFY CCW\n1 16 0.03 0 0 1 0 0 0 1 0 0 0 1 custom.dat\n"
                    .to_string(),
            ),
        ],
    );
    let shadow = pinned("ldcad-shadow");
    let mut inferred = InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
        .expect("the pinned stud measures");
    let on_grid = inferred.infer("parts/sixteenth.dat");
    let males: Vec<[f64; 3]> = faces_of(&on_grid.connectors)
        .into_iter()
        .filter(|f| f.gender == Gender::Male)
        .map(|f| f.origin)
        .collect();
    assert_eq!(males, vec![[0.0625, 0.0, 0.0]]);
    assert!(on_grid.off_lattice.is_empty());
    let dusty = inferred.infer("parts/dusty.dat");
    assert!(faces_of(&dusty.connectors)
        .iter()
        .all(|f| f.gender != Gender::Male));
    let stranded: Vec<[f64; 3]> = faces_of(&dusty.off_lattice)
        .into_iter()
        .map(|f| f.origin)
        .collect();
    assert_eq!(stranded, vec![[0.03, 0.0, 0.0]]);
    assert!(dusty.issues.iter().any(|issue| matches!(
        issue,
        Issue::Uninferred {
            reason: Uninferred::UnidentifiedOrigin,
            ..
        }
    )));
}

#[test]
fn a_cavity_is_placed_only_where_its_free_travel_centres_the_stud_on_the_grid_point() {
    let shift = 0.0625;
    let library = with_parts(
        pinned("ldraw"),
        &[
            ("parts/pockets.dat", custom_pockets(3, 6.2)),
            (
                "parts/shifted.dat",
                format!(
                    "0 Shifted\n0 BFC CERTIFY CCW\n1 16 {shift} 0 0 1 0 0 0 1 0 0 0 1 pockets.dat\n"
                ),
            ),
        ],
    );
    let shadow = pinned("ldcad-shadow");
    let mut inferred = InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
        .expect("the pinned stud measures");
    let receptors = |connectors: &[Connector]| -> Vec<[f64; 3]> {
        let mut found: Vec<[f64; 3]> = faces_of(connectors)
            .into_iter()
            .filter(|f| f.gender == Gender::Female)
            .map(|f| f.origin)
            .collect();
        found.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
        found
    };
    let centred = inferred.infer("parts/pockets.dat");
    assert_eq!(
        receptors(&centred.connectors),
        vec![[-20.0, -8.0, 0.0], [0.0, -8.0, 0.0], [20.0, -8.0, 0.0]]
    );
    let shifted = inferred.infer("parts/shifted.dat");
    assert_eq!(receptors(&shifted.connectors), Vec::<[f64; 3]>::new());
    let mut off_centre: Vec<[f64; 3]> = shifted
        .issues
        .iter()
        .filter_map(|issue| match issue {
            Issue::Uninferred {
                origin,
                reason: Uninferred::OffCentreCavity { offset },
            } => {
                assert!((offset - shift).abs() <= 1e-4, "{offset}");
                Some(*origin)
            }
            _ => None,
        })
        .collect();
    off_centre.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    assert_eq!(
        off_centre,
        vec![[-20.0, 8.0, 0.0], [0.0, 8.0, 0.0], [20.0, 8.0, 0.0]]
    );
}

fn female_faces(connectors: &[Connector]) -> Vec<MatingFace> {
    let mut found: Vec<MatingFace> = faces_of(connectors)
        .into_iter()
        .filter(|f| f.gender == Gender::Female)
        .collect();
    found.sort_by(|a, b| a.origin.partial_cmp(&b.origin).expect("finite"));
    found
}

fn tube_table() -> PrimitiveTable {
    let table: Value =
        serde_json::from_slice(&fs::read(table_path()).expect("table file")).expect("table json");
    PrimitiveTable::from_json(&table).expect("table")
}

#[test]
fn a_stud_tube_supplies_its_four_diagonal_receptors_only_where_they_are_open() {
    let mut off_centre = custom_plate(2, 2, &[]);
    off_centre = off_centre.replace(
        "1 16 0 4 0 1 0 0 0 -1 0 0 0 1 stud4.dat",
        "1 16 10 4 10 1 0 0 0 -1 0 0 0 1 stud4.dat",
    );
    let library = with_parts(
        pinned("ldraw"),
        &[
            ("parts/custom.dat", custom_plate(4, 4, &[])),
            ("parts/offcentre.dat", off_centre),
        ],
    );
    let shadow = pinned("ldcad-shadow");
    let mut primitives = PrimitiveConnectors::new(&library, tube_table());
    let mut inferred = InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
        .expect("the pinned stud measures");
    let mut gated = |path: &str| {
        let candidates = primitives.where_open(path);
        female_faces(&inferred.open(path, candidates).connectors)
    };
    let plate = gated("parts/custom.dat");
    assert!(plate.iter().all(|f| f.source == Source::Inferred));
    let mut positions: Vec<[f64; 3]> = plate.iter().map(|f| f.origin).collect();
    positions.dedup();
    assert_eq!(positions.len(), 16);
    for x in [-10.0, 10.0] {
        for z in [-10.0, 10.0] {
            assert!(plate.iter().any(|f| f.origin == [x, -8.0, z]));
        }
    }
    let shifted = gated("parts/offcentre.dat");
    let origins: Vec<[f64; 3]> = shifted.iter().map(|f| f.origin).collect();
    assert_eq!(origins, vec![[0.0, -8.0, 0.0]]);
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, tube_table()),
        InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
            .expect("the pinned stud measures"),
    );
    let extraction = extractor.extract("parts/custom.dat");
    assert!(!extraction.issues.iter().any(|issue| matches!(
        issue,
        Issue::Uninferred {
            reason: Uninferred::LooseCavity { .. } | Uninferred::OffCentreCavity { .. },
            ..
        }
    )));
}

#[test]
fn a_face_already_held_gets_no_second_receptor() {
    let mut uneven = custom_plate(3, 2, &[]);
    uneven = uneven.replace(
        "1 16 10 4 0 1 0 0 0 -1 0 0 0 1 stud4.dat",
        "1 16 10 6 0 1 0 0 0 -0.5 0 0 0 1 stud4.dat",
    );
    let dusty = custom_plate(2, 2, &[]).replace(
        "1 16 0 4 0 1 0 0 0 -1 0 0 0 1 stud4.dat",
        "1 16 0 4.001 0 1 0 0 0 -1 0 0 0 1 stud4.dat",
    );
    let library = with_parts(
        pinned("ldraw"),
        &[
            ("parts/curated.dat", custom_plate(2, 2, &[])),
            ("parts/uneven.dat", uneven),
            ("parts/dusty-curated.dat", dusty),
        ],
    );
    let shadow = with_parts(
        pinned("ldcad-shadow"),
        &[
            (
                "parts/curated.dat",
                "0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 8] [pos=-10 8 -10]\n"
                    .to_string(),
            ),
            (
                "parts/dusty-curated.dat",
                "0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 8] [pos=-10 8 -10]\n"
                    .to_string(),
            ),
        ],
    );
    let mut extractor = ConnectorExtractor::new(
        ShadowSnaps::new(&library, &shadow),
        PrimitiveConnectors::new(&library, tube_table()),
        InferredFeatures::new(&library, shadow_vocabulary(&shadow), "p/stud.dat")
            .expect("the pinned stud measures"),
    );
    let mut per_face = |path: &str| {
        let mut counts: Vec<([f64; 3], Vec<Source>)> = Vec::new();
        for face in female_faces(&extractor.extract(path).connectors) {
            match counts.iter_mut().find(|(origin, _)| *origin == face.origin) {
                Some((_, sources)) => sources.push(face.source),
                None => counts.push((face.origin, vec![face.source])),
            }
        }
        counts
    };
    let curated = per_face("parts/curated.dat");
    assert_eq!(curated.len(), 5);
    assert!(curated.iter().all(|(_, sources)| sources.len() == 1));
    assert!(curated.contains(&([-10.0, -8.0, 10.0], vec![Source::Shadow])));
    assert!(curated.contains(&([0.0, -8.0, 0.0], vec![Source::Inferred])));
    let shared = per_face("parts/uneven.dat");
    assert!(shared.iter().all(|(_, sources)| sources.len() == 1));
    for z in [-10.0, 10.0] {
        assert!(shared.iter().any(|(origin, _)| *origin == [0.0, -8.0, z]));
    }
    let off_grid = extractor.extract("parts/dusty-curated.dat");
    let receptors_at = |origin: [f64; 3]| {
        female_faces(&off_grid.connectors)
            .iter()
            .filter(|f| (0..3).all(|k| (f.origin[k] - origin[k]).abs() <= 0.01))
            .count()
    };
    assert_eq!(receptors_at([-10.0, -8.0, 10.0]), 1);
    assert_eq!(receptors_at([10.0, -8.0, 10.0]), 0);
    let stranded = female_faces(&off_grid.off_lattice)
        .iter()
        .filter(|f| f.origin[0].abs() > 9.99 && f.origin[2].abs() > 9.99)
        .count();
    assert_eq!(stranded, 4);
    assert!(off_grid.issues.iter().any(|issue| matches!(
        issue,
        Issue::Uninferred {
            reason: Uninferred::UnidentifiedOrigin,
            ..
        }
    )));
}

const FACE_PAIR_AT_PLUS_Z: &str = "0 !LDCAD SNAP_GEN [id=face] [group=token] [gender=M] [bounding=cyl 15 0] [match=group] [pos=0 0 8] [ori=1 0 0 0 0 1 0 -1 0]
0 !LDCAD SNAP_GEN [id=face] [group=token] [gender=F] [bounding=cyl 15 0] [match=group] [pos=0 0 8] [ori=1 0 0 0 0 -1 0 1 0]
";

#[test]
fn project_patches_add_curated_snaps_with_their_status_and_clear_by_id() {
    let library = memory(&[
        ("parts/casing.dat", "0 Casing\n"),
        (
            "parts/assembly.dat",
            "0 Assembly\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 casing.dat\n",
        ),
    ]);
    let shadow = memory(&[(
        "parts/casing.dat",
        "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 2 4]\n",
    )]);
    let reassembled = FACE_PAIR_AT_PLUS_Z.replace("pos=0 0 8", "pos=0 0 9");
    let assembly_patch = format!("0 !LDCAD SNAP_CLEAR [id=face]\n{reassembled}");
    let patches = memory(&[
        ("parts/casing.dat", FACE_PAIR_AT_PLUS_Z),
        ("parts/assembly.dat", &assembly_patch),
    ]);
    let verified: HashSet<String> = ["parts/assembly.dat".to_string()].into();
    let mut snaps = ShadowSnaps::new(&library, &shadow).patched(ShadowPatches {
        files: &patches,
        verified: &verified,
    });
    let tally = |connectors: &[Connector]| {
        let mut rows: Vec<(Source, Status, i64)> = connectors
            .iter()
            .map(|c| (c.source, c.status, c.placement.m[11].round() as i64))
            .collect();
        rows.sort();
        rows
    };
    assert_eq!(
        tally(&snaps.snaps("parts/casing.dat").connectors),
        vec![
            (Source::Shadow, Status::Verified, 0),
            (Source::Patch, Status::Unverified, -8),
            (Source::Patch, Status::Unverified, -8),
        ]
    );
    assert_eq!(
        tally(&snaps.snaps("parts/assembly.dat").connectors),
        vec![
            (Source::Shadow, Status::Verified, 0),
            (Source::Patch, Status::Verified, -9),
            (Source::Patch, Status::Verified, -9),
        ]
    );
}

#[test]
fn a_group_matched_disc_generic_reads_as_one_contact_face_per_gender() {
    let library = memory(&[("parts/casing.dat", "0 Casing\n")]);
    let shadow = memory(&[("parts/casing.dat", FACE_PAIR_AT_PLUS_Z)]);
    let connectors = ShadowSnaps::new(&library, &shadow)
        .snaps("parts/casing.dat")
        .connectors;
    let faces = faces_of(&connectors);
    let genders: Vec<Gender> = faces.iter().map(|f| f.gender).collect();
    assert_eq!(genders, vec![Gender::Male, Gender::Female]);
    for face in &faces {
        assert_eq!(face.origin, [0.0, 0.0, -8.0]);
        assert_eq!(face.axis, [0.0, 0.0, -1.0]);
        assert_eq!(
            face.sections,
            vec![FaceSection {
                code: ROUND,
                size: 15.0,
                length: 0.0
            }]
        );
        assert_eq!((face.caps, face.slide), (0, false));
        assert_eq!(face.group.as_deref(), Some("token"));
    }
    for unreadable in [
        FACE_PAIR_AT_PLUS_Z.replace("[group=token] ", ""),
        FACE_PAIR_AT_PLUS_Z.replace("cyl 15 0", "cyl 15 4"),
        FACE_PAIR_AT_PLUS_Z.replace("cyl 15 0", "sph 15"),
    ] {
        let shadow = memory(&[("parts/casing.dat", &unreadable)]);
        for connector in ShadowSnaps::new(&library, &shadow)
            .snaps("parts/casing.dat")
            .connectors
        {
            assert_eq!(
                mating_faces(&connector),
                Err(Unreadable::Generic),
                "{unreadable}"
            );
        }
    }
}

#[test]
fn outward_round_bands_skip_inverted_surfaces_and_end_faces_sit_at_the_extremes() {
    let mut files = pinned("ldraw").0;
    files.insert(
        "parts/casing.dat".to_string(),
        "0 Casing\n0 BFC CERTIFY CCW\n\
         1 16 0 0 -8 15 0 0 0 0 15 0 16 0 4-4cyli.dat\n\
         0 BFC INVERTNEXT\n\
         1 16 0 0 -8 12 0 0 0 0 12 0 16 0 4-4cyli.dat\n\
         1 16 0 0 8 15 0 0 0 0 15 0 -1 0 4-4disc.dat\n\
         1 16 0 0 -8 15 0 0 0 0 15 0 1 0 4-4disc.dat\n\
         1 16 0 0 9 2 0 0 0 0 2 0 -1 0 4-4disc.dat\n"
            .to_string(),
    );
    let library = MemoryLibrary(files);
    let records = |reference: &str| is_circular_primitive(reference);
    let flattened = Flattener::new(&library, Lod::Standard, &[])
        .recording_spans(&records)
        .flatten("parts/casing.dat")
        .expect("the casing flattens");
    let bands = outward_round_bands(&flattened.spans, &flattened.triangles);
    assert_eq!(bands.len(), 1, "{bands:?}");
    let band = bands[0];
    assert_eq!((band.radius, band.from, band.to), (15.0, -8.0, 8.0));
    assert_eq!(band.axis, [0.0, 0.0, 1.0]);
    let [far, near] = end_faces(&band, &flattened.triangles).expect("planar end faces");
    assert_eq!((far.origin, far.normal), ([0.0, 0.0, 9.0], [0.0, 0.0, 1.0]));
    assert!((far.radius - 2.0).abs() <= 0.0005, "{far:?}");
    assert_eq!(
        (near.origin, near.normal),
        ([0.0, 0.0, -8.0], [0.0, 0.0, -1.0])
    );
    assert!((near.radius - 15.0).abs() <= 0.0005, "{near:?}");
}

#[test]
fn connectors_half_an_ldu_apart_keep_their_own_slots_on_the_sixteenth_grid() {
    let table: Value =
        serde_json::from_slice(&fs::read(table_path()).expect("the primitive table"))
            .expect("json");
    let shadow = memory(&[(
        "parts/pair.dat",
        "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 4 4] [pos=0 -8 0]\n",
    )]);
    let extract = |tier_two_y: &str| {
        let mut files = pinned("ldraw").0;
        files.insert(
            "parts/pair.dat".to_string(),
            format!("0 Pair\n1 16 0 {tier_two_y} 0 1 0 0 0 1 0 0 0 1 stud3a.dat\n"),
        );
        let library = MemoryLibrary(files);
        let mut extractor = ConnectorExtractor::new(
            ShadowSnaps::new(&library, &shadow),
            PrimitiveConnectors::new(&library, PrimitiveTable::from_json(&table).expect("table")),
        );
        let extraction = extractor.extract("parts/pair.dat");
        let mut placed: Vec<(Source, Option<[i32; 3]>)> = faces_of(&extraction.connectors)
            .iter()
            .map(|face| (face.source, face.sixteenths))
            .collect();
        placed.sort();
        placed
    };
    assert_eq!(
        extract("-8.5"),
        vec![
            (Source::Shadow, Some([0, 128, 0])),
            (Source::Primitive, Some([0, 136, 0])),
        ]
    );
    assert_eq!(
        extract("-8.0003"),
        vec![(Source::Shadow, Some([0, 128, 0]))]
    );
}
