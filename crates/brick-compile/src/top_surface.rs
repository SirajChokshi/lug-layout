use std::cell::OnceCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, VecDeque};

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

struct Probe {
    point: Point,
    spot: [f64; 2],
}

fn reaches(reach: &[f64; 4], low: [f64; 2], high: [f64; 2]) -> bool {
    reach[0] <= high[0] && reach[2] >= low[0] && reach[1] <= high[1] && reach[3] >= low[1]
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

    fn probes(&self) -> [Probe; 5] {
        let probe = |x: i64, z: i64, w: i64| Probe {
            point: Point {
                x: BigInt::from(x),
                z: BigInt::from(z),
                w: BigInt::from(w),
            },
            spot: [x as f64 / w as f64, z as f64 / w as f64],
        };
        let w = i64::from(SIXTEENTHS_PER_LDU);
        [
            probe(self.low[0], self.low[1], w),
            probe(self.high[0], self.low[1], w),
            probe(self.high[0], self.high[1], w),
            probe(self.low[0], self.high[1], w),
            probe(
                self.low[0] + self.high[0],
                self.low[1] + self.high[1],
                2 * w,
            ),
        ]
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

type SmallLine = [i128; 3];

fn small_line(line: &Line) -> Option<SmallLine> {
    Some([
        i128::try_from(&line.a).ok()?,
        i128::try_from(&line.b).ok()?,
        i128::try_from(&line.d).ok()?,
    ])
}

fn small_value([a, b, d]: SmallLine, x: i64, z: i64, w: i64) -> Option<i128> {
    a.checked_mul(i128::from(x))?
        .checked_add(b.checked_mul(i128::from(z))?)?
        .checked_add(d.checked_mul(i128::from(w))?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Facing {
    Up,
    Down,
    Either,
}

struct PlanTriangle {
    corners: [Point; 3],
    edges: [Line; 3],
    bounds: [i64; 4],
}

impl PlanTriangle {
    fn of(corners: &ExactCorners, bounds: [i64; 4]) -> Option<(PlanTriangle, Facing)> {
        let [p, q, r] = corners.clone().map(Point::plan);
        let (corners, facing) = match Line::through(&p, &q).value(&r).sign() {
            num_bigint::Sign::NoSign => return None,
            num_bigint::Sign::Plus => ([p, q, r], Facing::Down),
            num_bigint::Sign::Minus => ([p, r, q], Facing::Up),
        };
        let [p, q, r] = &corners;
        let edges = [
            Line::through(p, q),
            Line::through(q, r),
            Line::through(r, p),
        ];
        Some((
            PlanTriangle {
                corners,
                edges,
                bounds,
            },
            facing,
        ))
    }

    fn holds(&self, point: &Point) -> bool {
        self.edges.iter().all(|edge| edge.keeps(point))
    }

    fn cut(&self) -> Cut<'_> {
        Cut {
            bounds: &self.bounds,
            lines: &self.edges,
        }
    }

    fn overlaps(&self, region: &Region) -> bool {
        if !bounds_meet(&region.bounds, &self.bounds) {
            return false;
        }
        let mut shared = region.polygon.clone();
        for edge in &self.edges {
            shared = clip(&shared, edge);
            if !has_area(&shared) {
                return false;
            }
        }
        true
    }
}

struct Cut<'a> {
    bounds: &'a [i64; 4],
    lines: &'a [Line],
}

struct Face {
    plan: PlanTriangle,
    extent: f64,
    small_edges: Option<[SmallLine; 3]>,
    grown: Vec<Line>,
}

impl Face {
    fn new(plan: PlanTriangle, extent: f64) -> Face {
        let [first, second, third] = &plan.edges;
        let small_edges = match (small_line(first), small_line(second), small_line(third)) {
            (Some(first), Some(second), Some(third)) => Some([first, second, third]),
            _ => None,
        };
        let grown = grown_by_identification(&plan.corners);
        Face {
            plan,
            extent,
            small_edges,
            grown,
        }
    }

    fn contains(&self, square: &Square) -> bool {
        let Some(edges) = self.small_edges else {
            return false;
        };
        let corners = [
            (square.low[0], square.low[1]),
            (square.high[0], square.low[1]),
            (square.high[0], square.high[1]),
            (square.low[0], square.high[1]),
        ];
        corners.iter().all(|&(x, z)| {
            edges.iter().all(|&edge| {
                small_value(edge, x, z, i64::from(SIXTEENTHS_PER_LDU))
                    .is_some_and(|value| value >= 0)
            })
        })
    }

    fn grown_holds(&self, point: &Point) -> bool {
        self.grown.iter().all(|line| line.keeps(point))
    }

    fn grown_cut(&self) -> Cut<'_> {
        Cut {
            bounds: &self.plan.bounds,
            lines: &self.grown,
        }
    }

    fn holds_centre(&self, square: &Square) -> bool {
        let Some(edges) = self.small_edges else {
            return false;
        };
        let x = square.low[0] + square.high[0];
        let z = square.low[1] + square.high[1];
        edges.iter().all(|&edge| {
            small_value(edge, x, z, 2 * i64::from(SIXTEENTHS_PER_LDU))
                .is_some_and(|value| value >= 0)
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

fn gcd(a: &BigInt, b: &BigInt) -> BigInt {
    let zero = BigInt::from(0);
    let (mut a, mut b) = (a.magnitude().clone(), b.magnitude().clone());
    while b != num_bigint::BigUint::from(0u8) {
        let rest = &a % &b;
        a = b;
        b = rest;
    }
    BigInt::from(a).max(zero)
}

fn supporting_line(p: &Point, q: &Point) -> ((BigInt, BigInt, BigInt), i64) {
    let line = Line::through(p, q);
    let divisor = gcd(&gcd(&line.a, &line.b), &line.d);
    let (a, b, d) = (&line.a / &divisor, &line.b / &divisor, &line.d / &divisor);
    let leading = if a.sign() == num_bigint::Sign::NoSign {
        &b
    } else {
        &a
    };
    if leading.sign() == num_bigint::Sign::Minus {
        ((-a, -b, -d), -1)
    } else {
        ((a, b, d), 1)
    }
}

fn along(point: &Point, by_x: bool) -> &BigInt {
    if by_x {
        &point.x
    } else {
        &point.z
    }
}

fn order_along(p: &Point, q: &Point, by_x: bool) -> Ordering {
    (along(p, by_x) * &q.w).cmp(&(along(q, by_x) * &p.w))
}

struct Seam {
    bounds: [i64; 4],
    ends: [[i128; 3]; 2],
    line: SmallLine,
}

impl Seam {
    fn between(p: &Point, q: &Point) -> Option<Seam> {
        let small = |point: &Point| -> Option<[i128; 3]> {
            Some([
                i128::try_from(&point.x).ok()?,
                i128::try_from(&point.z).ok()?,
                i128::try_from(&point.w).ok()?,
            ])
        };
        let mut bounds = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
        for point in [p, q] {
            for (slot, coordinate) in [(0, &point.x), (1, &point.z)] {
                bounds[slot] = bounds[slot].min(sixteenths_of(coordinate, &point.w, false)? - 1);
                bounds[slot + 2] =
                    bounds[slot + 2].max(sixteenths_of(coordinate, &point.w, true)? + 1);
            }
        }
        Some(Seam {
            bounds,
            ends: [small(p)?, small(q)?],
            line: small_line(&Line::through(p, q))?,
        })
    }

    fn misses(&self, square: &Square) -> Option<bool> {
        let sixteenths = i128::from(SIXTEENTHS_PER_LDU);
        for axis in 0..2 {
            let mut at_or_below = true;
            let mut at_or_above = true;
            for end in &self.ends {
                let scaled = sixteenths.checked_mul(end[axis])?;
                at_or_below &= scaled <= i128::from(square.low[axis]).checked_mul(end[2])?;
                at_or_above &= scaled >= i128::from(square.high[axis]).checked_mul(end[2])?;
            }
            if at_or_below || at_or_above {
                return Some(true);
            }
        }
        let mut signs = [0i128; 4];
        for (sign, (x, z)) in signs.iter_mut().zip([
            (square.low[0], square.low[1]),
            (square.high[0], square.low[1]),
            (square.high[0], square.high[1]),
            (square.low[0], square.high[1]),
        ]) {
            *sign = small_value(self.line, x, z, i64::from(SIXTEENTHS_PER_LDU))?.signum();
        }
        Some(signs.iter().all(|&sign| sign >= 0) || signs.iter().all(|&sign| sign <= 0))
    }
}

struct SideEdge<'a> {
    from: &'a Point,
    to: &'a Point,
    side: i64,
}

fn unpaired_seams(faces: &[Face]) -> Option<Vec<Seam>> {
    let mut lines: BTreeMap<(BigInt, BigInt, BigInt), Vec<SideEdge>> = BTreeMap::new();
    for face in faces {
        let corners = &face.plan.corners;
        for i in 0..corners.len() {
            let (p, q) = (&corners[i], &corners[(i + 1) % corners.len()]);
            let (key, side) = supporting_line(p, q);
            lines.entry(key).or_default().push(SideEdge {
                from: p,
                to: q,
                side,
            });
        }
    }
    let mut seams = Vec::new();
    for ((_, b, _), edges) in &lines {
        let by_x = b.sign() != num_bigint::Sign::NoSign;
        let spans: Vec<(&Point, &Point, i64)> = edges
            .iter()
            .map(|edge| match order_along(edge.from, edge.to, by_x) {
                Ordering::Greater => (edge.to, edge.from, edge.side),
                _ => (edge.from, edge.to, edge.side),
            })
            .collect();
        let mut stops: Vec<&Point> = spans
            .iter()
            .flat_map(|&(low, high, _)| [low, high])
            .collect();
        stops.sort_by(|p, q| order_along(p, q, by_x));
        stops.dedup_by(|p, q| order_along(p, q, by_x) == Ordering::Equal);
        for pair in stops.windows(2) {
            let net: i64 = spans
                .iter()
                .filter(|&&(low, high, _)| {
                    order_along(low, pair[0], by_x) != Ordering::Greater
                        && order_along(high, pair[1], by_x) != Ordering::Less
                })
                .map(|&(_, _, side)| side)
                .sum();
            if net != 0 {
                seams.push(Seam::between(pair[0], pair[1])?);
            }
        }
    }
    Some(seams)
}

enum Shadow {
    EdgeOn,
    Seen(Box<PlanTriangle>, Facing),
    Unread,
}

struct View {
    shadow: Shadow,
    rising: Vec<[Point; 2]>,
}

struct FaceBelow<'a> {
    reach: [f64; 4],
    corners: Option<&'a ExactCorners>,
    at_top: [bool; 3],
    culled: bool,
    view: OnceCell<View>,
}

impl<'a> FaceBelow<'a> {
    fn new(
        triangle: &Triangle,
        corners: Option<&'a ExactCorners>,
        at_top: [bool; 3],
    ) -> FaceBelow<'a> {
        FaceBelow {
            reach: reach(&triangle.points),
            corners,
            at_top,
            culled: !triangle.double_sided,
            view: OnceCell::new(),
        }
    }

    fn view(&self) -> &View {
        self.view.get_or_init(|| View {
            shadow: self.shadow(),
            rising: self.rising(),
        })
    }

    fn shadow(&self) -> Shadow {
        let Some(corners) = self.corners else {
            return Shadow::Unread;
        };
        let Some(bounds) = plan_bounds(corners) else {
            return Shadow::Unread;
        };
        match PlanTriangle::of(corners, bounds) {
            None => Shadow::EdgeOn,
            Some((plan, facing)) if self.culled => Shadow::Seen(Box::new(plan), facing),
            Some((plan, _)) => Shadow::Seen(Box::new(plan), Facing::Either),
        }
    }

    fn rising(&self) -> Vec<[Point; 2]> {
        let Some(corners) = self.corners else {
            return Vec::new();
        };
        (0..corners.len())
            .map(|from| (from, (from + 1) % corners.len()))
            .filter(|&(from, to)| self.at_top[from] && self.at_top[to])
            .map(|(from, to)| [from, to].map(|corner| Point::plan(corners[corner].clone())))
            .collect()
    }
}

struct Underneath<'a> {
    faces: Vec<FaceBelow<'a>>,
}

impl Underneath<'_> {
    fn column(&self, square: &Square) -> Column<'_> {
        Column {
            faces: self
                .faces
                .iter()
                .filter(|face| square.may_meet(&face.reach))
                .collect(),
        }
    }
}

