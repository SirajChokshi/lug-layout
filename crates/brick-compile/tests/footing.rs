mod common;

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use brick_compile::bake::{LatticeShape, ModelBaker};
use brick_compile::cover::{CoverShard, ModelCells, EMPTY_COLUMN};
use brick_compile::model::bake_model;
use common::fixture_library;

const NEAR_STRAIGHT: usize = 0;
const FAR_STRAIGHT: usize = 1;
const WALL_AT_THE_FAR_END: usize = 2;
const BRICK_ON_THE_TABLE: usize = 3;
const BRICK_ON_A_BRICK: usize = 4;

const RUN_AND_WALL: &str = "0 Custom run with a wall at its far end
0 Name: custom-run-and-wall.ldr
0 Author: lug-layout tests
0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt
1 16 0 0 0 1 0 0 0 1 0 0 0 1 74746.dat
1 16 320 0 0 1 0 0 0 1 0 0 0 1 74746.dat
1 4 490 -16 50 1 0 0 0 1 0 0 0 1 3005.dat
1 4 580 -16 0 1 0 0 0 1 0 0 0 1 3001.dat
1 4 580 -40 0 1 0 0 0 1 0 0 0 1 3001.dat
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

fn baked_cells(source: &str) -> ModelCells {
    let library = fixture_library();
    let model = bake_model(source).expect("the model bakes");
    let mut baker = ModelBaker::new(
        &library,
        vec!["stud.dat".to_string(), "stud2.dat".to_string()],
        Vec::new(),
        HashSet::new(),
        table_depth(),
    )
    .expect("the baker measures the stud");
    let shapes: Vec<LatticeShape> = model
        .instances
        .iter()
        .map(|instance| baker.lattice_shape(&instance.part).expect("part compiles"))
        .collect();
    let drawn: Vec<&LatticeShape> = shapes.iter().collect();
    let lattice = baker
        .lattice(&model.instances, &drawn)
        .expect("one lattice phase");
    baker
        .cover(&model.instances, lattice.as_ref(), CoverShard::WHOLE)
        .expect("the cover fits")
        .cells
        .expect("a lattice gives cells")
}

fn cell_at(cells: &ModelCells, x: f64, z: f64) -> usize {
    let i = ((x - cells.origin[0]) / 20.0) as usize;
    let j = ((z - cells.origin[1]) / 20.0) as usize;
    j * cells.width + i
}

fn footing_of(cells: &ModelCells, instance: usize) -> Vec<usize> {
    cells
        .footing
        .instance
        .iter()
        .zip(&cells.footing.cell)
        .filter(|(&of, _)| of == instance)
        .map(|(_, &cell)| cell)
        .collect()
}

fn columns_of(cells: &ModelCells, footing: &[usize]) -> BTreeSet<usize> {
    footing.iter().map(|cell| cell % cells.width).collect()
}

#[test]
fn each_part_instance_keeps_its_own_footing_cells_even_where_another_part_shares_the_cell() {
    let cells = baked_cells(RUN_AND_WALL);

    let wall = cell_at(&cells, 490.0, -50.0);
    assert_eq!(footing_of(&cells, WALL_AT_THE_FAR_END), [wall]);
    assert!(
        footing_of(&cells, FAR_STRAIGHT).contains(&wall),
        "the far straight's joiner reaches past its end at x = 480 into the wall's cell"
    );
    let brick: Vec<usize> = [-10.0, 10.0]
        .into_iter()
        .flat_map(|z| [550.0, 570.0, 590.0, 610.0].map(|x| cell_at(&cells, x, z)))
        .collect();
    assert_eq!(footing_of(&cells, BRICK_ON_THE_TABLE), brick);
    assert!(footing_of(&cells, BRICK_ON_A_BRICK).is_empty());

    let joint = cell_at(&cells, 170.0, 0.0) % cells.width;
    assert!(columns_of(&cells, &footing_of(&cells, NEAR_STRAIGHT)).contains(&joint));
    assert!(
        columns_of(&cells, &footing_of(&cells, FAR_STRAIGHT)).contains(&(joint - 1)),
        "each straight reaches across the joint at x = 160 into cells the other stands in"
    );
}

#[test]
fn the_instances_footing_cells_together_are_the_cells_whose_column_reaches_the_lowest_band() {
    let cells = baked_cells(RUN_AND_WALL);
    let occupied = |cell: &usize| cells.column_top[*cell] != EMPTY_COLUMN;
    let standing = (0..cells.column_bottom.len())
        .filter(occupied)
        .map(|cell| cells.column_bottom[cell])
        .min()
        .expect("the model stands somewhere");
    let merged: BTreeSet<usize> = (0..cells.column_bottom.len())
        .filter(|cell| occupied(cell) && cells.column_bottom[*cell] <= standing)
        .collect();
    let united: BTreeSet<usize> = cells.footing.cell.iter().copied().collect();
    assert_eq!(united, merged);

    let pairs: Vec<(usize, usize)> = cells
        .footing
        .instance
        .iter()
        .copied()
        .zip(cells.footing.cell.iter().copied())
        .collect();
    assert!(
        pairs.windows(2).all(|pair| pair[0] < pair[1]),
        "listed once each, by instance and then by cell"
    );
}
