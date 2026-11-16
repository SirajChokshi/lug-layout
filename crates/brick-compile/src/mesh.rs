use std::collections::{BTreeMap, HashMap, HashSet};

use crate::affine::Vec3;
use crate::flatten::Triangle;

pub const WELD_EPSILON_LDU: f64 = 0.05;
const MIN_SMOOTHING_COSINE: f64 = 0.5;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub groups: Vec<ColorGroup>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ColorGroup {
    pub color: u32,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.groups.iter().map(|g| g.indices.len() / 3).sum()
    }

    pub fn bounds(&self) -> Option<[[f32; 3]; 2]> {
        if self.positions.is_empty() {
            return None;
        }
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for vertex in self.positions.chunks_exact(3) {
            for axis in 0..3 {
                min[axis] = min[axis].min(vertex[axis]);
                max[axis] = max[axis].max(vertex[axis]);
            }
        }
        Some([min, max])
    }
}

type WeldKey = (i64, i64, i64);
type EdgeIncidence = (usize, usize, usize);

fn weld_key(p: Vec3) -> WeldKey {
    (
        (p[0] / WELD_EPSILON_LDU).round() as i64,
        (p[1] / WELD_EPSILON_LDU).round() as i64,
        (p[2] / WELD_EPSILON_LDU).round() as i64,
    )
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn length(v: Vec3) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn edge_key(a: u32, b: u32) -> (u32, u32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

struct DisjointSet {
    parent: Vec<usize>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        DisjointSet {
            parent: (0..size).collect(),
        }
    }

    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }

    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

struct Welded {
    positions: Vec<Vec3>,
    triangles: Vec<([u32; 3], u32)>,
    face_normals: Vec<Vec3>,
}

fn weld(triangles: &[Triangle]) -> (Welded, HashMap<WeldKey, u32>) {
    let mut lookup: HashMap<WeldKey, u32> = HashMap::new();
    let mut positions: Vec<Vec3> = Vec::new();
    let mut welded = Vec::new();
    let mut face_normals = Vec::new();
    let mut index_of = |p: Vec3, positions: &mut Vec<Vec3>| -> u32 {
        *lookup.entry(weld_key(p)).or_insert_with(|| {
            positions.push(p);
            (positions.len() - 1) as u32
        })
    };
    for triangle in triangles {
        let windings: &[[usize; 3]] = if triangle.double_sided {
            &[[0, 1, 2], [0, 2, 1]]
        } else {
            &[[0, 1, 2]]
        };
        for order in windings {
            let corners = order.map(|i| index_of(triangle.points[i], &mut positions));
            if corners[0] == corners[1] || corners[1] == corners[2] || corners[0] == corners[2] {
                continue;
            }
            let [a, b, c] = corners.map(|i| positions[i as usize]);
            let normal = cross(sub(b, a), sub(c, a));
            if length(normal) == 0.0 {
                continue;
            }
            welded.push((corners, triangle.color));
            face_normals.push(normal);
        }
    }
    (
        Welded {
            positions,
            triangles: welded,
            face_normals,
        },
        lookup,
    )
}

pub fn build(triangles: &[Triangle], hard_edges: &[[Vec3; 2]]) -> Mesh {
    let (welded, lookup) = weld(triangles);
    let hard: HashSet<(u32, u32)> = hard_edges
        .iter()
        .filter_map(|[a, b]| {
            let ia = lookup.get(&weld_key(*a))?;
            let ib = lookup.get(&weld_key(*b))?;
            Some(edge_key(*ia, *ib))
        })
        .collect();

    let mut incidences: HashMap<(u32, u32), Vec<EdgeIncidence>> = HashMap::new();
    for (face, (corners, _)) in welded.triangles.iter().enumerate() {
        for edge in 0..3 {
            let a = edge;
            let b = (edge + 1) % 3;
            incidences
                .entry(edge_key(corners[a], corners[b]))
                .or_default()
                .push((face, a, b));
        }
    }

    let unit: Vec<Vec3> = welded
        .face_normals
        .iter()
        .map(|n| {
            let l = length(*n);
            [n[0] / l, n[1] / l, n[2] / l]
        })
        .collect();

    let mut sets = DisjointSet::new(welded.triangles.len() * 3);
    for (key, faces) in &incidences {
        if hard.contains(key) {
            continue;
        }
        for (i, &(fa, aa, ab)) in faces.iter().enumerate() {
            for &(fb, ba, bb) in &faces[i + 1..] {
                let na = unit[fa];
                let nb = unit[fb];
                if na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] < MIN_SMOOTHING_COSINE {
                    continue;
                }
                let corners_a = welded.triangles[fa].0;
                let corners_b = welded.triangles[fb].0;
                for (ca, va) in [(aa, corners_a[aa]), (ab, corners_a[ab])] {
                    let cb = if corners_b[ba] == va { ba } else { bb };
                    sets.union(fa * 3 + ca, fb * 3 + cb);
                }
            }
        }
    }

    let mut accumulated: HashMap<usize, Vec3> = HashMap::new();
    for (face, normal) in welded.face_normals.iter().enumerate() {
        for corner in 0..3 {
            let root = sets.find(face * 3 + corner);
            let sum = accumulated.entry(root).or_insert([0.0; 3]);
            sum[0] += normal[0];
            sum[1] += normal[1];
            sum[2] += normal[2];
        }
    }

    let mut mesh = Mesh::default();
    let mut vertex_of: HashMap<(u32, usize), u32> = HashMap::new();
    let mut groups: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for (face, (corners, color)) in welded.triangles.iter().enumerate() {
        let group = groups.entry(*color).or_default();
        for (corner, &position_index) in corners.iter().enumerate() {
            let root = sets.find(face * 3 + corner);
            let index = *vertex_of.entry((position_index, root)).or_insert_with(|| {
                let p = welded.positions[position_index as usize];
                let n = accumulated[&root];
                let l = length(n);
                mesh.positions
                    .extend([p[0] as f32, p[1] as f32, p[2] as f32]);
                mesh.normals
                    .extend([(n[0] / l) as f32, (n[1] / l) as f32, (n[2] / l) as f32]);
                (mesh.positions.len() / 3 - 1) as u32
            });
            group.push(index);
        }
    }
    mesh.groups = groups
        .into_iter()
        .map(|(color, indices)| ColorGroup { color, indices })
        .collect();
    mesh
}