struct Column<'a> {
    faces: Vec<&'a FaceBelow<'a>>,
}

impl Column<'_> {
    fn views_reaching(&self, low: [f64; 2], high: [f64; 2]) -> impl Iterator<Item = &View> {
        self.faces
            .iter()
            .filter(move |face| reaches(&face.reach, low, high))
            .map(|face| face.view())
    }

    fn inside_at(&self, probe: &Probe) -> bool {
        let mut underside = false;
        for view in self.views_reaching(probe.spot, probe.spot) {
            match &view.shadow {
                Shadow::EdgeOn => {}
                Shadow::Unread => return false,
                Shadow::Seen(plan, Facing::Down) => underside |= plan.holds(&probe.point),
                Shadow::Seen(plan, Facing::Up | Facing::Either) => {
                    if plan.holds(&probe.point) {
                        return false;
                    }
                }
            }
        }
        underside
    }

    fn rises_into(&self, regions: &[Region]) -> bool {
        let [low, high] = span(regions);
        self.views_reaching(low, high)
            .flat_map(|view| &view.rising)
            .any(|edge| regions.iter().any(|region| region.shares_length_with(edge)))
    }

    fn inside(&self, regions: Vec<Region>) -> bool {
        let [low, high] = span(&regions);
        let mut undersides = Vec::new();
        for view in self.views_reaching(low, high) {
            match &view.shadow {
                Shadow::EdgeOn => {}
                Shadow::Unread => return false,
                Shadow::Seen(plan, Facing::Down) => undersides.push(plan.cut()),
                Shadow::Seen(plan, Facing::Up | Facing::Either) => {
                    if regions.iter().any(|region| plan.overlaps(region)) {
                        return false;
                    }
                }
            }
        }
        subtracted(regions, undersides).is_empty()
    }
}

