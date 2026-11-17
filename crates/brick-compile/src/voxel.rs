use std::collections::{BTreeMap, HashMap, HashSet};

use crate::affine::{Affine, Vec3};
use crate::flatten::{StudReference, INHERIT_COLOR};
use crate::lattice::{model_lattice, LatticeError, LatticeInstance};
use crate::mesh::{ColorGroup, Mesh, WELD_EPSILON_LDU};

pub const CELL_LDU: [i64; 3] = [20, 8, 20];
pub const CELL_MARGIN_LDU: f64 = 2.0 * WELD_EPSILON_LDU;
pub const VOXEL_NOTE: &str = "model far meshes voxelize the standard-detail body triangles (studs excluded) of every drawn part onto 20 x 8 x 20 LDU cells on the model's stud lattice, colour each cell by its largest clipped area, and greedy-mesh the exposed cell faces into one primitive per colour";
const STUD_CENTRE_TO_CELL_EDGE_LDU: i64 = 10;
const MAX_CLIPPED_VERTICES: usize = 12;
const EMPTY: u32 = u32::MAX;
const AREA_TIE_LDU2: f64 = 1e-6;

pub struct VoxelPart<'a> {
    pub mesh: &'a Mesh,
    pub studs: &'a [StudReference],
    pub color: u32,
    pub matrix: &'a Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub enum VoxelError {
    Lattice(LatticeError),
    FractionalStudLayer(f64),
    Empty,
}

impl std::fmt::Display for VoxelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VoxelError::Lattice(error) => write!(f, "{error}"),
            VoxelError::FractionalStudLayer(y) => {
                write!(f, "lowest stud layer at y = {y} is not on a whole LDU")
            }
            VoxelError::Empty => write!(f, "model has no body triangles to voxelize"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoxelGrid {
    pub origin: [i64; 3],
    pub dims: [usize; 3],
    pub cells: Vec<u32>,
    pub colors: Vec<u32>,
}

impl VoxelGrid {
    pub fn count(&self) -> usize {
        self.cells.len()
    }

    fn dense(&self) -> Vec<u32> {
        let mut dense = vec![EMPTY; self.dims[0] * self.dims[1] * self.dims[2]];
        for (&cell, &color) in self.cells.iter().zip(&self.colors) {
            dense[cell as usize] = color;
        }
        dense
    }
}

type CellKey = (i64, i64, i64);
type Polygon = ([Vec3; MAX_CLIPPED_VERTICES], usize);

fn lattice_instances<'a>(
    parts: &'a [VoxelPart],
    studs: &'a [Vec<Vec3>],
) -> Vec<LatticeInstance<'a>> {
    parts
        .iter()
        .zip(studs)
        .map(|(part, studs)| {
            let [min, max] = part.mesh.bounds().unwrap_or([[0.0; 3]; 2]);
            LatticeInstance {
                matrix: part.matrix,
                studs,
                bounds_min: min.map(f64::from),
                bounds_max: max.map(f64::from),
            }
        })
        .collect()
}

pub fn grid_phase(parts: &[VoxelPart]) -> Result<[i64; 3], VoxelError> {
    let studs: Vec<Vec<Vec3>> = parts
        .iter()
        .map(|part| {
            part.studs
                .iter()
                .map(|stud| [stud.matrix.m[3], stud.matrix.m[7], stud.matrix.m[11]])
                .collect()
        })
        .collect();
    let lattice = model_lattice(&lattice_instances(parts, &studs)).map_err(VoxelError::Lattice)?;
    let layer = lattice.phase_layer_y;
    if layer.fract() != 0.0 {
        return Err(VoxelError::FractionalStudLayer(layer));
    }
    Ok([
        (i64::from(lattice.phase[0]) - STUD_CENTRE_TO_CELL_EDGE_LDU).rem_euclid(CELL_LDU[0]),
        (layer as i64).rem_euclid(CELL_LDU[1]),
        (i64::from(lattice.phase[1]) - STUD_CENTRE_TO_CELL_EDGE_LDU).rem_euclid(CELL_LDU[2]),
    ])
}

