use std::cmp::Ordering;
use std::collections::VecDeque;

use num_bigint::{BigInt, BigUint};
use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::exact::{Exact, ExactVec3};
use crate::flatten::{StudReference, Triangle};
use crate::identify::{sixteenths, IDENTIFY_LDU, SIXTEENTHS_PER_LDU};
use crate::lattice::STUD_LDU;

const CELL: i64 = STUD_LDU as i64 * SIXTEENTHS_PER_LDU as i64;
const HALF_CELL: i64 = CELL / 2;
const SIDES: [[i64; 2]; 4] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

pub type ExactCorners = [ExactVec3; 3];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopCell {
    Open,
    Flat,
    Pocket,
    Undecided,
}

impl TopCell {
    pub fn code(self) -> char {
        match self {
            TopCell::Open => '.',
            TopCell::Flat => 'f',
            TopCell::Pocket => 'p',
            TopCell::Undecided => 'u',
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TopSurface {
    pub top: i64,
    pub origin: [i64; 2],
    pub columns: usize,
    pub rows: usize,
    pub cells: Vec<TopCell>,
}

impl TopSurface {
    pub fn read(
        triangles: &[Triangle],
        exact: &dyn Fn(usize) -> Option<ExactCorners>,
        studs: &[StudReference],
    ) -> Option<TopSurface> {
        let grid = Grid::of(triangles)?;
        let top = highest(triangles, exact)?;
        if sixteenths(top.to_f64()) != Some(grid.top) {
            return None;
        }
        let level = Level::at(triangles, exact, &top);
        let mut cells: Vec<TopCell> = (0..grid.count())
            .map(|cell| match level.coverage(&grid.square(cell)) {
                Coverage::Full => TopCell::Flat,
                Coverage::Partial => TopCell::Open,
                Coverage::Undecided => TopCell::Undecided,
            })
            .collect();
        let recessed = grid.recessed_studs(studs, &cells);
        for pocket in grid.pockets(&recessed, &cells) {
            for cell in pocket {
                cells[cell] = TopCell::Pocket;
            }
        }
        Some(TopSurface {
            top: grid.top,
            origin: grid.origin,
            columns: grid.columns,
            rows: grid.rows,
            cells,
        })
    }

    pub fn cell(&self, column: usize, row: usize) -> TopCell {
        self.cells[row * self.columns + column]
    }

    pub fn rows_text(&self) -> Vec<String> {
        self.cells
            .chunks(self.columns)
            .map(|row| row.iter().map(|cell| cell.code()).collect())
            .collect()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "stepsPerLdu": SIXTEENTHS_PER_LDU,
            "top": self.top,
            "origin": self.origin,
            "size": [self.columns, self.rows],
            "cells": self.rows_text(),
        })
    }
}

struct Grid {
    top: i64,
    origin: [i64; 2],
    columns: usize,
    rows: usize,
}

fn whole_cells(span: i64) -> Option<usize> {
    if span <= 0 || span % CELL != 0 {
        return None;
    }
    usize::try_from(span / CELL).ok()
}

impl Grid {
    fn of(triangles: &[Triangle]) -> Option<Grid> {
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for point in triangles.iter().flat_map(|triangle| triangle.points.iter()) {
            for axis in 0..3 {
                low[axis] = low[axis].min(point[axis]);
                high[axis] = high[axis].max(point[axis]);
            }
        }
        let top = sixteenths(high[1])?;
        let origin = [sixteenths(low[0])?, sixteenths(low[2])?];
        let columns = whole_cells(sixteenths(high[0])? - origin[0])?;
        let rows = whole_cells(sixteenths(high[2])? - origin[1])?;
        Some(Grid {
            top,
            origin,
            columns,
            rows,
        })
    }

    fn count(&self) -> usize {
        self.columns * self.rows
    }

    fn square(&self, cell: usize) -> Square {
        let column = i64::try_from(cell % self.columns).unwrap_or(i64::MAX);
        let row = i64::try_from(cell / self.columns).unwrap_or(i64::MAX);
        let x = self.origin[0] + column * CELL;
        let z = self.origin[1] + row * CELL;
        Square {
            low: [x, z],
            high: [x + CELL, z + CELL],
        }
    }