fn span(regions: &[Region]) -> [[f64; 2]; 2] {
    let per_ldu = f64::from(SIXTEENTHS_PER_LDU);
    let mut span = [[f64::INFINITY; 2], [f64::NEG_INFINITY; 2]];
    for region in regions {
        for axis in 0..2 {
            span[0][axis] = span[0][axis].min(region.bounds[axis] as f64 / per_ldu);
            span[1][axis] = span[1][axis].max(region.bounds[axis + 2] as f64 / per_ldu);
        }
    }
    span
}

fn subtracted<'a>(
    mut regions: Vec<Region>,
    cuts: impl IntoIterator<Item = Cut<'a>>,
) -> Vec<Region> {
    for cut in cuts {
        regions = regions
            .into_iter()
            .flat_map(|region| {
                if bounds_meet(&region.bounds, cut.bounds) {
                    region.without(cut.lines)
                } else {
                    vec![region]
                }
            })
            .collect();
        if regions.is_empty() {
            break;
        }
    }
    regions
}

fn is_crack(square: &Square, faces: &[&Face], gap: Vec<Region>, column: &Column) -> bool {
    let cell = square.region();
    faces.iter().any(|face| face.plan.overlaps(&cell))
        && !column.rises_into(&gap)
        && column.inside(gap)
}

