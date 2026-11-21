use rustc_hash::FxHashMap;

use super::{CoverInstance, PartSolid};
use crate::affine::Vec3;
use crate::clip::{clip_to_box, polygon_area};
use crate::identify::SIXTEENTHS_PER_LDU;
use crate::lattice::STUD_LDU;
use crate::mesh::WELD_EPSILON_LDU;

pub const PART_BOX_INTS: usize = 6;
pub const BOX_X0: usize = 0;
pub const BOX_Z0: usize = 1;
pub const BOX_BOTTOM: usize = 2;
pub const BOX_X1: usize = 3;
pub const BOX_Z1: usize = 4;
pub const BOX_TOP: usize = 5;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PartCells {
    pub cell: Vec<u32>,
    pub instance: Vec<u32>,
    pub boxes: Vec<i32>,
}

impl PartCells {
    pub fn len(&self) -> usize {
        self.cell.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cell.is_empty()
    }
}

#[derive(Clone, Copy)]
struct Extent {
    low: Vec3,
    high: Vec3,
    cut_low: [bool; 2],
    cut_high: [bool; 2],
}

impl Extent {
    const EMPTY: Extent = Extent {
        low: [f64::INFINITY; 3],
        high: [f64::NEG_INFINITY; 3],
        cut_low: [false; 2],
        cut_high: [false; 2],
    };

    fn grow(&mut self, point: Vec3) {
        for axis in 0..3 {
            self.low[axis] = self.low[axis].min(point[axis]);
            self.high[axis] = self.high[axis].max(point[axis]);
        }
    }

    fn plan_low(&self, plan: usize, axis: usize) -> i32 {
        if self.cut_low[plan] {
            0
        } else {
            low_sixteenths(self.low[axis])
        }
    }

    fn plan_high(&self, plan: usize, axis: usize) -> i32 {
        if self.cut_high[plan] {
            CELL_SIXTEENTHS
        } else {
            high_sixteenths(self.high[axis])
        }
    }
}

const CELL_SIXTEENTHS: i32 = STUD_LDU as i32 * SIXTEENTHS_PER_LDU;

type CellExtents = Vec<(i64, i64, Extent)>;

#[derive(PartialEq, Eq, Hash)]
struct ShapeKey {
    part: usize,
    linear: [u64; 9],
    phase: [u64; 2],
}

pub struct PartCellGrid {
    pub origin: [f64; 2],
    pub width: usize,
    pub depth: usize,
    pub bottom_y: f64,
}

fn sixteenths() -> f64 {
    f64::from(SIXTEENTHS_PER_LDU)
}

fn low_sixteenths(ldu: f64) -> i32 {
    (ldu * sixteenths() + WELD_EPSILON_LDU * sixteenths()).floor() as i32
}

fn high_sixteenths(ldu: f64) -> i32 {
    (ldu * sixteenths() - WELD_EPSILON_LDU * sixteenths()).ceil() as i32
}

fn cell_of(ldu: f64) -> i64 {
    (ldu / STUD_LDU).floor() as i64
}