    fn cell_centred_at(&self, x: i64, z: i64) -> Option<usize> {
        let dx = x - self.origin[0] - HALF_CELL;
        let dz = z - self.origin[1] - HALF_CELL;
        if dx < 0 || dz < 0 || dx % CELL != 0 || dz % CELL != 0 {
            return None;
        }
        let column = usize::try_from(dx / CELL).ok()?;
        let row = usize::try_from(dz / CELL).ok()?;
        (column < self.columns && row < self.rows).then_some(row * self.columns + column)
    }

    fn neighbour(&self, cell: usize, [dx, dz]: [i64; 2]) -> Option<usize> {
        let column = i64::try_from(cell % self.columns).ok()? + dx;
        let row = i64::try_from(cell / self.columns).ok()? + dz;
        let column = usize::try_from(column).ok()?;
        let row = usize::try_from(row).ok()?;
        (column < self.columns && row < self.rows).then_some(row * self.columns + column)
    }

    fn recessed_studs(&self, studs: &[StudReference], cells: &[TopCell]) -> Vec<bool> {
        let mut recessed = vec![false; self.count()];
        for stud in studs {
            if let Some(cell) = self.recessed(&stud.matrix) {
                recessed[cell] = cells[cell] == TopCell::Open;
            }
        }
        recessed
    }

    fn recessed(&self, matrix: &Affine) -> Option<usize> {
        let m = &matrix.m;
        let upright = m[1] == 0.0 && m[9] == 0.0 && m[5] > 0.0;
        if !upright || sixteenths(m[7])? >= self.top {
            return None;
        }
        self.cell_centred_at(sixteenths(m[3])?, sixteenths(m[11])?)
    }

    fn pockets(&self, recessed: &[bool], cells: &[TopCell]) -> Vec<Vec<usize>> {
        let mut seen = vec![false; recessed.len()];
        let mut pockets = Vec::new();
        for start in 0..recessed.len() {
            if !recessed[start] || seen[start] {
                continue;
            }
            seen[start] = true;
            let mut members = Vec::new();
            let mut enclosed = true;
            let mut pending = VecDeque::from([start]);
            while let Some(cell) = pending.pop_front() {
                members.push(cell);
                for side in SIDES {
                    match self.neighbour(cell, side) {
                        None => {}
                        Some(next) if recessed[next] => {
                            if !seen[next] {
                                seen[next] = true;
                                pending.push_back(next);
                            }
                        }
                        Some(next) => enclosed &= cells[next] == TopCell::Flat,
                    }
                }
            }
            if enclosed {
                pockets.push(members);
            }
        }
        pockets
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Coverage {
    Full,
    Partial,
    Undecided,
}

struct Square {
    low: [i64; 2],
    high: [i64; 2],
}

impl Square {
    fn doubled_area(&self) -> Fraction {
        let per_ldu = i64::from(SIXTEENTHS_PER_LDU);
        Fraction::new(
            BigInt::from(2 * (self.high[0] - self.low[0]) * (self.high[1] - self.low[1])),
            BigInt::from(per_ldu * per_ldu),
        )
    }

    fn meets(&self, reach: &[f64; 4]) -> bool {
        let per_ldu = f64::from(SIXTEENTHS_PER_LDU);
        let low = self.low.map(|v| v as f64 / per_ldu);
        let high = self.high.map(|v| v as f64 / per_ldu);
        reach[0] < high[0] && reach[2] > low[0] && reach[1] < high[1] && reach[3] > low[1]
    }

    fn half_planes(&self) -> [Line; 4] {
        let per_ldu = BigInt::from(SIXTEENTHS_PER_LDU);
        let zero = || BigInt::from(0);
        [
            Line {
                a: per_ldu.clone(),
                b: zero(),
                d: BigInt::from(-self.low[0]),
            },
            Line {
                a: -per_ldu.clone(),
                b: zero(),
                d: BigInt::from(self.high[0]),
            },
            Line {
                a: zero(),
                b: per_ldu.clone(),
                d: BigInt::from(-self.low[1]),
            },
            Line {
                a: zero(),
                b: -per_ldu,
                d: BigInt::from(self.high[1]),
            },
        ]
    }
}

fn reach(points: &[Vec3; 3]) -> [f64; 4] {
    let low = |axis: usize| points.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
    let high = |axis: usize| {
        points
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max)
    };
    [
        low(0) - IDENTIFY_LDU,
        low(2) - IDENTIFY_LDU,
        high(0) + IDENTIFY_LDU,
        high(2) + IDENTIFY_LDU,
    ]
}

fn highest(triangles: &[Triangle], exact: &dyn Fn(usize) -> Option<ExactCorners>) -> Option<Exact> {
    let float_top = triangles
        .iter()
        .flat_map(|triangle| triangle.points.iter().map(|p| p[1]))
        .fold(f64::NEG_INFINITY, f64::max);
    let mut highest: Option<Exact> = None;
    for (index, triangle) in triangles.iter().enumerate() {
        if triangle
            .points
            .iter()
            .all(|p| p[1] < float_top - IDENTIFY_LDU)
        {
            continue;
        }
        let Some(corners) = exact(index) else {
            continue;
        };
        for corner in corners {
            let y = corner[1].clone();
            if highest
                .as_ref()
                .is_none_or(|h| y.compare(h) == Ordering::Greater)
            {
                highest = Some(y);
            }
        }
    }
    highest
}

struct Face {
    corners: [Point; 3],
    reach: [f64; 4],
}

impl Face {
    fn counter_clockwise(corners: [Point; 3], reach: [f64; 4]) -> Option<Face> {
        let [p, q, r] = corners;
        let corners = match Line::through(&p, &q).value(&r).sign() {
            num_bigint::Sign::NoSign => return None,
            num_bigint::Sign::Plus => [p, q, r],
            num_bigint::Sign::Minus => [p, r, q],
        };
        Some(Face { corners, reach })
    }

