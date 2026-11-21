use crate::affine::{Affine, Vec3};
use crate::circle::{span, ArcSpan, Bearing, Direction};
use crate::exact::Decimal;
use crate::identify::identifies;
use crate::ldraw::{ExactNumbers, LdrawFile, Line, Winding};
use crate::trig::planar_length;

const CIRCLE_POINTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UnitShape {
    Wall,
    Annulus { inner: f64, outer: f64 },
}

#[derive(Debug)]
pub struct UnitRound {
    pub shape: UnitShape,
    pub arcs: Option<Vec<ArcSpan>>,
    pub facing: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RoundShape {
    Wall { radius: f64, from: f64, to: f64 },
    Annulus { inner: f64, outer: f64, at: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacedRound {
    pub axis: usize,
    pub center: [f64; 2],
    pub shape: RoundShape,
}

pub type RoundBits = (usize, [u64; 2], bool, [u64; 3]);

impl PlacedRound {
    pub fn bits(&self) -> RoundBits {
        let (wall, values) = match self.shape {
            RoundShape::Wall { radius, from, to } => (true, [radius, from, to]),
            RoundShape::Annulus { inner, outer, at } => (false, [inner, outer, at]),
        };
        (
            self.axis,
            self.center.map(f64::to_bits),
            wall,
            values.map(f64::to_bits),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unplaced {
    NotCircular,
    Tilted,
}

pub fn plan_axes(axis: usize) -> (usize, usize) {
    ((axis + 1) % 3, (axis + 2) % 3)
}

fn column(m: &Affine, c: usize) -> Vec3 {
    [m.m[c], m.m[4 + c], m.m[8 + c]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub fn aligned_axis(direction: Vec3) -> Option<usize> {
    let size = norm(direction);
    let unit = direction.map(|c| c / size);
    (0..3)
        .find(|&k| (0..3).all(|j| j == k || identifies(unit[j])) && identifies(unit[k].abs() - 1.0))
}

pub fn place(unit: UnitShape, matrix: &Affine) -> Result<PlacedRound, Unplaced> {
    let (c0, c1, c2) = (column(matrix, 0), column(matrix, 1), column(matrix, 2));
    let t = [matrix.m[3], matrix.m[7], matrix.m[11]];
    let (rx, rz, height) = (norm(c0), norm(c2), norm(c1));
    let circular = rx > 0.0
        && rz > 0.0
        && height > 0.0
        && identifies(rx - rz)
        && identifies(dot(c0, c2) / (rx * rz))
        && identifies(dot(c0, c1) / (rx * height))
        && identifies(dot(c2, c1) / (rz * height));
    if !circular {
        return Err(Unplaced::NotCircular);
    }
    let axis = aligned_axis(c1).ok_or(Unplaced::Tilted)?;
    let (i, j) = plan_axes(axis);
    let ends = (t[axis], t[axis] + c1[axis]);
    let shape = match unit {
        UnitShape::Wall => RoundShape::Wall {
            radius: rx,
            from: ends.0.min(ends.1),
            to: ends.0.max(ends.1),
        },
        UnitShape::Annulus { inner, outer } => RoundShape::Annulus {
            inner: inner * rx,
            outer: outer * rx,
            at: t[axis],
        },
    };
    Ok(PlacedRound {
        axis,
        center: [t[i], t[j]],
        shape,
    })
}

fn polygon_normal(points: &[Vec3], winding: Winding) -> Vec3 {
    let e1 = [0, 1, 2].map(|k| points[1][k] - points[0][k]);
    let e2 = [0, 1, 2].map(|k| points[2][k] - points[0][k]);
    let normal = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    match winding {
        Winding::Ccw => normal,
        Winding::Cw => normal.map(|c| -c),
    }
}

fn surrounds_center(points: &[Vec3]) -> bool {
    let mut sign = 0.0;
    points.iter().enumerate().all(|(k, a)| {
        let b = points[(k + 1) % points.len()];
        let side = (b[0] - a[0]) * (-a[2]) - (b[2] - a[2]) * (-a[0]);
        let consistent = sign == 0.0 || side == 0.0 || side.signum() == sign;
        if side != 0.0 {
            sign = side.signum();
        }
        consistent
    })
}

type Polygon = (Vec<Vec3>, bool, Winding);

pub fn unit_round(file: &LdrawFile) -> Option<UnitRound> {
    let mut certified = false;
    let mut winding = Winding::Ccw;
    let mut polygons: Vec<Polygon> = Vec::new();
    let mut exact_polygons: Vec<Option<Vec<[Decimal; 3]>>> = Vec::new();
    for (index, line) in file.lines.iter().enumerate() {
        let exact_points = match file.exact.get(index) {
            Some(ExactNumbers::Points(points)) => Some(points.clone()),
            _ => None,
        };
        match line {
            Line::Certify(w) => {
                certified = true;
                winding = *w;
            }
            Line::NoCertify => certified = false,
            Line::SetWinding(w) => winding = *w,
            Line::Subfile { .. } => return None,
            Line::Triangle { points, .. } => {
                polygons.push((points.to_vec(), certified, winding));
                exact_polygons.push(exact_points);
            }
            Line::Quad { points, .. } => {
                polygons.push((points.to_vec(), certified, winding));
                exact_polygons.push(exact_points);
            }
            Line::Edge { .. } | Line::InvertNext => {}
        }
    }
    if polygons.is_empty() {
        return None;
    }
    let radius = |p: &Vec3| planar_length(p[0], p[2]);
    let level = |p: &Vec3, y: f64| identifies(p[1] - y);
    let all = || polygons.iter().flat_map(|(points, _, _)| points.iter());
    let wall = polygons.iter().all(|(points, _, _)| {
        points.iter().all(|p| identifies(radius(p) - 1.0))
            && points.iter().all(|p| level(p, 0.0) || level(p, 1.0))
            && points.iter().any(|p| level(p, 0.0))
            && points.iter().any(|p| level(p, 1.0))
    });
    let shape = if wall {
        UnitShape::Wall
    } else if all().all(|p| level(p, 0.0)) {
        let inner = all().map(radius).fold(f64::INFINITY, f64::min);
        let outer = all().map(radius).fold(0.0, f64::max);
        let hollow = !identifies(inner);
        let circle = if hollow { inner } else { outer };
        let on_circle = all().filter(|p| identifies(radius(p) - circle)).count();
        let covers_center = hollow
            && polygons
                .iter()
                .any(|(points, _, _)| surrounds_center(points));
        if on_circle < CIRCLE_POINTS || covers_center {
            return None;
        }
        UnitShape::Annulus {
            inner: if hollow { inner } else { 0.0 },
            outer,
        }
    } else {
        return None;
    };
    let mut facings = Vec::new();
    let mut arcs = Some(Vec::new());
    let mut all_certified = true;
    for ((points, certified, winding), exact) in polygons.iter().zip(&exact_polygons) {
        let normal = polygon_normal(points, *winding);
        let count = points.len() as f64;
        let centroid = [0, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / count);
        facings.push(match shape {
            UnitShape::Wall => (normal[0] * centroid[0] + normal[2] * centroid[1]).signum(),
            UnitShape::Annulus { .. } => normal[1].signum(),
        });
        all_certified &= *certified;
        let rim: Option<Vec<Direction>> = exact.as_ref().map(|exact| {
            points
                .iter()
                .zip(exact)
                .filter(|(p, _)| !identifies(radius(p)))
                .map(|(_, e)| [e[0].exact(), e[2].exact()])
                .collect()
        });
        match (&mut arcs, rim) {
            (Some(found), Some(rim)) => {
                found.extend(span(rim.into_iter().map(Bearing::Raw).collect()))
            }
            _ => arcs = None,
        }
    }
    let first = facings[0];
    let agree = facings.iter().all(|f| *f == first);
    Some(UnitRound {
        shape,
        arcs,
        facing: (agree && all_certified).then_some(first),
    })
}
