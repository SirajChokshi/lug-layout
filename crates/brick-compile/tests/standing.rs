use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use brick_compile::bake::{LatticeShape, ModelBaker};
use brick_compile::compile::stud_primitives_from_table;
use brick_compile::connect::{
    lattice_receptors, verified_patch_paths, ConnectorExtractor, FaceSection, InferredFeatures,
    PrimitiveConnectors, PrimitiveTable, SectionVocabulary, ShadowPatches, ShadowSnaps, SnapShape,
    CAP_FAR, ROUND,
};
use brick_compile::lattice::{LatticeError, LatticeReceptor};
use brick_compile::model::bake_model;
use brick_compile::seat::Seating;
use brick_compile::Library;

struct Pinned(HashMap<String, String>);

impl Library for Pinned {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }
}

fn repo(path: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn pinned(folder: &str) -> Pinned {
    under(&repo(".cache").join(folder))
}

fn under(root: &Path) -> Pinned {
    let root = root.to_path_buf();
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
            let bytes = fs::read(&path).expect("readable file");
            files.insert(key, String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    Pinned(files)
}

fn json(path: &str) -> serde_json::Value {
    serde_json::from_slice(&fs::read(repo(path)).expect("readable repo file")).expect("JSON")
}

struct Bench {
    library: Pinned,
    shadow: Pinned,
    patches: Pinned,
    verified: HashSet<String>,
    table: serde_json::Value,
    vocabulary: SectionVocabulary,
    probe: String,
    table_depth: f64,
}

impl Bench {
    fn new() -> Bench {
        let inferred = json("tools/asset-pipeline/inferred-connectors.json");
        Bench {
            library: pinned("ldraw"),
            shadow: pinned("ldcad-shadow-bundle"),
            patches: under(&repo("tools/asset-pipeline/shadow-patches")),
            verified: verified_patch_paths(&json(
                "tools/asset-pipeline/shadow-patches/manifest.json",
            )),
            table: json("tools/asset-pipeline/primitive-connectors.json"),
            vocabulary: SectionVocabulary::from_json(&json(
                "tools/asset-pipeline/section-vocabulary.json",
            ))
            .expect("the section vocabulary reads"),
            probe: inferred["cavityProbe"]
                .as_str()
                .expect("a cavity probe")
                .to_string(),
            table_depth: json("docs/verified-facts/geometry.json")["tablePlane"]
                ["depthBelowTopLdu"]
                .as_f64()
                .expect("the table plane depth"),
        }
    }

    fn seating(&self, text: &str) -> Seating {
        self.seating_with(text, |receptors| receptors)
    }

    fn seating_with(
        &self,
        text: &str,
        receptors_of: impl Fn(Vec<LatticeReceptor>) -> Vec<LatticeReceptor>,
    ) -> Seating {
        let mut extractor = ConnectorExtractor::new(
            ShadowSnaps::new(&self.library, &self.shadow).patched(ShadowPatches {
                files: &self.patches,
                verified: &self.verified,
            }),
            PrimitiveConnectors::new(
                &self.library,
                PrimitiveTable::from_json(&self.table).expect("the primitive table reads"),
            ),
            InferredFeatures::new(&self.library, self.vocabulary.clone(), &self.probe)
                .expect("the cavity probe measures"),
        );
        let model = bake_model(text).expect("the model reads");
        let mut baker = ModelBaker::new(
            &self.library,
            stud_primitives_from_table(&self.table).expect("stud primitives"),
            Vec::new(),
            HashSet::new(),
            self.table_depth,
        )
        .expect("the stud primitives compile");
        let shapes: Vec<LatticeShape> = model
            .instances
            .iter()
            .map(|instance| {
                let path = baker
                    .standard_part(&instance.part)
                    .unwrap_or_else(|e| panic!("{} compiles: {e}", instance.part))
                    .path
                    .clone();
                let receptors = receptors_of(lattice_receptors(&extractor.extract(&path)));
                baker
                    .lattice_shape(&instance.part)
                    .expect("shape")
                    .with_receptors(receptors)
            })
            .collect();
        let drawn: Vec<&LatticeShape> = shapes.iter().collect();
        baker
            .seating(&model.instances, &drawn)
            .expect("every part compiles")
    }

    fn lattice(&self, text: &str) -> Option<([u32; 2], f64)> {
        self.lattice_with(text, |receptors| receptors)
    }

    fn lattice_with(
        &self,
        text: &str,
        receptors_of: impl Fn(Vec<LatticeReceptor>) -> Vec<LatticeReceptor>,
    ) -> Option<([u32; 2], f64)> {
        match self.seating_with(text, receptors_of).lattice {
            Ok(lattice) => Some((lattice.phase, lattice.phase_layer_y)),
            Err(LatticeError::NoIntegerPhase) => None,
            Err(error) => panic!("no tied stud layer: {error}"),
        }
    }
}

fn one(part: &str) -> String {
    format!("1 16 0 0 0 1 0 0 0 1 0 0 0 1 {part}\n")
}

const TABLE_ON_ROUND_PLATES: &str = "0 Custom table standing on four 1 x 1 round plates
1 4 -10 0 -10 1 0 0 0 1 0 0 0 1 6141.dat
1 4 10 0 -10 1 0 0 0 1 0 0 0 1 6141.dat
1 4 -10 0 10 1 0 0 0 1 0 0 0 1 6141.dat
1 4 10 0 10 1 0 0 0 1 0 0 0 1 6141.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 3022.dat
";

const JUMPER_BENCH: &str = "0 Custom bench of two jumpers under a tile
1 4 -30 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 10 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 2431.dat
";

const JUMPER_BESIDE_A_PLATE: &str = "0 Custom jumper beside a 1 x 1 plate, whose two studs tie
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 15 10 0 20 1 0 0 0 1 0 0 0 1 3024.dat
";

const JUMPER_BENCH_BESIDE_A_MACARONI_BRICK: &str =
    "0 Custom bench beside a 2 x 2 corner round brick with stud notch
1 4 -30 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 10 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 2431.dat
1 14 0 -16 -60 1 0 0 0 1 0 0 0 1 3063b.dat
";

const JUMPER_BENCH_BESIDE_A_CORNER_TILE: &str = "0 Custom bench beside a 2 x 2 corner round tile
1 4 -30 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 10 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 2431.dat
1 14 0 0 -60 1 0 0 0 1 0 0 0 1 27925.dat
";

const HINGE_INDEX: usize = 5;

const JUMPER_ROW_BESIDE_A_LOCKING_HINGE: &str =
    "0 Custom row of jumpers beside a locking hinge plate whose anti-studs share their frame
1 4 -70 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 -30 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 10 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 50 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 90 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 7 10 0 -60 1 0 0 0 1 0 0 0 1 44568.dat
";

const TURNTABLE_ON_ITS_BASE: &str = "0 Custom turntable, top on base
1 16 0 0 0 1 0 0 0 1 0 0 0 1 3680.dat
1 7 0 0 0 1 0 0 0 1 0 0 0 1 3679.dat
";

#[test]
fn a_model_keeps_its_stud_phase_where_its_studs_seat_on_a_stud_field_and_takes_the_receptors_it_stands_on_where_only_they_do(
) {
    let bench = Bench::new();
    let phase = |text: &str| bench.lattice(text).map(|(phase, _)| phase);

    let kept = [
        ("3001.dat", [10, 10]),
        ("3811.dat", [10, 10]),
        ("6141.dat", [0, 0]),
        ("3062b.dat", [0, 0]),
        ("43722a.dat", [10, 0]),
        ("3679.dat", [10, 10]),
        ("2429.dat", [10, 10]),
        ("2430.dat", [10, 10]),
    ]
    .map(|(part, stud_phase)| (part, phase(&one(part)), Some(stud_phase)));
    let switched = [
        ("3794b.dat", [10, 0]),
        ("15573.dat", [10, 0]),
        ("87580.dat", [10, 10]),
    ]
    .map(|(part, receptor_phase)| (part, phase(&one(part)), Some(receptor_phase)));
    let studless = [
        ("3069b.dat", [10, 0]),
        ("3070b.dat", [0, 0]),
        ("3680.dat", [10, 10]),
        ("27925.dat", [0, 0]),
    ]
    .map(|(part, receptor_phase)| (part, phase(&one(part)), Some(receptor_phase)));
    let custom = [
        (
            "table on round plates",
            phase(TABLE_ON_ROUND_PLATES),
            Some([10, 10]),
        ),
        ("jumper bench", phase(JUMPER_BENCH), Some([0, 0])),
        (
            "jumper beside a plate",
            phase(JUMPER_BESIDE_A_PLATE),
            Some([10, 0]),
        ),
        (
            "turntable on its base",
            phase(TURNTABLE_ON_ITS_BASE),
            Some([10, 10]),
        ),
        (
            "jumper bench beside a macaroni brick",
            phase(JUMPER_BENCH_BESIDE_A_MACARONI_BRICK),
            Some([0, 0]),
        ),
        (
            "jumper bench beside a corner round tile",
            phase(JUMPER_BENCH_BESIDE_A_CORNER_TILE),
            Some([0, 0]),
        ),
        (
            "jumper row beside a locking hinge",
            phase(JUMPER_ROW_BESIDE_A_LOCKING_HINGE),
            Some([10, 0]),
        ),
    ];

    for (model, found, expected) in kept
        .into_iter()
        .chain(switched)
        .chain(studless)
        .chain(custom)
    {
        assert_eq!(found, expected, "{model}");
    }
}

#[test]
fn a_jumper_framed_by_its_receptors_keeps_its_stud_layer_as_its_height_and_a_tile_takes_its_underside(
) {
    let bench = Bench::new();
    assert_eq!(bench.lattice(&one("3794b.dat")), Some(([10, 0], 0.0)));
    assert_eq!(bench.lattice(&one("3069b.dat")), Some(([10, 0], -8.0)));
}

const JUMPER_BENCH_BESIDE_A_CURVED_WEDGE: &str =
    "0 Custom bench of two jumpers under a tile, beside a 4 x 4 curved wedge
1 4 -30 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 4 10 0 0 1 0 0 0 1 0 0 0 1 3794b.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 2431.dat
1 1 90 -8 0 1 0 0 0 1 0 0 0 1 45677.dat
";

#[test]
fn a_receptor_that_takes_the_stud_seats_it_by_its_connector_data_where_the_drawn_cavity_is_tighter_than_the_stud(
) {
    let bench = Bench::new();
    let phase = |text: &str| bench.lattice(text).map(|(phase, _)| phase);

    assert_eq!(bench.lattice(&one("91501.dat")), Some(([0, 0], -24.0)));
    assert_eq!(phase(JUMPER_BENCH_BESIDE_A_CURVED_WEDGE), Some([0, 0]));
}

#[test]
fn a_receptor_too_narrow_for_the_stud_still_votes_but_never_vouches_for_its_parts_mesh() {
    let bench = Bench::new();
    let bar_holder = SnapShape::new(
        CAP_FAR,
        false,
        None,
        &[FaceSection {
            code: ROUND,
            size: 4.0,
            length: 4.0,
        }],
    )
    .expect("a bar holder reads");
    let narrowed = |receptors: Vec<LatticeReceptor>| {
        receptors
            .into_iter()
            .map(|receptor| LatticeReceptor {
                shape: bar_holder.clone(),
                ..receptor
            })
            .collect()
    };

    assert_eq!(bench.lattice(&one("91501.dat")), Some(([0, 0], -24.0)));
    assert_eq!(bench.lattice_with(&one("91501.dat"), narrowed), None);
    assert_eq!(
        bench.lattice_with(&one("3069b.dat"), narrowed),
        Some(([10, 0], -8.0))
    );
}

#[test]
fn a_receptor_frame_refused_by_a_part_drawn_into_the_studs_reports_each_stud_that_part_reaches_into(
) {
    let seating = Bench::new().seating(JUMPER_ROW_BESIDE_A_LOCKING_HINGE);
    let refused = seating
        .refused
        .iter()
        .find(|refused| refused.phase == [0, 0])
        .expect("the anti-studs' frame was tried and refused");
    assert!(!refused.intrusions.is_empty());
    for intrusion in &refused.intrusions {
        assert_eq!(intrusion.instance, HINGE_INDEX, "{intrusion:?}");
        assert!(intrusion.depth > 0.0, "{intrusion:?}");
    }
}