    fn clipped_to(&self, square: &Square) -> Option<Piece> {
        let [p, q, r] = &self.corners;
        let mut polygon = vec![
            (p.clone(), Line::through(p, q)),
            (q.clone(), Line::through(q, r)),
            (r.clone(), Line::through(r, p)),
        ];
        for half_plane in square.half_planes() {
            polygon = clip(&polygon, &half_plane);
            if polygon.len() < 3 {
                return None;
            }
        }
        let piece = Piece { polygon };
        (piece.doubled_area().sign() == Ordering::Greater).then_some(piece)
    }
}

struct Level {
    faces: Vec<Face>,
    unresolved: Vec<[f64; 4]>,
}

impl Level {
    fn at(
        triangles: &[Triangle],
        exact: &dyn Fn(usize) -> Option<ExactCorners>,
        height: &Exact,
    ) -> Level {
        let float_height = height.to_f64();
        let mut faces = Vec::new();
        let mut unresolved = Vec::new();
        for (index, triangle) in triangles.iter().enumerate() {
            let near = triangle
                .points
                .iter()
                .all(|p| (p[1] - float_height).abs() <= IDENTIFY_LDU);
            if !near {
                continue;
            }
            let reach = reach(&triangle.points);
            let Some(corners) = exact(index) else {
                unresolved.push(reach);
                continue;
            };
            if corners.iter().any(|corner| corner[1] != *height) {
                continue;
            }
            faces.extend(Face::counter_clockwise(corners.map(Point::plan), reach));
        }
        Level { faces, unresolved }
    }

    fn coverage(&self, square: &Square) -> Coverage {
        let pieces: Vec<Piece> = self
            .faces
            .iter()
            .filter(|face| square.meets(&face.reach))
            .filter_map(|face| face.clipped_to(square))
            .collect();
        let covered = pieces.iter().fold(Fraction::zero(), |sum, piece| {
            sum.add(&piece.doubled_area())
        });
        match covered.compare(&square.doubled_area()) {
            Ordering::Greater => Coverage::Undecided,
            Ordering::Equal if any_overlap(&pieces) => Coverage::Undecided,
            Ordering::Equal => Coverage::Full,
            Ordering::Less if self.unresolved.iter().any(|r| square.meets(r)) => {
                Coverage::Undecided
            }
            Ordering::Less => Coverage::Partial,
        }
    }
}

#[derive(Clone, Debug)]
struct Point {
    x: BigInt,
    z: BigInt,
    w: BigInt,
}

impl Point {
    fn plan(corner: ExactVec3) -> Point {
        let [x, _, z] = corner;
        let (x_units, x_places) = x.units_and_places();
        let (z_units, z_places) = z.units_and_places();
        let places = x_places.max(z_places);
        let ten = BigInt::from(10);
        Point {
            x: x_units * ten.pow(places - x_places),
            z: z_units * ten.pow(places - z_places),
            w: ten.pow(places),
        }
    }
}

#[derive(Clone, Debug)]
struct Line {
    a: BigInt,
    b: BigInt,
    d: BigInt,
}

impl Line {
    fn through(p: &Point, q: &Point) -> Line {
        Line {
            a: &p.z * &q.w - &p.w * &q.z,
            b: &p.w * &q.x - &p.x * &q.w,
            d: &p.x * &q.z - &p.z * &q.x,
        }
    }