fn clip_axis(polygon: &Polygon, axis: usize, bound: f64, keep_above: bool) -> Polygon {
    let (points, len) = polygon;
    let mut out = ([[0.0; 3]; MAX_CLIPPED_VERTICES], 0);
    if *len == 0 {
        return out;
    }
    let inside = |p: &Vec3| {
        if keep_above {
            p[axis] >= bound
        } else {
            p[axis] <= bound
        }
    };
    for i in 0..*len {
        let current = points[i];
        let next = points[(i + 1) % len];
        let current_in = inside(&current);
        let next_in = inside(&next);
        if current_in && out.1 < MAX_CLIPPED_VERTICES {
            out.0[out.1] = current;
            out.1 += 1;
        }
        if current_in != next_in && out.1 < MAX_CLIPPED_VERTICES {
            let t = (bound - current[axis]) / (next[axis] - current[axis]);
            let mut crossing = [0.0; 3];
            for k in 0..3 {
                crossing[k] = current[k] + t * (next[k] - current[k]);
            }
            crossing[axis] = bound;
            out.0[out.1] = crossing;
            out.1 += 1;
        }
    }
    out
}

fn polygon_area(polygon: &Polygon) -> f64 {
    let (points, len) = polygon;
    if *len < 3 {
        return 0.0;
    }
    let origin = points[0];
    let mut sum = [0.0; 3];
    for i in 1..len - 1 {
        let a = [
            points[i][0] - origin[0],
            points[i][1] - origin[1],
            points[i][2] - origin[2],
        ];
        let b = [
            points[i + 1][0] - origin[0],
            points[i + 1][1] - origin[1],
            points[i + 1][2] - origin[2],
        ];
        sum[0] += a[1] * b[2] - a[2] * b[1];
        sum[1] += a[2] * b[0] - a[0] * b[2];
        sum[2] += a[0] * b[1] - a[1] * b[0];
    }
    0.5 * (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt()
}

fn area_inside_cell(triangle: &[Vec3; 3], low: Vec3, high: Vec3) -> f64 {
    let mut polygon: Polygon = ([[0.0; 3]; MAX_CLIPPED_VERTICES], 3);
    polygon.0[..3].copy_from_slice(triangle);
    for axis in 0..3 {
        polygon = clip_axis(&polygon, axis, low[axis], true);
        polygon = clip_axis(&polygon, axis, high[axis], false);
    }
    polygon_area(&polygon)
}

fn cell_range(min: f64, max: f64, phase: i64, size: i64) -> (i64, i64) {
    let size = size as f64;
    let phase = phase as f64;
    (
        ((min - phase - CELL_MARGIN_LDU) / size).floor() as i64,
        ((max - phase + CELL_MARGIN_LDU) / size).floor() as i64,
    )
}

fn accumulate_triangle(
    triangle: &[Vec3; 3],
    color: u32,
    phase: [i64; 3],
    areas: &mut HashMap<CellKey, BTreeMap<u32, f64>>,
) {
    let mut ranges = [(0, 0); 3];
    for (axis, range) in ranges.iter_mut().enumerate() {
        let lo = triangle
            .iter()
            .map(|p| p[axis])
            .fold(f64::INFINITY, f64::min);
        let hi = triangle
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max);
        *range = cell_range(lo, hi, phase[axis], CELL_LDU[axis]);
    }
    for i in ranges[0].0..=ranges[0].1 {
        for j in ranges[1].0..=ranges[1].1 {
            for k in ranges[2].0..=ranges[2].1 {
                let index = [i, j, k];
                let mut low = [0.0; 3];
                let mut high = [0.0; 3];
                for axis in 0..3 {
                    let edge = (phase[axis] + index[axis] * CELL_LDU[axis]) as f64;
                    low[axis] = edge + CELL_MARGIN_LDU;
                    high[axis] = edge + CELL_LDU[axis] as f64 - CELL_MARGIN_LDU;
                }
                let area = area_inside_cell(triangle, low, high);
                if area > 0.0 {
                    *areas
                        .entry((i, j, k))
                        .or_default()
                        .entry(color)
                        .or_default() += area;
                }
            }
        }
    }
}

fn dominant_color(areas: &BTreeMap<u32, f64>, translucent: &HashSet<u32>) -> u32 {
    let pick = |opaque_only: bool| {
        let mut best: Option<(u32, f64)> = None;
        for (&color, &area) in areas {
            if opaque_only && translucent.contains(&color) {
                continue;
            }
            if best.is_none_or(|(_, top)| area > top + AREA_TIE_LDU2) {
                best = Some((color, area));
            }
        }
        best.map(|(color, _)| color)
    };
    pick(true).or_else(|| pick(false)).unwrap_or(INHERIT_COLOR)
}

