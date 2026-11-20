mod common;

use brick_compile::bake::{drawn_lattice, LatticeShape};
use brick_compile::model::bake_model;
use brick_compile::{compile_part, CompileOptions};
use common::fixture_library;

const CUSTOM_TWO_AXLE_WAGON: &str = "0 Custom two-axle wagon from official parts
0 Name: custom-two-axle-wagon.ldr
0 Author: lug-layout tests
0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt
1 16 50 -63 0 0 0 1 0 1 0 -1 0 0 2878c01.dat
1 8 0 -55 0 -1 0 0 0 1 0 0 0 -1 3034.dat
1 16 0 -63 0 -1 0 0 0 1 0 0 0 -1 3020.dat
1 16 -50 -63 0 0 0 1 0 1 0 -1 0 0 2878c01.dat
";

#[test]
fn a_custom_wagon_takes_its_lattice_from_its_lowest_upright_studs_never_its_wheel_holders_side_studs(
) {
    let library = fixture_library();
    let options = CompileOptions {
        stud_primitives: vec!["stud.dat".to_string(), "stud2.dat".to_string()],
        ..CompileOptions::default()
    };
    let model = bake_model(CUSTOM_TWO_AXLE_WAGON).expect("the wagon bakes");
    let shapes: Vec<LatticeShape> = model
        .instances
        .iter()
        .map(|instance| {
            let compiled = compile_part(&library, &instance.part, &options)
                .unwrap_or_else(|e| panic!("{} compiles: {e}", instance.part));
            LatticeShape::of(&compiled)
        })
        .collect();
    let drawn: Vec<&LatticeShape> = shapes.iter().collect();
    let lattice = drawn_lattice(&model.instances, &drawn)
        .expect("one phase on the lowest upright layer")
        .expect("a lattice");
    assert_eq!(lattice.phase, [10, 10]);
    assert_eq!(lattice.phase_layer_y, 47.0);
    assert_eq!(lattice.phase_layer_studs, 8);
}