    fn value(&self, point: &Point) -> BigInt {
        &self.a * &point.x + &self.b * &point.z + &self.d * &point.w
    }

    fn keeps(&self, point: &Point) -> bool {
        self.value(point).sign() != num_bigint::Sign::Minus
    }

    fn meet(&self, other: &Line) -> Point {
        let x = &self.b * &other.d - &self.d * &other.b;
        let z = &self.d * &other.a - &self.a * &other.d;
        let w = &self.a * &other.b - &self.b * &other.a;
        if w.sign() == num_bigint::Sign::Minus {
            Point {
                x: -x,
                z: -z,
                w: -w,
            }
        } else {
            Point { x, z, w }
        }
    }
}

fn clip(polygon: &[(Point, Line)], half_plane: &Line) -> Vec<(Point, Line)> {
    let mut out = Vec::with_capacity(polygon.len() + 1);
    for (i, (current, edge)) in polygon.iter().enumerate() {
        let (next, _) = &polygon[(i + 1) % polygon.len()];
        let current_kept = half_plane.keeps(current);
        let next_kept = half_plane.keeps(next);
        if current_kept {
            out.push((current.clone(), edge.clone()));
        }
        if current_kept && !next_kept {
            out.push((edge.meet(half_plane), half_plane.clone()));
        }
        if !current_kept && next_kept {
            out.push((edge.meet(half_plane), edge.clone()));
        }
    }
    out
}

struct Piece {
    polygon: Vec<(Point, Line)>,
}

impl Piece {
    fn doubled_area(&self) -> Fraction {
        let mut area = Fraction::zero();
        for (i, (p, _)) in self.polygon.iter().enumerate() {
            let (q, _) = &self.polygon[(i + 1) % self.polygon.len()];
            area = area.add(&Fraction::new(&p.x * &q.z - &q.x * &p.z, &p.w * &q.w));
        }
        area
    }

    fn separates(&self, other: &Piece) -> bool {
        self.polygon.iter().any(|(_, line)| {
            other
                .polygon
                .iter()
                .all(|(point, _)| line.value(point).sign() != num_bigint::Sign::Plus)
        })
    }
}

fn any_overlap(pieces: &[Piece]) -> bool {
    pieces.iter().enumerate().any(|(i, piece)| {
        pieces[i + 1..]
            .iter()
            .any(|other| !piece.separates(other) && !other.separates(piece))
    })
}

#[derive(Clone, Debug)]
struct Fraction {
    numerator: BigInt,
    denominator: BigInt,
}

fn greatest_common_divisor(a: &BigInt, b: &BigInt) -> BigUint {
    let mut x = a.magnitude().clone();
    let mut y = b.magnitude().clone();
    let zero = BigUint::from(0u32);
    while y != zero {
        let remainder = &x % &y;
        x = y;
        y = remainder;
    }
    x
}

impl Fraction {
    fn zero() -> Fraction {
        Fraction {
            numerator: BigInt::from(0),
            denominator: BigInt::from(1),
        }
    }

    fn new(numerator: BigInt, denominator: BigInt) -> Fraction {
        let divisor = BigInt::from(greatest_common_divisor(&numerator, &denominator));
        Fraction {
            numerator: numerator / &divisor,
            denominator: denominator / divisor,
        }
    }

    fn add(&self, other: &Fraction) -> Fraction {
        Fraction::new(
            &self.numerator * &other.denominator + &other.numerator * &self.denominator,
            &self.denominator * &other.denominator,
        )
    }

    fn sign(&self) -> Ordering {
        self.numerator.cmp(&BigInt::from(0))
    }

