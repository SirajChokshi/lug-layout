use std::f64::consts::PI;

use crate::affine::Vec3;
use crate::bands::coaxial_radius;
use crate::flatten::{ReferenceSpan, Triangle};
use crate::sixteenths;
use crate::technic::is_circular_primitive;

const IDENTIFY_LDU: f64 = 0.0005;
const DIRECTIONS: usize = 64;
const ARMS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoreAxis {
    pub point: Vec3,
    pub direction: Vec3,
    pub from: f64,
    pub to: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BoreShape {
    Round { radius: f64 },
    Axle { tip: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoreSection {
    pub shape: BoreShape,
    pub length: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoreError {
    OpenDirection,
    Unidentified,
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn along(point: Vec3, direction: Vec3, distance: f64) -> Vec3 {
    [0, 1, 2].map(|k| point[k] + direction[k] * distance)
}

fn unit(v: Vec3) -> Vec3 {
    let l = dot(v, v).sqrt();
    v.map(|c| c / l)
}

fn across(direction: Vec3) -> (Vec3, Vec3) {
    let basis = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let seed = basis
        .into_iter()
        .min_by(|a, b| {
            dot(*a, direction)
                .abs()
                .total_cmp(&dot(*b, direction).abs())
        })
        .unwrap_or(basis[0]);
    let first = unit(sub(seed, direction.map(|c| c * dot(seed, direction))));
    (first, cross(direction, first))
}

fn radial(p: Vec3, axis: &BoreAxis) -> f64 {
    let d = sub(p, axis.point);
    let off = sub(d, axis.direction.map(|c| c * dot(d, axis.direction)));
    dot(off, off).sqrt()
}

fn hit(origin: Vec3, ray: Vec3, triangle: &Triangle) -> Option<f64> {
    let [a, b, c] = triangle.points;
    let e1 = sub(b, a);
    let e2 = sub(c, a);
    let p = cross(ray, e2);
    let det = dot(e1, p);
    if det.abs() <= f64::EPSILON {
        return None;
    }
    let s = sub(origin, a);
    let u = dot(s, p) / det;
    let q = cross(s, e1);
    let v = dot(ray, q) / det;
    let t = dot(e2, q) / det;
    (u >= 0.0 && v >= 0.0 && u + v <= 1.0 && t > 0.0).then_some(t)
}

fn wall_radii(
    triangles: &[Triangle],
    spans: &[ReferenceSpan],
    axis: &BoreAxis,
) -> Vec<Option<f64>> {
    let mut walls = vec![None; triangles.len()];
    for span in spans.iter().filter(|s| is_circular_primitive(&s.reference)) {
        if let Some(radius) = coaxial_radius(span, axis.point, axis.direction) {
            for index in span.triangles.clone() {
                let on_wall = triangles[index]
                    .points
                    .iter()
                    .all(|&p| (radial(p, axis) - radius).abs() <= IDENTIFY_LDU);
                if on_wall {
                    walls[index] = Some(radius);
                }
            }
        }
    }
    walls
}

fn free_radii(
    triangles: &[Triangle],
    walls: &[Option<f64>],
    centre: Vec3,
    axis: &BoreAxis,
) -> Option<Vec<f64>> {
    let (e1, e2) = across(axis.direction);
    (0..DIRECTIONS)
        .map(|k| {
            let angle = 2.0 * PI * k as f64 / DIRECTIONS as f64;
            let ray = [0, 1, 2].map(|i| e1[i] * angle.cos() + e2[i] * angle.sin());
            triangles
                .iter()
                .zip(walls)
                .filter_map(|(triangle, wall)| {
                    hit(centre, ray, triangle).map(|distance| wall.unwrap_or(distance))
                })
                .min_by(f64::total_cmp)
        })
        .collect()
}

fn locks(free: &[f64], tip: f64) -> bool {
    let narrowest = free.iter().copied().fold(f64::INFINITY, f64::min);
    let step = DIRECTIONS / ARMS;
    narrowest < tip - IDENTIFY_LDU
        && (0..step)
            .any(|phase| (0..ARMS).all(|arm| free[phase + arm * step] >= tip - IDENTIFY_LDU))
}

fn identified(value: f64) -> Result<f64, BoreError> {
    sixteenths::identified(value)
        .map(|steps| f64::from(steps) / f64::from(sixteenths::PER_LDU))
        .ok_or(BoreError::Unidentified)
}

pub fn bore_sections(
    triangles: &[Triangle],
    spans: &[ReferenceSpan],
    axis: &BoreAxis,
    axle_tip: Option<f64>,
) -> Result<Vec<BoreSection>, BoreError> {
    let walls = wall_radii(triangles, spans, axis);
    let mut depths: Vec<f64> = triangles
        .iter()
        .flat_map(|t| t.points)
        .map(|p| dot(sub(p, axis.point), axis.direction))
        .filter(|&t| t > axis.from + IDENTIFY_LDU && t < axis.to - IDENTIFY_LDU)
        .chain([axis.from, axis.to])
        .collect();
    depths.sort_by(f64::total_cmp);
    depths.dedup_by(|a, b| (*a - *b).abs() <= IDENTIFY_LDU);
    let mut sections: Vec<BoreSection> = Vec::new();
    for pair in depths.windows(2) {
        let centre = along(axis.point, axis.direction, (pair[0] + pair[1]) / 2.0);
        let free = free_radii(triangles, &walls, centre, axis).ok_or(BoreError::OpenDirection)?;
        let shape = match axle_tip {
            Some(tip) if locks(&free, tip) => BoreShape::Axle { tip },
            _ => BoreShape::Round {
                radius: identified(free.iter().copied().fold(f64::INFINITY, f64::min))?,
            },
        };
        let length = pair[1] - pair[0];
        match sections.last_mut() {
            Some(last) if last.shape == shape => last.length += length,
            _ => sections.push(BoreSection { shape, length }),
        }
    }
    sections
        .into_iter()
        .map(|s| {
            Ok(BoreSection {
                length: identified(s.length)?,
                ..s
            })
        })
        .collect()
}