pub fn voxelize(parts: &[VoxelPart], translucent: &HashSet<u32>) -> Result<VoxelGrid, VoxelError> {
    let phase = grid_phase(parts)?;
    let mut areas: HashMap<CellKey, BTreeMap<u32, f64>> = HashMap::new();
    for part in parts {
        let positions = part.mesh.positions.as_chunks::<3>().0;
        for group in &part.mesh.groups {
            let color = if group.color == INHERIT_COLOR {
                part.color
            } else {
                group.color
            };
            for corners in group.indices.as_chunks::<3>().0 {
                let triangle = corners.map(|index| {
                    let p = positions[index as usize];
                    part.matrix
                        .apply([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
                });
                accumulate_triangle(&triangle, color, phase, &mut areas);
            }
        }
    }
    if areas.is_empty() {
        return Err(VoxelError::Empty);
    }
    let mut min = [i64::MAX; 3];
    let mut max = [i64::MIN; 3];
    for &(i, j, k) in areas.keys() {
        for (axis, value) in [i, j, k].into_iter().enumerate() {
            min[axis] = min[axis].min(value);
            max[axis] = max[axis].max(value);
        }
    }
    let dims = [0, 1, 2].map(|axis| (max[axis] - min[axis] + 1) as usize);
    let mut cells: Vec<(u32, u32)> = areas
        .iter()
        .map(|(&(i, j, k), colors)| {
            let x = (i - min[0]) as usize;
            let y = (j - min[1]) as usize;
            let z = (k - min[2]) as usize;
            let linear = x + dims[0] * (y + dims[1] * z);
            (linear as u32, dominant_color(colors, translucent))
        })
        .collect();
    cells.sort_unstable();
    Ok(VoxelGrid {
        origin: [0, 1, 2].map(|axis| phase[axis] + min[axis] * CELL_LDU[axis]),
        dims,
        cells: cells.iter().map(|&(cell, _)| cell).collect(),
        colors: cells.iter().map(|&(_, color)| color).collect(),
    })
}

struct FaceBuilder<'a> {
    grid: &'a VoxelGrid,
    positions: Vec<f32>,
    normals: Vec<f32>,
    groups: BTreeMap<u32, Vec<u32>>,
}

impl FaceBuilder<'_> {
    fn corner(&self, axis: usize, plane: usize, u: usize, v: usize, a: usize, b: usize) -> Vec3 {
        let mut cell = [0usize; 3];
        cell[axis] = plane;
        cell[u] = a;
        cell[v] = b;
        [0, 1, 2].map(|k| (self.grid.origin[k] + cell[k] as i64 * CELL_LDU[k]) as f64)
    }

    fn quad(&mut self, axis: usize, positive: bool, plane: usize, rect: [usize; 4], color: u32) {
        let u = (axis + 1) % 3;
        let v = (axis + 2) % 3;
        let [a0, b0, a1, b1] = rect;
        let mut corners = [
            self.corner(axis, plane, u, v, a0, b0),
            self.corner(axis, plane, u, v, a1, b0),
            self.corner(axis, plane, u, v, a1, b1),
            self.corner(axis, plane, u, v, a0, b1),
        ];
        if !positive {
            corners.reverse();
        }
        let mut normal = [0.0f32; 3];
        normal[axis] = if positive { 1.0 } else { -1.0 };
        let first = (self.positions.len() / 3) as u32;
        for corner in corners {
            self.positions.extend(corner.map(|value| value as f32));
            self.normals.extend(normal);
        }
        self.groups.entry(color).or_default().extend([
            first,
            first + 1,
            first + 2,
            first,
            first + 2,
            first + 3,
        ]);
    }
}