    fn compare(&self, other: &Fraction) -> Ordering {
        (&self.numerator * &other.denominator).cmp(&(&other.numerator * &self.denominator))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trig::{cos, sin};

    const STUD: f64 = 20.0;

    fn triangle(points: [Vec3; 3]) -> Triangle {
        Triangle {
            color: 16,
            points,
            double_sided: false,
        }
    }

    fn quad(y: f64, [x0, z0, x1, z1]: [f64; 4]) -> [Triangle; 2] {
        [
            triangle([[x0, y, z0], [x1, y, z0], [x1, y, z1]]),
            triangle([[x0, y, z0], [x1, y, z1], [x0, y, z1]]),
        ]
    }

    fn base(y: f64, [x0, z0, x1, z1]: [f64; 4]) -> Triangle {
        triangle([[x0, y, z0], [x1, y, z0], [x0, y, z1]])
    }

    fn upright_stud(x: f64, y: f64, z: f64) -> StudReference {
        StudReference {
            primitive: "stud.dat".to_string(),
            color: 16,
            matrix: Affine {
                m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z],
            },
        }
    }

    fn surface(triangles: &[Triangle], studs: &[StudReference]) -> Option<TopSurface> {
        let exact = |index: usize| {
            triangles
                .get(index)
                .map(|t| t.points.map(|p| p.map(Exact::from_f64)))
        };
        TopSurface::read(triangles, &exact, studs)
    }

    fn rows(triangles: &[Triangle], studs: &[StudReference]) -> Vec<String> {
        surface(triangles, studs)
            .expect("the part has a whole-stud plan")
            .rows_text()
    }

    #[test]
    fn a_top_face_split_on_any_diagonal_covers_every_cell_it_spans() {
        let mut part = quad(0.0, [-40.0, -20.0, 40.0, 20.0]).to_vec();
        part.push(base(-8.0, [-40.0, -20.0, 40.0, 20.0]));
        assert_eq!(rows(&part, &[]), ["ffff", "ffff"]);
    }

    #[test]
    fn a_slope_is_flat_only_where_its_top_face_reaches() {
        let part = [
            quad(24.0, [-10.0, -20.0, 10.0, 0.0]).to_vec(),
            vec![
                triangle([[-10.0, 24.0, 0.0], [10.0, 24.0, 0.0], [10.0, 4.0, 20.0]]),
                triangle([[-10.0, 24.0, 0.0], [10.0, 4.0, 20.0], [-10.0, 4.0, 20.0]]),
                base(0.0, [-10.0, -20.0, 10.0, 20.0]),
            ],
        ]
        .concat();
        assert_eq!(rows(&part, &[]), ["f", "."]);
    }

    #[test]
    fn a_round_top_covers_no_cell_whole() {
        let segments = 16;
        let mut part: Vec<Triangle> = (0..segments)
            .map(|k| {
                let at = |k: i32| {
                    let angle = std::f64::consts::TAU * f64::from(k) / f64::from(segments);
                    [STUD * cos(angle), 8.0, STUD * sin(angle)]
                };
                triangle([[0.0, 8.0, 0.0], at(k), at(k + 1)])
            })
            .collect();
        part.push(base(0.0, [-20.0, -20.0, 20.0, 20.0]));
        assert_eq!(rows(&part, &[]), ["..", ".."]);
    }

    #[test]
    fn a_face_with_no_exact_geometry_leaves_what_it_might_cover_undecided() {
        let mut part = quad(0.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(0.0, [0.0, -10.0, 20.0, 10.0]));
        part.push(base(-8.0, [-20.0, -10.0, 20.0, 10.0]));
        let exact = |index: usize| {
            (index != 2)
                .then(|| {
                    part.get(index)
                        .map(|t| t.points.map(|p| p.map(Exact::from_f64)))
                })
                .flatten()
        };
        let surface = TopSurface::read(&part, &exact, &[]).expect("whole-stud plan");
        assert_eq!(surface.rows_text(), ["fu"]);
    }

    #[test]
    fn coplanar_top_faces_that_overlap_leave_the_cell_undecided() {
        let mut part = quad(0.0, [-10.0, -10.0, 10.0, 10.0]).to_vec();
        part.push(triangle([
            [-10.0, 0.0, -10.0],
            [10.0, 0.0, -10.0],
            [-10.0, 0.0, 10.0],
        ]));
        part.push(base(-8.0, [-10.0, -10.0, 10.0, 10.0]));
        assert_eq!(rows(&part, &[]), ["u"]);
    }

