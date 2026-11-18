mod common;

use std::fs;
use std::path::Path;

use brick_compile::affine::Affine;
use brick_compile::cover::{
    model_cover, CoverInstance, CoverShard, ModelCover, Opacity, PartSolid, StudShape,
};
use brick_compile::{compile_part, CompileOptions};
use common::fixture_library;

const STUD: StudShape = StudShape {
    height: 4.0,
    radius: 6.0,
};
const OPAQUE: u32 = 4;
const CLEAR: u32 = 47;
const PLATE_6X6: usize = 0;
const BRICK_2X4: usize = 1;
const PLATE_2X4: usize = 2;
const PLATE_2X8: usize = 3;
const PARTS: [&str; 4] = ["3958.dat", "3001.dat", "3020.dat", "3034.dat"];
const LAYERS: usize = 12;
const SLICINGS: [&[(usize, usize)]; 3] = [
    &[(0, 1), (1, 2), (2, 3)],
    &[(0, 1), (1, 3), (3, 5)],
    &[(0, 1), (1, 3), (3, 5), (5, 7)],
];

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

fn placed(x: f64, y: f64, z: f64, quarter: bool) -> Affine {
    let (c, s) = if quarter { (0.0, 1.0) } else { (1.0, 0.0) };
    Affine {
        m: [c, 0.0, s, x, 0.0, 1.0, 0.0, y, -s, 0.0, c, z],
    }
}

fn custom_pile(heights: &[f64]) -> Vec<(usize, u32, Affine)> {
    let mut pile = Vec::new();
    let mut level = 0.0;
    for layer in 0..LAYERS {
        let shift = 20.0 * (layer % 3) as f64;
        let quarter = layer % 2 == 1;
        level += heights[PLATE_6X6];
        pile.push((PLATE_6X6, OPAQUE, placed(shift, level, 0.0, quarter)));
        let on_plate = level;
        let brick_color = if layer % 4 == 3 { CLEAR } else { OPAQUE };
        pile.push((
            BRICK_2X4,
            brick_color,
            placed(shift - 20.0, on_plate + heights[BRICK_2X4], -20.0, quarter),
        ));
        pile.push((
            PLATE_2X4,
            OPAQUE,
            placed(shift + 20.0, on_plate + heights[PLATE_2X4], 20.0, !quarter),
        ));
        if layer % 3 == 2 {
            pile.push((
                PLATE_2X8,
                OPAQUE,
                placed(shift, on_plate + heights[PLATE_2X8], 40.0, true),
            ));
        }
        level = on_plate + heights[BRICK_2X4];
    }
    pile
}

fn joined(primary: &ModelCover, others: &[ModelCover]) -> (Vec<bool>, usize) {
    let mut visible = primary.visible.clone();
    let mut open_below = primary.open_below;
    for other in others {
        for (joined, &seen) in visible.iter_mut().zip(&other.visible) {
            *joined &= seen;
        }
        open_below += other.open_below;
    }
    (visible, open_below)
}

#[test]
fn baking_a_custom_pile_in_slices_hides_exactly_what_baking_it_whole_hides() {
    let options = CompileOptions {
        stud_primitives: vec!["stud.dat".to_string(), "stud2.dat".to_string()],
        ..CompileOptions::default()
    };
    let library = fixture_library();
    let compiled: Vec<_> = PARTS
        .iter()
        .map(|part| compile_part(&library, part, &options).expect("part compiles"))
        .collect();
    let solids: Vec<PartSolid> = compiled
        .iter()
        .map(|part| PartSolid::from_mesh(&part.mesh))
        .collect();
    let studs: Vec<Vec<Affine>> = compiled
        .iter()
        .map(|part| part.studs.iter().map(|stud| stud.matrix).collect())
        .collect();
    let heights: Vec<f64> = compiled
        .iter()
        .map(|part| {
            let [min, max] = part.mesh.bounds().expect("part has geometry");
            f64::from(max[1] - min[1]).round()
        })
        .collect();
    let pile = custom_pile(&heights);
    let instances: Vec<CoverInstance> = pile
        .iter()
        .map(|(part, color, matrix)| CoverInstance {
            matrix,
            color: *color,
            part: *part,
            studs: &studs[*part],
        })
        .collect();
    let opacity = Opacity::new([CLEAR]);
    let first_stud = instances[0].matrix.then(&instances[0].studs[0]);
    let phase = [first_stud.m[3], first_stud.m[11]].map(|at| at.rem_euclid(20.0) as u32);
    let lattice = Some((phase, first_stud.m[7]));
    let table_depth = table_depth();
    let cover = |shard| {
        model_cover(
            &instances,
            &solids,
            &opacity,
            lattice,
            STUD,
            shard,
            table_depth,
        )
    };

    let whole = cover(CoverShard::WHOLE);
    let hidden = whole.covered_count();
    assert!(
        hidden > 0 && whole.open_below > 0,
        "the pile hides {hidden} studs and leaves {} open below",
        whole.open_below
    );
    for slicing in SLICINGS {
        let of = slicing.last().expect("a slicing has slices").1;
        let shards: Vec<ModelCover> = slicing
            .iter()
            .map(|&(from, to)| cover(CoverShard { from, to, of }))
            .collect();
        for (shard, &(from, to)) in shards.iter().zip(slicing) {
            assert!(
                shard.covered_count() + shard.open_below > 0,
                "slice {from}..{to} of {of} decides at least one stud"
            );
            assert_eq!(
                shard.cells, whole.cells,
                "slice {from}..{to} of {of} has the whole bake's cells"
            );
        }
        let (primary, others) = shards.split_first().expect("a slicing has slices");
        let (visible, open_below) = joined(primary, others);
        assert_eq!(visible, whole.visible, "slices of {of} joined");
        assert_eq!(open_below, whole.open_below, "slices of {of} joined");
    }
}
