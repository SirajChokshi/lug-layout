mod common;

use std::collections::HashMap;
use std::sync::OnceLock;

use brick_compile::cover::PartSolid;
use brick_compile::lattice::STUD_LDU;
use brick_compile::model::bake_model;
use brick_compile::solid::{solid_samples, SolidGrid, SolidInstance};
use brick_compile::{compile_part, CompileOptions, Lod};
use common::{fixture_library, MemoryLibrary};

const UPRIGHT: &str = "1 0 0 0 1 0 0 0 1";
const QUARTER_TURN: &str = "0 0 1 0 1 0 -1 0 0";
const GRID_MARGIN_STUDS: f64 = 20.0;

fn library() -> &'static MemoryLibrary {
    static LIBRARY: OnceLock<MemoryLibrary> = OnceLock::new();
    LIBRARY.get_or_init(fixture_library)
}

fn meets(first: &str, second: &str) -> bool {
    let source = format!("0 pair\n0 Name: pair.ldr\n1 4 {first}\n1 1 {second}\n");
    let model = bake_model(&source).expect("model parses");
    let options = CompileOptions {
        lod: Lod::Standard,
        stud_primitives: Vec::new(),
        unofficial_allowlist: Vec::new(),
    };
    let mut slots: HashMap<String, usize> = HashMap::new();
    let mut solids: Vec<PartSolid> = Vec::new();
    let parts: Vec<usize> = model
        .instances
        .iter()
        .map(|instance| {
            *slots.entry(instance.part.clone()).or_insert_with(|| {
                let compiled = compile_part(library(), &instance.part, &options)
                    .unwrap_or_else(|e| panic!("{}: {e}", instance.part));
                solids.push(PartSolid::from_mesh(&compiled.mesh));
                solids.len() - 1
            })
        })
        .collect();
    let instances: Vec<SolidInstance> = model
        .instances
        .iter()
        .zip(&parts)
        .map(|(instance, &part)| SolidInstance {
            matrix: &instance.matrix,
            part,
        })
        .collect();
    let reach = |axis: usize, pick: fn(f64, f64) -> f64, start: f64| {
        let corner = model
            .instances
            .iter()
            .map(|instance| instance.matrix.m[axis * 4 + 3] / STUD_LDU)
            .fold(start, pick);
        corner.round()
    };
    let lo = [0, 2].map(|axis| reach(axis, f64::min, f64::INFINITY) - GRID_MARGIN_STUDS);
    let hi = [0, 2].map(|axis| reach(axis, f64::max, f64::NEG_INFINITY) + GRID_MARGIN_STUDS);
    let samples = solid_samples(
        &instances,
        &solids,
        SolidGrid {
            origin: lo.map(|cells| cells * STUD_LDU),
            width: (hi[0] - lo[0]) as usize,
            depth: (hi[1] - lo[1]) as usize,
            datum_y: 0.0,
        },
    );
    match samples.overlaps.as_slice() {
        [] => false,
        [[0, 1]] => true,
        other => panic!("two parts give pairs {other:?}"),
    }
}

fn at(x: i32, y: i32, z: i32, rotation: &str, part: &str) -> String {
    format!("{x} {y} {z} {rotation} {part}.dat")
}

fn base(part: &str) -> String {
    at(0, 0, 0, UPRIGHT, part)
}