    #[test]
    fn a_gap_in_the_top_face_leaves_its_cell_open() {
        let mut part = quad(0.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(0.0, [0.0, -10.0, 20.0, 0.0]));
        part.push(base(-8.0, [-20.0, -10.0, 20.0, 10.0]));
        assert_eq!(rows(&part, &[]), ["f."]);
    }

    #[test]
    fn a_stud_on_a_floor_walled_by_the_top_face_is_a_pocket() {
        let mut part = Vec::new();
        for strip in [[-30.0, -30.0, 30.0, -10.0], [-30.0, 10.0, 30.0, 30.0]] {
            part.extend(quad(16.0, strip));
        }
        part.extend(quad(16.0, [-30.0, -10.0, -10.0, 10.0]));
        part.extend(quad(16.0, [10.0, -10.0, 30.0, 10.0]));
        part.extend(quad(8.0, [-10.0, -10.0, 10.0, 10.0]));
        part.push(base(0.0, [-30.0, -30.0, 30.0, 30.0]));
        let studs = [upright_stud(0.0, 8.0, 0.0)];
        assert_eq!(rows(&part, &studs), ["fff", "fpf", "fff"]);
    }

    #[test]
    fn a_recess_open_at_the_part_edge_is_still_a_pocket() {
        let mut part = quad(16.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(8.0, [0.0, -10.0, 20.0, 10.0]));
        part.push(base(0.0, [-20.0, -10.0, 20.0, 10.0]));
        let studs = [upright_stud(10.0, 8.0, 0.0)];
        assert_eq!(rows(&part, &studs), ["fp"]);
    }

    #[test]
    fn a_stud_beside_something_that_is_not_a_flat_top_is_no_pocket() {
        let mut part = quad(8.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.push(triangle([
            [0.0, 8.0, -10.0],
            [20.0, 16.0, -10.0],
            [20.0, 16.0, 10.0],
        ]));
        part.push(triangle([
            [0.0, 8.0, -10.0],
            [20.0, 16.0, 10.0],
            [0.0, 8.0, 10.0],
        ]));
        part.push(base(0.0, [-20.0, -10.0, 20.0, 10.0]));
        let studs = [upright_stud(-10.0, 8.0, 0.0)];
        assert_eq!(rows(&part, &studs), [".."]);
    }

    #[test]
    fn a_stud_off_the_cell_centres_makes_no_pocket() {
        let mut part = quad(16.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(8.0, [0.0, -10.0, 20.0, 10.0]));
        part.push(base(0.0, [-20.0, -10.0, 20.0, 10.0]));
        let studs = [upright_stud(0.0, 8.0, 0.0)];
        assert_eq!(rows(&part, &studs), ["f."]);
    }

    #[test]
    fn a_recess_floor_with_a_hole_in_it_still_holds_a_pocket() {
        let mut part = quad(16.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(8.0, [0.0, -10.0, 20.0, 0.0]));
        part.push(base(0.0, [-20.0, -10.0, 20.0, 10.0]));
        let studs = [upright_stud(10.0, 8.0, 0.0)];
        assert_eq!(rows(&part, &studs), ["fp"]);
    }

    #[test]
    fn a_plan_that_is_not_whole_studs_has_no_top_surface() {
        let mut part = quad(0.0, [-10.0, -10.0, 15.0, 10.0]).to_vec();
        part.push(base(-8.0, [-10.0, -10.0, 15.0, 10.0]));
        assert_eq!(surface(&part, &[]), None);
    }

    #[test]
    fn the_record_carries_the_top_and_origin_in_sixteenths() {
        let mut part = quad(4.5, [-20.0, -10.0, 20.0, 10.0]).to_vec();
        part.push(base(0.0, [-20.0, -10.0, 20.0, 10.0]));
        let surface = surface(&part, &[]).expect("whole-stud plan");
        assert_eq!(
            surface.to_json(),
            json!({
                "stepsPerLdu": 16,
                "top": 72,
                "origin": [-320, -160],
                "size": [2, 1],
                "cells": ["ff"],
            })
        );
    }
}
