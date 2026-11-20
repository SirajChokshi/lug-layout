mod common;

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use brick_compile::affine::Affine;
use brick_compile::bake::{FarVoxels, ModelBaker};
use brick_compile::model::ModelInstance;
use brick_compile::voxel::VoxelError;
use common::fixture_library;

const BRICK_2X4: &str = "3001.dat";
const RED: u32 = 4;
const THIRD_LDU: f64 = 1.0 / 3.0;
const BRICK_2X4_CELLS: [usize; 3] = [4, 3, 2];

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

fn far_voxels_of_a_brick_raised_by(height: f64) -> FarVoxels {
    let library = fixture_library();
    let mut baker = ModelBaker::new(
        &library,
        vec!["stud.dat".to_string()],
        Vec::new(),
        HashSet::new(),
        table_depth(),
    )
    .expect("the stud primitive compiles");
    let brick = ModelInstance {
        part: BRICK_2X4.to_string(),
        inline: None,
        color: RED,
        matrix: Affine {
            m: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, height, 0.0, 0.0, 1.0, 0.0,
            ],
        },
        submodel: None,
    };
    baker.voxels(&[brick]).expect("the far bake runs")
}

#[test]
fn a_model_whose_lowest_stud_layer_is_off_a_whole_ldu_gets_no_far_mesh_and_says_why() {
    match far_voxels_of_a_brick_raised_by(THIRD_LDU) {
        FarVoxels::Omitted(reason @ VoxelError::FractionalStudLayer(layer_y)) => {
            assert_ne!(layer_y.fract(), 0.0);
            assert_eq!(
                reason.to_string(),
                format!("lowest stud layer at y = {layer_y} is not on a whole LDU")
            );
        }
        other => panic!("a fractional lowest stud layer omits the far mesh, but got {other:?}"),
    }
}

#[test]
fn a_model_whose_lowest_stud_layer_is_on_a_whole_ldu_keeps_its_voxel_far_mesh() {
    match far_voxels_of_a_brick_raised_by(0.0) {
        FarVoxels::Grid(grid) => {
            assert_eq!(grid.dims, BRICK_2X4_CELLS);
            assert_eq!(grid.count(), BRICK_2X4_CELLS.iter().product::<usize>());
            assert!(grid.colors.iter().all(|&color| color == RED));
        }
        other => panic!("a brick on a whole-LDU stud layer keeps its far mesh, but got {other:?}"),
    }
}