#[test]
fn legal_stacking_and_adjacency_of_real_parts_never_overlap() {
    let cases = [
        (
            "2x4 bricks stacked",
            base("3001"),
            at(0, -24, 0, UPRIGHT, "3001"),
        ),
        (
            "staggered one stud",
            base("3001"),
            at(20, -24, 0, UPRIGHT, "3001"),
        ),
        (
            "crossed a quarter turn",
            base("3001"),
            at(0, -24, 0, QUARTER_TURN, "3001"),
        ),
        (
            "flush end to end",
            base("3001"),
            at(80, 0, 0, UPRIGHT, "3001"),
        ),
        (
            "flush side by side",
            base("3001"),
            at(0, 0, 40, UPRIGHT, "3001"),
        ),
        (
            "plate on a brick",
            base("3001"),
            at(0, -8, 0, UPRIGHT, "3020"),
        ),
        (
            "brick on a plate",
            base("3020"),
            at(0, -24, 0, UPRIGHT, "3001"),
        ),
        (
            "1x1 plates stacked",
            base("3024"),
            at(0, -8, 0, UPRIGHT, "3024"),
        ),
        (
            "tile on a plate",
            base("3024"),
            at(0, -8, 0, UPRIGHT, "3070b"),
        ),
        (
            "2x2 tile on a plate",
            base("3022"),
            at(0, -8, 0, UPRIGHT, "3068b"),
        ),
        (
            "brick resting on a tile",
            base("3068b"),
            at(0, -24, 0, UPRIGHT, "3001"),
        ),
        (
            "round brick on a brick",
            base("3005"),
            at(0, -24, 0, UPRIGHT, "3062b"),
        ),
        (
            "brick on a hollow stud",
            base("3062b"),
            at(0, -24, 0, UPRIGHT, "3005"),
        ),
        (
            "2x2 round on 2x2",
            base("3003"),
            at(0, -24, 0, UPRIGHT, "3941"),
        ),
        (
            "2x2 on 2x2 round",
            base("3941"),
            at(0, -24, 0, UPRIGHT, "3003"),
        ),
        (
            "slope on a brick",
            base("3003"),
            at(0, -24, 10, UPRIGHT, "3039"),
        ),
        (
            "1x2 slope on a brick",
            base("3003"),
            at(10, -24, 10, UPRIGHT, "3040b"),
        ),
        (
            "inverted slope over a stud",
            base("3003"),
            at(10, -24, 10, UPRIGHT, "3665"),
        ),
        (
            "headlight brick",
            base("3003"),
            at(10, -24, 10, UPRIGHT, "4070"),
        ),
        (
            "jumper on a plate",
            base("3023"),
            at(0, -8, 0, UPRIGHT, "3794b"),
        ),
        (
            "round plate on a jumper",
            base("3794b"),
            at(0, -8, 0, UPRIGHT, "6141"),
        ),
        (
            "Technic bricks stacked",
            base("3700"),
            at(0, -24, 0, UPRIGHT, "3700"),
        ),
        (
            "6x6 plates stacked",
            base("3958"),
            at(0, -8, 0, UPRIGHT, "3958"),
        ),
        (
            "brick on a baseplate",
            base("3811"),
            at(0, -24, 0, UPRIGHT, "3001"),
        ),
        (
            "1x1 in a corner brick's notch",
            base("2357"),
            at(20, 0, 20, UPRIGHT, "3005"),
        ),
        (
            "plate under an arch's span",
            at(0, -24, 0, UPRIGHT, "3659"),
            at(10, 0, 0, UPRIGHT, "3024"),
        ),
    ];
    let overlapping: Vec<&str> = cases
        .iter()
        .filter(|(_, first, second)| meets(first, second))
        .map(|(name, _, _)| *name)
        .collect();
    assert_eq!(overlapping, Vec::<&str>::new());
}

#[test]
fn real_parts_that_intersect_always_overlap() {
    let cases = [
        (
            "pushed one stud into it",
            base("3001"),
            at(60, 0, 0, UPRIGHT, "3001"),
        ),
        (
            "sunk half a plate",
            base("3001"),
            at(0, -20, 0, UPRIGHT, "3001"),
        ),
        (
            "half a stud off its studs",
            base("3001"),
            at(10, -24, 0, UPRIGHT, "3001"),
        ),
        (
            "half a stud off a baseplate",
            base("3811"),
            at(10, -24, 10, UPRIGHT, "3001"),
        ),
        (
            "baseplate lying on studs",
            base("3001"),
            at(0, -4, 0, UPRIGHT, "3811"),
        ),
        (
            "1x1 in a corner brick's body",
            base("2357"),
            at(20, 0, 0, UPRIGHT, "3005"),
        ),
        (
            "two plates under an arch's curve",
            at(0, -24, 0, UPRIGHT, "3659"),
            at(10, -8, 0, UPRIGHT, "3024"),
        ),
    ];
    let apart: Vec<&str> = cases
        .iter()
        .filter(|(_, first, second)| !meets(first, second))
        .map(|(name, _, _)| *name)
        .collect();
    assert_eq!(apart, Vec::<&str>::new());
}