pub fn greedy_mesh(grid: &VoxelGrid) -> Mesh {
    let dense = grid.dense();
    let dims = grid.dims;
    let at = |cell: [isize; 3]| -> u32 {
        if (0..3).any(|k| cell[k] < 0 || cell[k] as usize >= dims[k]) {
            return EMPTY;
        }
        dense[cell[0] as usize + dims[0] * (cell[1] as usize + dims[1] * cell[2] as usize)]
    };
    let mut builder = FaceBuilder {
        grid,
        positions: Vec::new(),
        normals: Vec::new(),
        groups: BTreeMap::new(),
    };
    for axis in 0..3 {
        let u = (axis + 1) % 3;
        let v = (axis + 2) % 3;
        for positive in [false, true] {
            let step: isize = if positive { 1 } else { -1 };
            for slice in 0..dims[axis] {
                let mut mask = vec![EMPTY; dims[u] * dims[v]];
                for b in 0..dims[v] {
                    for a in 0..dims[u] {
                        let mut cell = [0isize; 3];
                        cell[axis] = slice as isize;
                        cell[u] = a as isize;
                        cell[v] = b as isize;
                        let color = at(cell);
                        if color == EMPTY {
                            continue;
                        }
                        cell[axis] += step;
                        if at(cell) == EMPTY {
                            mask[a + dims[u] * b] = color;
                        }
                    }
                }
                let plane = if positive { slice + 1 } else { slice };
                for b in 0..dims[v] {
                    let mut a = 0;
                    while a < dims[u] {
                        let color = mask[a + dims[u] * b];
                        if color == EMPTY {
                            a += 1;
                            continue;
                        }
                        let mut width = 1;
                        while a + width < dims[u] && mask[a + width + dims[u] * b] == color {
                            width += 1;
                        }
                        let mut height = 1;
                        'grow: while b + height < dims[v] {
                            for da in 0..width {
                                if mask[a + da + dims[u] * (b + height)] != color {
                                    break 'grow;
                                }
                            }
                            height += 1;
                        }
                        for db in 0..height {
                            for da in 0..width {
                                mask[a + da + dims[u] * (b + db)] = EMPTY;
                            }
                        }
                        builder.quad(axis, positive, plane, [a, b, a + width, b + height], color);
                        a += width;
                    }
                }
            }
        }
    }
    Mesh {
        positions: builder.positions,
        normals: builder.normals,
        groups: builder
            .groups
            .into_iter()
            .map(|(color, indices)| ColorGroup { color, indices })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_box(mesh: &mut Mesh, min: Vec3, max: Vec3) {
        let first = (mesh.positions.len() / 3) as u32;
        for i in 0..8 {
            let corner = [
                if i & 1 == 0 { min[0] } else { max[0] },
                if i & 2 == 0 { min[1] } else { max[1] },
                if i & 4 == 0 { min[2] } else { max[2] },
            ];
            mesh.positions.extend(corner.map(|v| v as f32));
            mesh.normals.extend([0.0, 1.0, 0.0]);
        }
        let faces = [
            [0, 1, 3, 2],
            [4, 6, 7, 5],
            [0, 4, 5, 1],
            [2, 3, 7, 6],
            [0, 2, 6, 4],
            [1, 5, 7, 3],
        ];
        for [a, b, c, d] in faces {
            mesh.groups[0]
                .indices
                .extend([a, b, c, a, c, d].map(|k| first + k));
        }
    }

    #[test]
    fn a_hollow_one_by_one_brick_fills_its_three_plate_cells_and_no_neighbour() {
        let mut mesh = Mesh {
            groups: vec![ColorGroup {
                color: INHERIT_COLOR,
                indices: Vec::new(),
            }],
            ..Mesh::default()
        };
        push_box(&mut mesh, [-10.0, -24.0, -10.0], [10.0, 0.0, 10.0]);
        push_box(&mut mesh, [-6.0, -24.0, -6.0], [6.0, -4.0, 6.0]);
        let studs = [StudReference {
            primitive: "stud.dat".into(),
            color: INHERIT_COLOR,
            matrix: Affine::IDENTITY,
        }];
        let at = Affine {
            m: [
                1.0, 0.0, 0.0, 40.0, 0.0, 1.0, 0.0, 24.0, 0.0, 0.0, 1.0, -20.0,
            ],
        };
        let part = VoxelPart {
            mesh: &mesh,
            studs: &studs,
            color: 4,
            matrix: &at,
        };
        let grid = voxelize(&[part], &HashSet::new()).expect("voxelizes");
        assert_eq!(grid.origin, [30, 0, -30]);
        assert_eq!(grid.dims, [1, 3, 1]);
        assert_eq!(grid.colors, [4, 4, 4]);
        assert_eq!(greedy_mesh(&grid).triangle_count(), 12);
    }
}
