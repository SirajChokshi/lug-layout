mod common;

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use brick_compile::bake::{LatticeShape, ModelBaker};
use brick_compile::model::bake_model;
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

#[test]
fn a_custom_wagon_takes_its_lattice_from_its_lowest_upright_studs_never_its_wheel_holders_side_studs(
) {
    let library = fixture_library();
    let model = bake_model(CUSTOM_TWO_AXLE_WAGON).expect("the wagon bakes");
    let mut baker = ModelBaker::new(
        &library,
        vec!["stud.dat".to_string(), "stud2.dat".to_string()],
        Vec::new(),
        HashSet::new(),
        table_depth(),
    )
    .expect("the stud primitives compile");
    let shapes: Vec<LatticeShape> = model
        .instances
        .iter()
        .map(|instance| {
            baker
                .lattice_shape(&instance.part)
                .unwrap_or_else(|e| panic!("{} compiles: {e}", instance.part))
        })
        .collect();
    let lattice = baker
        .lattice(&model.instances, &shapes.iter().collect::<Vec<_>>())
        .expect("one phase on the lowest upright layer")
        .expect("a lattice");
    assert_eq!(lattice.phase, [10, 10]);
    assert_eq!(lattice.phase_layer_y, 47.0);
    assert_eq!(lattice.phase_layer_votes, 8);
}
