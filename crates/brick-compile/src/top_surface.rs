use std::cmp::Ordering;
use std::collections::VecDeque;

use num_bigint::BigInt;
use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::exact::{Exact, ExactVec3};
use crate::flatten::{StudReference, Triangle};
use crate::identify::{
    identifies, sixteenths, IDENTIFY_LDU, IDENTIFY_TEN_THOUSANDTHS, SIXTEENTHS_PER_LDU,
    TEN_THOUSANDTHS_PER_LDU,
};
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
        let corners: Vec<Option<ExactCorners>> = (0..triangles.len()).map(exact).collect();
        let top = highest(triangles, &corners)?;
        if sixteenths(top.to_f64()) != Some(grid.top) {
            return None;
        }
        let level = Level::at(triangles, &corners, &top);
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

    fn walled_end(
        &self,
        cell: usize,
        step: [i64; 2],
        recessed: &[bool],
        cells: &[TopCell],
    ) -> bool {
        let mut at = cell;
        loop {
            match self.neighbour(at, step) {
                None => return false,
                Some(next) if recessed[next] => at = next,
                Some(next) => return cells[next] == TopCell::Flat,
            }
        }
    }

    fn walled_across(&self, cell: usize, recessed: &[bool], cells: &[TopCell]) -> bool {
        [[1, 0], [0, 1]].into_iter().any(|[dx, dz]| {
            self.walled_end(cell, [dx, dz], recessed, cells)
                && self.walled_end(cell, [-dx, -dz], recessed, cells)
        })
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
                enclosed &= self.walled_across(cell, recessed, cells);
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
    fn region(&self) -> Region {
        let corner = |x: i64, z: i64| Point {
            x: BigInt::from(x),
            z: BigInt::from(z),
            w: BigInt::from(SIXTEENTHS_PER_LDU),
        };
        let corners = [
            corner(self.low[0], self.low[1]),
            corner(self.high[0], self.low[1]),
            corner(self.high[0], self.high[1]),
            corner(self.low[0], self.high[1]),
        ];
        Region {
            polygon: (0..corners.len())
                .map(|i| {
                    let next = &corners[(i + 1) % corners.len()];
                    (corners[i].clone(), Line::through(&corners[i], next))
                })
                .collect(),
            bounds: [self.low[0], self.low[1], self.high[0], self.high[1]],
        }
    }

    fn meets(&self, bounds: &[i64; 4]) -> bool {
        bounds[0] < self.high[0]
            && bounds[2] > self.low[0]
            && bounds[1] < self.high[1]
            && bounds[3] > self.low[1]
    }

    fn may_meet(&self, reach: &[f64; 4]) -> bool {
        let per_ldu = f64::from(SIXTEENTHS_PER_LDU);
        let low = self.low.map(|v| v as f64 / per_ldu);
        let high = self.high.map(|v| v as f64 / per_ldu);
        reach[0] < high[0] && reach[2] > low[0] && reach[1] < high[1] && reach[3] > low[1]
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

fn highest(triangles: &[Triangle], corners: &[Option<ExactCorners>]) -> Option<Exact> {
    let top = corners
        .iter()
        .flatten()
        .flat_map(|corners| corners.iter().map(|corner| &corner[1]))
        .max_by(|a, b| a.compare(b))?
        .clone();
    let float_top = top.to_f64();
    let unread_above = triangles
        .iter()
        .zip(corners)
        .filter(|(_, corners)| corners.is_none())
        .any(|(triangle, _)| {
            triangle
                .points
                .iter()
                .any(|p| p[1] > float_top && !identifies(p[1] - float_top))
        });
    (!unread_above).then_some(top)
}

fn sixteenths_rounded(value: &Exact, toward_ceiling: bool) -> Option<i64> {
    let (units, places) = value.units_and_places();
    sixteenths_of(&units, &BigInt::from(10).pow(places), toward_ceiling)
}

fn sixteenths_of(numerator: &BigInt, denominator: &BigInt, toward_ceiling: bool) -> Option<i64> {
    let numerator = numerator * BigInt::from(SIXTEENTHS_PER_LDU);
    let quotient = &numerator / denominator;
    let remainder = &numerator % denominator;
    let adjusted = match (remainder.sign(), toward_ceiling) {
        (num_bigint::Sign::Plus, true) => quotient + 1,
        (num_bigint::Sign::Minus, false) => quotient - 1,
        _ => quotient,
    };
    i64::try_from(&adjusted).ok()
}

fn plan_bounds(corners: &ExactCorners) -> Option<[i64; 4]> {
    let mut bounds = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
    for corner in corners {
        for (slot, axis) in [(0, 0), (1, 2)] {
            bounds[slot] = bounds[slot].min(sixteenths_rounded(&corner[axis], false)? - 1);
            bounds[slot + 2] = bounds[slot + 2].max(sixteenths_rounded(&corner[axis], true)? + 1);
        }
    }
    Some(bounds)
}

fn bounds_meet(a: &[i64; 4], b: &[i64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

struct Face {
    bounds: [i64; 4],
    extent: f64,
    edges: [Line; 3],
    grown: Vec<Line>,
}

impl Face {
    fn new(corners: &ExactCorners, bounds: [i64; 4], extent: f64) -> Option<Face> {
        let [p, q, r] = corners.clone().map(Point::plan);
        let corners = match Line::through(&p, &q).value(&r).sign() {
            num_bigint::Sign::NoSign => return None,
            num_bigint::Sign::Plus => [p, q, r],
            num_bigint::Sign::Minus => [p, r, q],
        };
        let [p, q, r] = &corners;
        Some(Face {
            bounds,
            extent,
            edges: [
                Line::through(p, q),
                Line::through(q, r),
                Line::through(r, p),
            ],
            grown: grown_by_identification(&corners),
        })
    }
}

fn grown_by_identification(corners: &[Point; 3]) -> Vec<Line> {
    let scale = BigInt::from(TEN_THOUSANDTHS_PER_LDU);
    let residual = BigInt::from(IDENTIFY_TEN_THOUSANDTHS);
    let [p, q, r] = corners;
    let mut lines: Vec<Line> = [(p, q), (q, r), (r, p)]
        .into_iter()
        .map(|(from, to)| {
            let edge = Line::through(from, to);
            let reach = edge.a.magnitude() + edge.b.magnitude();
            Line {
                a: &scale * &edge.a,
                b: &scale * &edge.b,
                d: &scale * &edge.d + &residual * BigInt::from(reach),
            }
        })
        .collect();
    let extreme = |along: fn(&Point) -> &BigInt, lowest: bool| {
        corners
            .iter()
            .reduce(|best, corner| {
                let order = (along(corner) * &best.w).cmp(&(along(best) * &corner.w));
                let better = if lowest {
                    order == Ordering::Less
                } else {
                    order == Ordering::Greater
                };
                if better {
                    corner
                } else {
                    best
                }
            })
            .unwrap_or(p)
    };
    for (along, x_axis) in [
        (Point::x_of as fn(&Point) -> &BigInt, true),
        (Point::z_of, false),
    ] {
        for lowest in [true, false] {
            let corner = extreme(along, lowest);
            let side = if lowest {
                BigInt::from(1)
            } else {
                BigInt::from(-1)
            };
            let normal = &side * &scale * &corner.w;
            let offset = -(&side * &scale * along(corner)) + &residual * &corner.w;
            lines.push(if x_axis {
                Line {
                    a: normal,
                    b: BigInt::from(0),
                    d: offset,
                }
            } else {
                Line {
                    a: BigInt::from(0),
                    b: normal,
                    d: offset,
                }
            });
        }
    }
    lines
}

fn plan_extent(points: &[Vec3; 3]) -> f64 {
    let [p, q, r] = points;
    ((q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0])).abs()
}

struct Level {
    faces: Vec<Face>,
    unresolved: Vec<[f64; 4]>,
}

impl Level {
    fn at(triangles: &[Triangle], corners: &[Option<ExactCorners>], height: &Exact) -> Level {
        let float_height = height.to_f64();
        let mut faces = Vec::new();
        let mut unresolved = Vec::new();
        for (triangle, corners) in triangles.iter().zip(corners) {
            match corners {
                Some(corners) => {
                    if corners.iter().all(|corner| corner[1] == *height) {
                        match plan_bounds(corners) {
                            Some(bounds) => faces.extend(Face::new(
                                corners,
                                bounds,
                                plan_extent(&triangle.points),
                            )),
                            None => unresolved.push(reach(&triangle.points)),
                        }
                    }
                }
                None => {
                    if triangle
                        .points
                        .iter()
                        .all(|p| identifies(p[1] - float_height))
                    {
                        unresolved.push(reach(&triangle.points));
                    }
                }
            }
        }
        Level { faces, unresolved }
    }

    fn coverage(&self, square: &Square) -> Coverage {
        let mut faces: Vec<&Face> = self
            .faces
            .iter()
            .filter(|face| square.meets(&face.bounds))
            .collect();
        faces.sort_by(|a, b| b.extent.total_cmp(&a.extent));
        let mut uncovered = vec![square.region()];
        let passes: [fn(&Face) -> &[Line]; 2] = [|face| &face.edges, |face| &face.grown];
        for lines_of in passes {
            for face in &faces {
                uncovered = uncovered
                    .into_iter()
                    .flat_map(|region| {
                        if bounds_meet(&region.bounds, &face.bounds) {
                            region.without(lines_of(face))
                        } else {
                            vec![region]
                        }
                    })
                    .collect();
                if uncovered.is_empty() {
                    return Coverage::Full;
                }
            }
        }
        if self.unresolved.iter().any(|reach| square.may_meet(reach)) {
            Coverage::Undecided
        } else {
            Coverage::Partial
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
    fn x_of(&self) -> &BigInt {
        &self.x
    }

    fn z_of(&self) -> &BigInt {
        &self.z
    }

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

    fn reversed(&self) -> Line {
        Line {
            a: -&self.a,
            b: -&self.b,
            d: -&self.d,
        }
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

struct Region {
    polygon: Vec<(Point, Line)>,
    bounds: [i64; 4],
}

impl Region {
    fn of(polygon: Vec<(Point, Line)>) -> Option<Region> {
        if !has_area(&polygon) {
            return None;
        }
        let mut bounds = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
        for (point, _) in &polygon {
            for (slot, coordinate) in [(0, &point.x), (1, &point.z)] {
                bounds[slot] = bounds[slot].min(sixteenths_of(coordinate, &point.w, false)?);
                bounds[slot + 2] = bounds[slot + 2].max(sixteenths_of(coordinate, &point.w, true)?);
            }
        }
        Some(Region { polygon, bounds })
    }

    fn without(self, lines: &[Line]) -> Vec<Region> {
        let mut inside = self.polygon;
        let mut outside = Vec::new();
        for line in lines {
            outside.extend(Region::of(clip(&inside, &line.reversed())));
            inside = clip(&inside, line);
            if !has_area(&inside) {
                break;
            }
        }
        outside
    }
}

fn has_area(polygon: &[(Point, Line)]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut doubled = BigInt::from(0);
    for (i, (p, _)) in polygon.iter().enumerate() {
        let j = (i + 1) % polygon.len();
        let q = &polygon[j].0;
        let mut term = &p.x * &q.z - &q.x * &p.z;
        for (k, (other, _)) in polygon.iter().enumerate() {
            if k != i && k != j {
                term *= &other.w;
            }
        }
        doubled += term;
    }
    doubled.sign() == num_bigint::Sign::Plus
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
    fn coplanar_top_faces_that_overlap_still_cover_the_cell() {
        let mut part = quad(0.0, [-10.0, -10.0, 10.0, 10.0]).to_vec();
        part.push(triangle([
            [-10.0, 0.0, -10.0],
            [10.0, 0.0, -10.0],
            [-10.0, 0.0, 10.0],
        ]));
        part.push(base(-8.0, [-10.0, -10.0, 10.0, 10.0]));
        assert_eq!(rows(&part, &[]), ["f"]);
    }

    #[test]
    fn coplanar_top_faces_that_overlap_and_leave_a_gap_leave_the_cell_open() {
        let part = [
            triangle([[-10.0, 0.0, -10.0], [10.0, 0.0, -10.0], [-10.0, 0.0, 10.0]]),
            triangle([[-10.0, 0.0, -10.0], [10.0, 0.0, -10.0], [0.0, 0.0, 10.0]]),
            triangle([[10.0, 0.0, -10.0], [9.0, 0.0, 10.0], [-9.0, 0.0, 10.0]]),
            base(-8.0, [-10.0, -10.0, 10.0, 10.0]),
        ];
        assert_eq!(rows(&part, &[]), ["."]);
    }

    fn split_with_a_gap(gap: f64) -> Vec<Triangle> {
        let mut part = quad(0.0, [-10.0, -10.0, -gap, 10.0]).to_vec();
        part.extend(quad(0.0, [0.0, -10.0, 10.0, 10.0]));
        part.push(base(-8.0, [-10.0, -10.0, 10.0, 10.0]));
        part
    }

    #[test]
    fn top_faces_that_miss_each_other_within_the_identification_residual_cover_the_cell() {
        assert_eq!(rows(&split_with_a_gap(0.0003), &[]), ["f"]);
        assert_eq!(rows(&split_with_a_gap(0.0009), &[]), ["f"]);
    }

    #[test]
    fn a_gap_wider_than_the_identification_residual_leaves_the_cell_open() {
        assert_eq!(rows(&split_with_a_gap(0.0011), &[]), ["."]);
    }

    #[test]
    fn a_gap_in_the_top_face_leaves_its_cell_open() {
        let mut part = quad(0.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(0.0, [0.0, -10.0, 20.0, 0.0]));
        part.push(base(-8.0, [-20.0, -10.0, 20.0, 10.0]));
        assert_eq!(rows(&part, &[]), ["f."]);
    }

    fn edge_strip(floor: [f64; 4]) -> Vec<Triangle> {
        let mut part = quad(16.0, [-30.0, -20.0, -10.0, 0.0]).to_vec();
        part.extend(quad(16.0, [10.0, -20.0, 30.0, 0.0]));
        part.extend(quad(16.0, [-30.0, 0.0, 30.0, 20.0]));
        part.extend(quad(8.0, floor));
        part.push(base(0.0, [-30.0, -20.0, 30.0, 20.0]));
        part
    }

    #[test]
    fn a_recess_open_at_the_part_edge_between_flat_cells_is_a_pocket() {
        let part = edge_strip([-10.0, -20.0, 10.0, 0.0]);
        let studs = [upright_stud(0.0, 8.0, -10.0)];
        assert_eq!(rows(&part, &studs), ["fpf", "fff"]);
    }

    #[test]
    fn a_lower_step_across_the_part_is_a_terrace_not_a_pocket() {
        let mut part = quad(16.0, [-20.0, 0.0, 20.0, 20.0]).to_vec();
        part.extend(quad(8.0, [-20.0, -20.0, 20.0, 0.0]));
        part.push(base(0.0, [-20.0, -20.0, 20.0, 20.0]));
        let studs = [
            upright_stud(-10.0, 8.0, -10.0),
            upright_stud(10.0, 8.0, -10.0),
        ];
        assert_eq!(rows(&part, &studs), ["..", "ff"]);
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
        let part = edge_strip([-10.0, -20.0, 10.0, -10.0]);
        let studs = [upright_stud(0.0, 8.0, -10.0)];
        assert_eq!(rows(&part, &studs), ["fpf", "fff"]);
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