struct Level<'a> {
    faces: Vec<Face>,
    seams: Option<Vec<Seam>>,
    unresolved: Vec<[f64; 4]>,
    underneath: Underneath<'a>,
}

impl<'a> Level<'a> {
    fn at(
        triangles: &[Triangle],
        corners: &'a [Option<ExactCorners>],
        height: &Exact,
    ) -> Level<'a> {
        let float_height = height.to_f64();
        let mut faces = Vec::new();
        let mut unresolved = Vec::new();
        let mut below = Vec::new();
        for (triangle, corners) in triangles.iter().zip(corners) {
            match corners {
                Some(corners) => {
                    let at_top = corners.each_ref().map(|corner| corner[1] == *height);
                    if at_top == [true; 3] {
                        match plan_bounds(corners) {
                            Some(bounds) => {
                                faces.extend(PlanTriangle::of(corners, bounds).map(|(plan, _)| {
                                    Face::new(plan, plan_extent(&triangle.points))
                                }))
                            }
                            None => unresolved.push(reach(&triangle.points)),
                        }
                    } else {
                        below.push(FaceBelow::new(triangle, Some(corners), at_top));
                    }
                }
                None if triangle
                    .points
                    .iter()
                    .all(|p| identifies(p[1] - float_height)) =>
                {
                    unresolved.push(reach(&triangle.points));
                }
                None => below.push(FaceBelow::new(triangle, None, [false; 3])),
            }
        }
        let seams = unpaired_seams(&faces);
        Level {
            faces,
            seams,
            unresolved,
            underneath: Underneath { faces: below },
        }
    }

    fn coverage(&self, square: &Square) -> Coverage {
        let mut faces: Vec<&Face> = self
            .faces
            .iter()
            .filter(|face| square.meets(&face.plan.bounds))
            .collect();
        if faces.is_empty() {
            return self.short_of_full(square);
        }
        if faces.iter().any(|face| face.contains(square)) || self.seamless(square, &faces) {
            return Coverage::Full;
        }
        let beneath = OnceCell::new();
        let column = || beneath.get_or_init(|| self.underneath.column(square));
        if square.probes().iter().any(|probe| {
            !faces.iter().any(|face| face.grown_holds(&probe.point)) && !column().inside_at(probe)
        }) {
            return self.short_of_full(square);
        }
        faces.sort_by(|a, b| b.extent.total_cmp(&a.extent));
        let gap = subtracted(
            vec![square.region()],
            faces.iter().map(|face| face.plan.cut()),
        );
        if gap.is_empty()
            || subtracted(gap.clone(), faces.iter().map(|face| face.grown_cut())).is_empty()
        {
            return Coverage::Full;
        }
        if is_crack(square, &faces, gap, column()) {
            Coverage::Full
        } else {
            self.short_of_full(square)
        }
    }

    fn short_of_full(&self, square: &Square) -> Coverage {
        if self.unresolved.iter().any(|reach| square.may_meet(reach)) {
            Coverage::Undecided
        } else {
            Coverage::Partial
        }
    }

    fn seamless(&self, square: &Square, faces: &[&Face]) -> bool {
        let Some(seams) = &self.seams else {
            return false;
        };
        seams
            .iter()
            .filter(|seam| square.meets(&seam.bounds))
            .all(|seam| seam.misses(square) == Some(true))
            && faces.iter().any(|face| face.holds_centre(square))
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

struct Fraction {
    numerator: BigInt,
    denominator: BigInt,
}

impl Fraction {
    fn of(numerator: BigInt, positive_denominator: BigInt) -> Fraction {
        Fraction {
            numerator,
            denominator: positive_denominator,
        }
    }
}

impl Ord for Fraction {
    fn cmp(&self, other: &Fraction) -> Ordering {
        (&self.numerator * &other.denominator).cmp(&(&other.numerator * &self.denominator))
    }
}

impl PartialOrd for Fraction {
    fn partial_cmp(&self, other: &Fraction) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Fraction {
    fn eq(&self, other: &Fraction) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Fraction {}

#[derive(Clone)]
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

    fn shares_length_with(&self, [from, to]: &[Point; 2]) -> bool {
        let mut low = Fraction::of(BigInt::from(0), BigInt::from(1));
        let mut high = Fraction::of(BigInt::from(1), BigInt::from(1));
        for (_, edge) in &self.polygon {
            let start = edge.value(from) * &to.w;
            let end = edge.value(to) * &from.w;
            let rise = &end - &start;
            match rise.sign() {
                num_bigint::Sign::NoSign => {
                    if start.sign() == num_bigint::Sign::Minus {
                        return false;
                    }
                }
                num_bigint::Sign::Plus => low = low.max(Fraction::of(-start, rise)),
                num_bigint::Sign::Minus => high = high.min(Fraction::of(start, -rise)),
            }
        }
        low < high
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
    use crate::exact::Decimal;
    use crate::trig::{cos, sin};

    const STUD: f64 = 20.0;
    const CELL_PLAN: [f64; 4] = [-10.0, -10.0, 10.0, 10.0];
    const SLITS: [[f64; 2]; 4] = [
        [-0.00055, 0.00055],
        [3.0, 3.0011],
        [-0.0085, 0.0085],
        [3.0, 3.017],
    ];

    fn triangle(points: [Vec3; 3]) -> Triangle {
        Triangle {
            color: 16,
            points,
            double_sided: false,
        }
    }

    fn plan_turn([p, q, r]: &[Vec3; 3]) -> f64 {
        (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2])
    }

    fn up(points: [Vec3; 3]) -> Triangle {
        let [p, q, r] = points;
        triangle(if plan_turn(&points) > 0.0 {
            points
        } else {
            [p, r, q]
        })
    }

    fn down(points: [Vec3; 3]) -> Triangle {
        let [p, q, r] = points;
        triangle(if plan_turn(&points) < 0.0 {
            points
        } else {
            [p, r, q]
        })
    }

    fn quad(y: f64, [x0, z0, x1, z1]: [f64; 4]) -> [Triangle; 2] {
        [
            up([[x0, y, z0], [x1, y, z0], [x1, y, z1]]),
            up([[x0, y, z0], [x1, y, z1], [x0, y, z1]]),
        ]
    }

    fn underside(y: f64, [x0, z0, x1, z1]: [f64; 4]) -> [Triangle; 2] {
        [
            down([[x0, y, z0], [x1, y, z0], [x1, y, z1]]),
            down([[x0, y, z0], [x1, y, z1], [x0, y, z1]]),
        ]
    }

    fn slit_top([from, to]: [f64; 2]) -> Vec<Triangle> {
        let mut part = quad(0.0, [-10.0, -10.0, from, 10.0]).to_vec();
        part.extend(quad(0.0, [to, -10.0, 10.0, 10.0]));
        part
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

    fn parsed(value: f64) -> Exact {
        Decimal::parse(&format!("{value}"))
            .expect("a test coordinate prints as a decimal")
            .exact()
    }

    fn exact_corners(triangle: &Triangle) -> ExactCorners {
        triangle.points.map(|p| p.map(parsed))
    }

    fn surface(triangles: &[Triangle], studs: &[StudReference]) -> Option<TopSurface> {
        let exact = |index: usize| triangles.get(index).map(exact_corners);
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
        part.extend(underside(-8.0, [-40.0, -20.0, 40.0, 20.0]));
        assert_eq!(rows(&part, &[]), ["ffff", "ffff"]);
    }

    #[test]
    fn a_slope_is_flat_only_where_its_top_face_reaches() {
        let part = [
            quad(24.0, [-10.0, -20.0, 10.0, 0.0]).to_vec(),
            vec![
                up([[-10.0, 24.0, 0.0], [10.0, 24.0, 0.0], [10.0, 4.0, 20.0]]),
                up([[-10.0, 24.0, 0.0], [10.0, 4.0, 20.0], [-10.0, 4.0, 20.0]]),
            ],
            underside(0.0, [-10.0, -20.0, 10.0, 20.0]).to_vec(),
        ]
        .concat();
        assert_eq!(rows(&part, &[]), ["f", "."]);
    }

    #[test]
    fn a_round_top_covers_no_cell_whole() {
        let segments = 16;
        let disc = |y: f64, facing: fn([Vec3; 3]) -> Triangle| {
            (0..segments).map(move |k| {
                let at = |k: i32| {
                    let angle = std::f64::consts::TAU * f64::from(k) / f64::from(segments);
                    [STUD * cos(angle), y, STUD * sin(angle)]
                };
                facing([[0.0, y, 0.0], at(k), at(k + 1)])
            })
        };
        let part: Vec<Triangle> = disc(8.0, up).chain(disc(0.0, down)).collect();
        assert_eq!(rows(&part, &[]), ["..", ".."]);
    }

    #[test]
    fn a_face_with_no_exact_geometry_leaves_what_it_might_cover_undecided() {
        let mut part = quad(0.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(0.0, [0.0, -10.0, 20.0, 10.0]));
        let exact = |index: usize| {
            (index != 2)
                .then(|| part.get(index).map(exact_corners))
                .flatten()
        };
        let surface = TopSurface::read(&part, &exact, &[]).expect("whole-stud plan");
        assert_eq!(surface.rows_text(), ["fu"]);
    }

    #[test]
    fn coplanar_top_faces_that_overlap_still_cover_the_cell() {
        let mut part = quad(0.0, CELL_PLAN).to_vec();
        part.push(up([
            [-10.0, 0.0, -10.0],
            [10.0, 0.0, -10.0],
            [-10.0, 0.0, 10.0],
        ]));
        part.extend(underside(-8.0, CELL_PLAN));
        assert_eq!(rows(&part, &[]), ["f"]);
    }

    #[test]
    fn coplanar_top_faces_that_overlap_and_leave_a_gap_leave_the_cell_open() {
        let part = [
            up([[-10.0, 0.0, -10.0], [10.0, 0.0, -10.0], [-10.0, 0.0, 10.0]]),
            up([[-10.0, 0.0, -10.0], [10.0, 0.0, -10.0], [0.0, 0.0, 10.0]]),
            up([[10.0, 0.0, -10.0], [9.0, 0.0, 10.0], [-9.0, 0.0, 10.0]]),
        ];
        assert_eq!(rows(&part, &[]), ["."]);
    }

    fn split_with_a_gap(gap: f64) -> Vec<Triangle> {
        slit_top([-gap, 0.0])
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
    fn a_slit_in_the_top_over_the_parts_own_underside_covers_the_cell() {
        for slit in SLITS {
            let mut part = slit_top(slit);
            part.extend(underside(-8.0, CELL_PLAN));
            assert_eq!(rows(&part, &[]), ["f"], "{slit:?}");
        }
    }

    #[test]
    fn a_slit_in_the_top_that_opens_onto_a_floor_leaves_the_cell_open() {
        for slit @ [from, to] in SLITS {
            let mut part = slit_top(slit);
            part.extend(quad(-4.0, [from, -10.0, to, 10.0]));
            part.extend(underside(-8.0, CELL_PLAN));
            assert_eq!(rows(&part, &[]), ["."], "{slit:?}");
        }
    }

    #[test]
    fn a_slit_only_partly_over_the_parts_underside_leaves_the_cell_open() {
        for slit in SLITS {
            let mut part = slit_top(slit);
            part.extend(underside(-8.0, [-10.0, -10.0, 10.0, 0.0]));
            assert_eq!(rows(&part, &[]), ["."], "{slit:?}");
        }
    }

    #[test]
    fn a_slit_over_faces_whose_facing_cannot_be_read_leaves_the_cell_open() {
        for slit in SLITS {
            let mut part = slit_top(slit);
            part.extend(underside(-8.0, CELL_PLAN).map(|face| Triangle {
                double_sided: true,
                ..face
            }));
            assert_eq!(rows(&part, &[]), ["."], "unknown winding {slit:?}");
            let mut part = slit_top(slit);
            let top_faces = part.len();
            part.extend(underside(-8.0, CELL_PLAN));
            let exact = |index: usize| {
                (index < top_faces)
                    .then(|| part.get(index).map(exact_corners))
                    .flatten()
            };
            let surface = TopSurface::read(&part, &exact, &[]).expect("whole-stud plan");
            assert_eq!(surface.rows_text(), ["."], "no exact geometry {slit:?}");
        }
    }

    fn wall(x: f64, [z0, z1]: [f64; 2], [low, high]: [f64; 2]) -> [Triangle; 2] {
        [
            triangle([[x, high, z0], [x, high, z1], [x, low, z1]]),
            triangle([[x, high, z0], [x, low, z1], [x, low, z0]]),
        ]
    }

    #[test]
    fn a_slit_walled_down_from_the_top_is_a_slot_however_narrow() {
        for slit @ [from, to] in SLITS {
            let mut part = slit_top(slit);
            part.extend(wall(from, [-10.0, 10.0], [-8.0, 0.0]));
            part.extend(wall(to, [-10.0, 10.0], [-8.0, 0.0]));
            part.extend(underside(-8.0, CELL_PLAN));
            assert_eq!(rows(&part, &[]), ["."], "{slit:?}");
        }
    }

    #[test]
    fn a_crack_narrowing_to_a_point_at_the_walled_outline_covers_its_cell() {
        let mut part = quad(0.0, [-10.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend([
            up([[0.0, 0.0, -10.0], [10.0, 0.0, -10.0], [0.017, 0.0, 0.0]]),
            up([[0.017, 0.0, 0.0], [10.0, 0.0, -10.0], [10.0, 0.0, 10.0]]),
            up([[0.017, 0.0, 0.0], [10.0, 0.0, 10.0], [0.0, 0.0, 10.0]]),
        ]);
        for x in [-10.0, 10.0] {
            part.extend(wall(x, [-10.0, 10.0], [-8.0, 0.0]));
        }
        for z in [-10.0, 10.0] {
            part.extend(wall(z, [-10.0, 10.0], [-8.0, 0.0]).map(|face| Triangle {
                points: face.points.map(|[x, y, z]| [z, y, x]),
                ..face
            }));
        }
        part.extend(underside(-8.0, CELL_PLAN));
        assert_eq!(rows(&part, &[]), ["f"]);
    }

    #[test]
    fn a_cell_with_no_top_face_over_the_parts_underside_stays_open() {
        let part = [
            quad(0.0, [-30.0, -30.0, 30.0, -10.0]),
            quad(0.0, [-30.0, 10.0, 30.0, 30.0]),
            quad(0.0, [-30.0, -10.0, -10.0, 10.0]),
            quad(0.0, [10.0, -10.0, 30.0, 10.0]),
            underside(-8.0, [-30.0, -30.0, 30.0, 30.0]),
        ]
        .concat();
        assert_eq!(rows(&part, &[]), ["fff", "f.f", "fff"]);
    }

    #[test]
    fn a_gap_in_the_top_face_leaves_its_cell_open() {
        let mut part = quad(0.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(0.0, [0.0, -10.0, 20.0, 0.0]));
        assert_eq!(rows(&part, &[]), ["f."]);
    }

    #[test]
    fn a_face_holding_three_corners_of_a_cell_leaves_it_open() {
        let corners = [[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]];
        for missing in 0..corners.len() {
            let [p, q, r] = [1, 2, 3].map(|k| corners[(missing + k) % corners.len()]);
            let part = [up([
                [p[0], 0.0, p[1]],
                [q[0], 0.0, q[1]],
                [r[0], 0.0, r[1]],
            ])];
            assert_eq!(rows(&part, &[]), ["."], "missing corner {missing}");
        }
    }

    #[test]
    fn faces_touching_only_at_a_point_leave_the_cell_open() {
        let mut part = quad(0.0, [-10.0, -10.0, 0.0, 4.0]).to_vec();
        part.extend(quad(0.0, [0.0, 4.0, 10.0, 10.0]));
        assert_eq!(rows(&part, &[]), ["."]);
    }

    #[test]
    fn a_hole_away_from_the_corners_and_centre_leaves_the_cell_open() {
        let part = [
            quad(0.0, [-10.0, -10.0, 4.0, 10.0]),
            quad(0.0, [6.0, -10.0, 10.0, 10.0]),
            quad(0.0, [4.0, -10.0, 6.0, 4.0]),
            quad(0.0, [4.0, 6.0, 6.0, 10.0]),
        ]
        .concat();
        assert_eq!(rows(&part, &[]), ["."]);
    }

    #[test]
    fn a_slot_ending_at_t_junctions_leaves_the_cell_open() {
        let part = [
            quad(0.0, [-10.0, -10.0, 0.0, 4.0]),
            quad(0.0, [-10.0, 4.0, 0.0, 6.0]),
            quad(0.0, [-10.0, 6.0, 0.0, 10.0]),
            quad(0.0, [0.0, -10.0, 10.0, 4.0]),
            quad(0.0, [0.0, 6.0, 10.0, 10.0]),
        ]
        .concat();
        assert_eq!(rows(&part, &[]), ["."]);
    }

    #[test]
    fn a_face_that_only_borders_a_cell_leaves_it_open() {
        let mut part = quad(0.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(-8.0, [0.0, -10.0, 20.0, 10.0]));
        assert_eq!(rows(&part, &[]), ["f."]);
    }

    #[test]
    fn a_face_short_of_the_cell_edge_covers_it_only_within_the_identification_residual() {
        let short_by = |gap: f64| {
            let mut part = quad(0.0, [-10.0, -10.0, 10.0 - gap, 10.0]).to_vec();
            part.extend(quad(-8.0, [10.0 - gap, -10.0, 10.0, 10.0]));
            rows(&part, &[])
        };
        assert_eq!(short_by(0.0004), ["f"]);
        assert_eq!(short_by(0.0011), ["."]);
    }

    #[test]
    fn an_edge_whose_ends_carry_more_decimal_places_still_leaves_its_neighbour_open() {
        let mut part = quad(0.0, [0.0, -45.0, 10.0, 45.0]).to_vec();
        part.extend(quad(0.0, [10.0, -4.5, 30.0, 4.5]));
        part.extend(quad(-8.0, [-60.0, -60.0, 60.0, 60.0]));
        assert_eq!(rows(&part, &[]), ["......"; 6]);
    }

    #[test]
    fn one_face_cutting_inside_a_cell_corner_covers_it_only_within_the_identification_residual() {
        let cut_inside_by = |inset: f64| {
            let reach = 30.0 - 2.0 * inset;
            let mut part = vec![up([
                [-10.0, 0.0, -10.0],
                [reach, 0.0, -10.0],
                [-10.0, 0.0, reach],
            ])];
            part.extend(quad(-8.0, [-10.0, -10.0, 30.0, 30.0]));
            rows(&part, &[])
        };
        assert_eq!(cut_inside_by(0.0004), ["f.", ".."]);
        assert_eq!(cut_inside_by(0.0011), ["..", ".."]);
    }

    #[test]
    fn faces_meeting_at_a_t_junction_cover_the_cells_they_share() {
        let mut part = quad(0.0, [-20.0, -20.0, 20.0, 0.0]).to_vec();
        part.extend(quad(0.0, [-20.0, 0.0, 0.0, 20.0]));
        part.extend(quad(0.0, [0.0, 0.0, 20.0, 20.0]));
        part.extend(underside(-8.0, [-20.0, -20.0, 20.0, 20.0]));
        assert_eq!(rows(&part, &[]), ["ff", "ff"]);
    }

    fn edge_strip(floor: [f64; 4]) -> Vec<Triangle> {
        let mut part = quad(16.0, [-30.0, -20.0, -10.0, 0.0]).to_vec();
        part.extend(quad(16.0, [10.0, -20.0, 30.0, 0.0]));
        part.extend(quad(16.0, [-30.0, 0.0, 30.0, 20.0]));
        part.extend(quad(8.0, floor));
        part.extend(underside(0.0, [-30.0, -20.0, 30.0, 20.0]));
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
        part.extend(underside(0.0, [-20.0, -20.0, 20.0, 20.0]));
        let studs = [
            upright_stud(-10.0, 8.0, -10.0),
            upright_stud(10.0, 8.0, -10.0),
        ];
        assert_eq!(rows(&part, &studs), ["..", "ff"]);
    }

    #[test]
    fn a_stud_beside_something_that_is_not_a_flat_top_is_no_pocket() {
        let mut part = quad(8.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.push(up([
            [0.0, 8.0, -10.0],
            [20.0, 16.0, -10.0],
            [20.0, 16.0, 10.0],
        ]));
        part.push(up([
            [0.0, 8.0, -10.0],
            [20.0, 16.0, 10.0],
            [0.0, 8.0, 10.0],
        ]));
        part.extend(underside(0.0, [-20.0, -10.0, 20.0, 10.0]));
        let studs = [upright_stud(-10.0, 8.0, 0.0)];
        assert_eq!(rows(&part, &studs), [".."]);
    }

    #[test]
    fn a_stud_off_the_cell_centres_makes_no_pocket() {
        let mut part = quad(16.0, [-20.0, -10.0, 0.0, 10.0]).to_vec();
        part.extend(quad(8.0, [0.0, -10.0, 20.0, 10.0]));
        part.extend(underside(0.0, [-20.0, -10.0, 20.0, 10.0]));
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
        part.extend(underside(-8.0, [-10.0, -10.0, 15.0, 10.0]));
        assert_eq!(surface(&part, &[]), None);
    }

    #[test]
    fn the_record_carries_the_top_and_origin_in_sixteenths() {
        let mut part = quad(4.5, [-20.0, -10.0, 20.0, 10.0]).to_vec();
        part.extend(underside(0.0, [-20.0, -10.0, 20.0, 10.0]));
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