fn local_extents(solid: &PartSolid, linear: &[f64; 9], phase: [f64; 2]) -> CellExtents {
    let place = |p: &Vec3| -> Vec3 {
        [
            linear[0] * p[0] + linear[1] * p[1] + linear[2] * p[2] + phase[0],
            linear[3] * p[0] + linear[4] * p[1] + linear[5] * p[2],
            linear[6] * p[0] + linear[7] * p[1] + linear[8] * p[2] + phase[1],
        ]
    };
    let mut cells: FxHashMap<(i64, i64), Extent> = FxHashMap::default();
    for triangle in &solid.triangles {
        let placed = triangle.map(|p| place(&p));
        let span = |axis: usize| {
            placed
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
                    (lo.min(p[axis]), hi.max(p[axis]))
                })
        };
        let (lo_x, hi_x) = span(0);
        let (lo_z, hi_z) = span(2);
        let (first_i, last_i) = (
            cell_of(lo_x + WELD_EPSILON_LDU),
            cell_of(hi_x - WELD_EPSILON_LDU),
        );
        let (first_j, last_j) = (
            cell_of(lo_z + WELD_EPSILON_LDU),
            cell_of(hi_z - WELD_EPSILON_LDU),
        );
        for j in first_j..=last_j {
            for i in first_i..=last_i {
                let edge_x = STUD_LDU * i as f64;
                let edge_z = STUD_LDU * j as f64;
                let inside = clip_to_box(
                    &placed,
                    [
                        edge_x + WELD_EPSILON_LDU,
                        f64::NEG_INFINITY,
                        edge_z + WELD_EPSILON_LDU,
                    ],
                    [
                        edge_x + STUD_LDU - WELD_EPSILON_LDU,
                        f64::INFINITY,
                        edge_z + STUD_LDU - WELD_EPSILON_LDU,
                    ],
                );
                if polygon_area(&inside) <= 0.0 {
                    continue;
                }
                let extent = cells.entry((i, j)).or_insert(Extent::EMPTY);
                extent.cut_low[0] |= lo_x < edge_x + WELD_EPSILON_LDU;
                extent.cut_high[0] |= hi_x > edge_x + STUD_LDU - WELD_EPSILON_LDU;
                extent.cut_low[1] |= lo_z < edge_z + WELD_EPSILON_LDU;
                extent.cut_high[1] |= hi_z > edge_z + STUD_LDU - WELD_EPSILON_LDU;
                let (points, len) = inside;
                for point in &points[..len] {
                    extent.grow([point[0] - edge_x, point[1], point[2] - edge_z]);
                }
            }
        }
    }
    let mut extents: CellExtents = cells.into_iter().map(|((i, j), e)| (i, j, e)).collect();
    extents.sort_by_key(|&(i, j, _)| (j, i));
    extents
}

pub fn part_cells(
    instances: &[CoverInstance],
    solids: &[PartSolid],
    grid: &PartCellGrid,
) -> PartCells {
    let mut shapes: FxHashMap<ShapeKey, CellExtents> = FxHashMap::default();
    let mut entries: Vec<(u32, u32, [i32; PART_BOX_INTS])> = Vec::new();
    for (index, instance) in instances.iter().enumerate() {
        let m = &instance.matrix.m;
        let linear = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
        let cell_x = cell_of(m[3] - grid.origin[0]);
        let cell_z = cell_of(m[11] - grid.origin[1]);
        let phase = [
            m[3] - grid.origin[0] - STUD_LDU * cell_x as f64,
            m[11] - grid.origin[1] - STUD_LDU * cell_z as f64,
        ];
        let key = ShapeKey {
            part: instance.part,
            linear: linear.map(f64::to_bits),
            phase: phase.map(f64::to_bits),
        };
        let extents = shapes
            .entry(key)
            .or_insert_with(|| local_extents(&solids[instance.part], &linear, phase));
        let rest = m[7] - grid.bottom_y;
        for &(i, j, extent) in extents.iter() {
            let (ci, cj) = (cell_x + i, cell_z + j);
            if ci < 0 || cj < 0 || ci >= grid.width as i64 || cj >= grid.depth as i64 {
                continue;
            }
            let part_box = [
                extent.plan_low(0, 0),
                extent.plan_low(1, 2),
                low_sixteenths(extent.low[1] + rest),
                extent.plan_high(0, 0),
                extent.plan_high(1, 2),
                high_sixteenths(extent.high[1] + rest),
            ];
            if part_box[BOX_X1] <= part_box[BOX_X0]
                || part_box[BOX_Z1] <= part_box[BOX_Z0]
                || part_box[BOX_TOP] <= part_box[BOX_BOTTOM]
            {
                continue;
            }
            let cell = cj as usize * grid.width + ci as usize;
            entries.push((cell as u32, index as u32, part_box));
        }
    }
    entries.sort_by_key(|&(cell, instance, _)| (cell, instance));
    let mut cells = PartCells {
        cell: Vec::with_capacity(entries.len()),
        instance: Vec::with_capacity(entries.len()),
        boxes: Vec::with_capacity(entries.len() * PART_BOX_INTS),
    };
    for (cell, instance, part_box) in entries {
        cells.cell.push(cell);
        cells.instance.push(instance);
        cells.boxes.extend_from_slice(&part_box);
    }
    cells
}
