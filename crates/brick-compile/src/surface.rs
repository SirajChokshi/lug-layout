use std::collections::HashMap;

use crate::affine::Vec3;

pub type Face = [Vec3; 3];

const GRID_CELL_LDU: f64 = 4.0;
const MIN_REFINED_DIAMETER_LDU: f64 = 1e-4;
const MAX_REFINEMENTS: usize = 4_000_000;

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn along(origin: Vec3, direction: Vec3, t: f64) -> Vec3 {
    [
        origin[0] + direction[0] * t,
        origin[1] + direction[1] * t,
        origin[2] + direction[2] * t,
    ]
}

fn squared_length(v: Vec3) -> f64 {
    dot(v, v)
}

pub fn closest_point(p: Vec3, [a, b, c]: &Face) -> Vec3 {
    let ab = sub(*b, *a);
    let ac = sub(*c, *a);
    let ap = sub(p, *a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return *a;
    }
    let bp = sub(p, *b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return *b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return along(*a, ab, d1 / (d1 - d3));
    }
    let cp = sub(p, *c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return *c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return along(*a, ac, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        return along(*b, sub(*c, *b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    let denominator = va + vb + vc;
    if denominator == 0.0 {
        return [ab, ac, sub(*c, *b)]
            .iter()
            .zip([*a, *a, *b])
            .map(|(edge, start)| {
                let length = squared_length(*edge);
                let t = if length == 0.0 {
                    0.0
                } else {
                    (dot(sub(p, start), *edge) / length).clamp(0.0, 1.0)
                };
                along(start, *edge, t)
            })
            .fold(*a, |best, candidate| {
                if squared_length(sub(p, candidate)) < squared_length(sub(p, best)) {
                    candidate
                } else {
                    best
                }
            });
    }
    let v = vb / denominator;
    let w = vc / denominator;
    [
        a[0] + ab[0] * v + ac[0] * w,
        a[1] + ab[1] * v + ac[1] * w,
        a[2] + ab[2] * v + ac[2] * w,
    ]
}

fn cell_of(p: Vec3) -> [i64; 3] {
    p.map(|v| (v / GRID_CELL_LDU).floor() as i64)
}

struct FaceGrid<'a> {
    faces: &'a [Face],
    cells: HashMap<[i64; 3], Vec<usize>>,
}

impl<'a> FaceGrid<'a> {
    fn new(faces: &'a [Face], reach: f64) -> Self {
        let mut cells: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
        for (index, face) in faces.iter().enumerate() {
            let low =
                cell_of([0, 1, 2].map(|axis| {
                    face.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min) - reach
                }));
            let high = cell_of([0, 1, 2].map(|axis| {
                face.iter()
                    .map(|p| p[axis])
                    .fold(f64::NEG_INFINITY, f64::max)
                    + reach
            }));
            for x in low[0]..=high[0] {
                for y in low[1]..=high[1] {
                    for z in low[2]..=high[2] {
                        cells.entry([x, y, z]).or_default().push(index);
                    }
                }
            }
        }
        FaceGrid { faces, cells }
    }

    fn distance_squared(&self, p: Vec3, candidates: impl Iterator<Item = usize>) -> f64 {
        candidates
            .map(|index| squared_length(sub(p, closest_point(p, &self.faces[index]))))
            .fold(f64::INFINITY, f64::min)
    }

    fn distance(&self, p: Vec3, reach: f64) -> f64 {
        let near = self.cells.get(&cell_of(p)).map_or(f64::INFINITY, |cell| {
            self.distance_squared(p, cell.iter().copied())
        });
        if near <= reach * reach {
            return near.sqrt();
        }
        self.distance_squared(p, 0..self.faces.len()).sqrt()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceMatch {
    pub within: bool,
    pub max_measured: f64,
}

impl SurfaceMatch {
    fn and(self, other: SurfaceMatch) -> SurfaceMatch {
        SurfaceMatch {
            within: self.within && other.within,
            max_measured: self.max_measured.max(other.max_measured),
        }
    }
}

fn midpoint(a: Vec3, b: Vec3) -> Vec3 {
    [0, 1, 2].map(|axis| (a[axis] + b[axis]) / 2.0)
}

fn diameter([a, b, c]: &Face) -> f64 {
    squared_length(sub(*a, *b))
        .max(squared_length(sub(*b, *c)))
        .max(squared_length(sub(*c, *a)))
        .sqrt()
}

fn covered_by_one(grid: &FaceGrid, piece: &Face, reach: f64) -> bool {
    grid.cells.get(&cell_of(piece[0])).is_some_and(|cell| {
        cell.iter().any(|&index| {
            let face = &grid.faces[index];
            piece
                .iter()
                .all(|p| squared_length(sub(*p, closest_point(*p, face))) <= reach * reach)
        })
    })
}

fn directed_surface_match(from: &[Face], to: &[Face], reach: f64) -> SurfaceMatch {
    if from.is_empty() {
        return SurfaceMatch {
            within: true,
            max_measured: 0.0,
        };
    }
    if to.is_empty() {
        return SurfaceMatch {
            within: false,
            max_measured: f64::INFINITY,
        };
    }
    let grid = FaceGrid::new(to, reach);
    let mut result = SurfaceMatch {
        within: true,
        max_measured: 0.0,
    };
    let mut refinements = 0;
    let mut pending: Vec<Face> = from.to_vec();
    while let Some(piece) = pending.pop() {
        let farthest = piece
            .iter()
            .map(|p| grid.distance(*p, reach))
            .fold(0.0, f64::max);
        result.max_measured = result.max_measured.max(farthest);
        if farthest > reach {
            result.within = false;
            continue;
        }
        let size = diameter(&piece);
        if farthest + size <= reach || covered_by_one(&grid, &piece, reach) {
            continue;
        }
        if size < MIN_REFINED_DIAMETER_LDU || refinements >= MAX_REFINEMENTS {
            result.within = false;
            continue;
        }
        refinements += 1;
        let [a, b, c] = piece;
        let (ab, bc, ca) = (midpoint(a, b), midpoint(b, c), midpoint(c, a));
        pending.extend([[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]);
    }
    result
}

pub fn surface_match(a: &[Face], b: &[Face], reach: f64) -> SurfaceMatch {
    directed_surface_match(a, b, reach).and(directed_surface_match(b, a, reach))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WELD: f64 = 0.05;

    fn quad(corners: [Vec3; 4], start: usize) -> [Face; 2] {
        let at = |i: usize| corners[(start + i) % 4];
        [[at(0), at(1), at(2)], [at(0), at(2), at(3)]]
    }

    fn rectangle(x0: f64, z0: f64, x1: f64, z1: f64) -> [Face; 2] {
        quad(
            [[x0, 0.0, z0], [x1, 0.0, z0], [x1, 0.0, z1], [x0, 0.0, z1]],
            0,
        )
    }

    const SQUARE: [Vec3; 4] = [
        [0.0, 0.0, 0.0],
        [40.0, 0.0, 0.0],
        [40.0, 0.0, 20.0],
        [0.0, 0.0, 20.0],
    ];

    #[test]
    fn a_quad_listed_from_another_vertex_is_the_same_surface() {
        let found = surface_match(&quad(SQUARE, 0), &quad(SQUARE, 1), WELD);
        assert!(found.within);
        assert!(found.max_measured < 1e-9);
    }

    #[test]
    fn a_retessellated_region_is_the_same_surface() {
        let middle = [20.0, 0.0, 0.0];
        let fan = [
            [SQUARE[0], middle, SQUARE[3]],
            [middle, SQUARE[2], SQUARE[3]],
            [middle, SQUARE[1], SQUARE[2]],
        ];
        assert!(surface_match(&quad(SQUARE, 0), &fan, WELD).within);
    }

    #[test]
    fn a_shift_within_the_weld_matches_and_beyond_it_does_not() {
        let near = SQUARE.map(|[x, y, z]| [x, y + 0.04, z]);
        assert!(surface_match(&quad(SQUARE, 0), &quad(near, 0), WELD).within);
        let far = SQUARE.map(|[x, y, z]| [x, y + 1.5, z]);
        let shifted = surface_match(&quad(SQUARE, 0), &quad(far, 0), WELD);
        assert!(!shifted.within);
        assert!((shifted.max_measured - 1.5).abs() < 1e-9);
    }

    #[test]
    fn a_hole_away_from_every_vertex_and_midpoint_is_found() {
        let holed: Vec<Face> = [
            rectangle(0.0, 0.0, 16.0, 20.0),
            rectangle(24.0, 0.0, 40.0, 20.0),
            rectangle(16.0, 0.0, 24.0, 10.0),
            rectangle(16.0, 15.0, 24.0, 20.0),
        ]
        .concat();
        let found = surface_match(&quad(SQUARE, 0), &holed, WELD);
        assert!(!found.within);
        assert!(found.max_measured > WELD);
    }
}
