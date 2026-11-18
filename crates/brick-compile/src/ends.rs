use crate::affine::Vec3;
use crate::connect::{column, Connector, Shape};
use crate::flatten::Triangle;
use crate::lattice::STUD_LDU;
use crate::trig::planar_length;

const IDENTIFY_LDU: f64 = 0.0005;
const FEMALE_REACH_LDU: f64 = STUD_LDU / 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blocking {
    pub gap: f64,
    pub radius: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct End {
    pub point: Vec3,
    pub outward: Vec3,
    pub radius: f64,
}

pub fn cylinder_ends(connector: &Connector) -> Vec<[End; 2]> {
    let Shape::Cylinder {
        sections, center, ..
    } = &connector.shape
    else {
        return Vec::new();
    };
    let (Some(first), Some(last)) = (sections.first(), sections.last()) else {
        return Vec::new();
    };
    let total: f64 = sections.iter().map(|s| s.length).sum();
    let direction = column(&connector.placement, 1);
    let backward = direction.map(|c| -c + 0.0);
    let from = if *center { -total / 2.0 } else { 0.0 };
    connector
        .grid
        .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets())
        .into_iter()
        .map(|offset| {
            let anchor = connector.placement.apply(offset);
            [
                End {
                    point: along(anchor, direction, from),
                    outward: backward,
                    radius: first.radius,
                },
                End {
                    point: along(anchor, direction, from + total),
                    outward: direction,
                    radius: last.radius,
                },
            ]
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reading {
    Free,
    Blocked(Blocking),
    WiderThanReach,
}

pub fn read_end(triangles: &[Triangle], end: &End) -> Reading {
    if end.radius + IDENTIFY_LDU >= FEMALE_REACH_LDU {
        return Reading::WiderThanReach;
    }
    let mut nearest: Option<Blocking> = None;
    for triangle in triangles {
        let Some(blocking) = blocking_part(&triangle.points, end) else {
            continue;
        };
        if nearest.is_none_or(|n| blocking.gap < n.gap) {
            nearest = Some(blocking);
        }
    }
    nearest.map_or(Reading::Free, Reading::Blocked)
}

fn blocking_part(points: &[Vec3; 3], end: &End) -> Option<Blocking> {
    let polygon = clipped_beyond(points, end);
    if polygon.is_empty() {
        return None;
    }
    let flat: Vec<[f64; 2]> = polygon.iter().map(|&(_, xy)| xy).collect();
    let outermost = flat
        .iter()
        .map(|p| planar_length(p[0], p[1]))
        .fold(0.0, f64::max);
    let innermost = distance_to_origin(&flat);
    let enters = outermost > end.radius + IDENTIFY_LDU && innermost <= FEMALE_REACH_LDU;
    enters.then(|| Blocking {
        gap: polygon
            .iter()
            .map(|&(t, _)| t)
            .fold(f64::INFINITY, f64::min),
        radius: innermost.max(end.radius),
    })
}

fn clipped_beyond(points: &[Vec3; 3], end: &End) -> Vec<(f64, [f64; 2])> {
    let (u, v) = perpendiculars(end.outward);
    let local = points.map(|p| {
        let d = sub(p, end.point);
        (d, dot(d, end.outward) - IDENTIFY_LDU)
    });
    let mut kept = Vec::new();
    for i in 0..3 {
        let (a, ta) = local[i];
        let (b, tb) = local[(i + 1) % 3];
        if ta > 0.0 {
            kept.push(a);
        }
        if (ta > 0.0) != (tb > 0.0) && ta != tb {
            let s = ta / (ta - tb);
            kept.push([0, 1, 2].map(|k| a[k] + (b[k] - a[k]) * s));
        }
    }
    kept.into_iter()
        .map(|d| (dot(d, end.outward), [dot(d, u), dot(d, v)]))
        .collect()
}

fn distance_to_origin(polygon: &[[f64; 2]]) -> f64 {
    let n = polygon.len();
    let mut sign = 0.0;
    let mut inside = n >= 3;
    let mut nearest = f64::INFINITY;
    for i in 0..n {
        let a = polygon[i];
        let b = polygon[(i + 1) % n];
        let cross = a[0] * b[1] - a[1] * b[0];
        if cross != 0.0 {
            if sign == 0.0 {
                sign = cross.signum();
            } else if cross.signum() != sign {
                inside = false;
            }
        }
        let edge = [b[0] - a[0], b[1] - a[1]];
        let length = edge[0] * edge[0] + edge[1] * edge[1];
        let s = if length > 0.0 {
            (-(a[0] * edge[0] + a[1] * edge[1]) / length).clamp(0.0, 1.0)
        } else {
            0.0
        };
        nearest = nearest.min(planar_length(a[0] + edge[0] * s, a[1] + edge[1] * s));
    }
    if inside && sign != 0.0 {
        0.0
    } else {
        nearest
    }
}

fn perpendiculars(axis: Vec3) -> (Vec3, Vec3) {
    let helper = if axis[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let u = normalized(cross(axis, helper));
    (u, cross(axis, u))
}

fn normalized(v: Vec3) -> Vec3 {
    let length = dot(v, v).sqrt();
    v.map(|c| c / length)
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn along(point: Vec3, direction: Vec3, distance: f64) -> Vec3 {
    [0, 1, 2].map(|k| point[k] + direction[k] * distance + 0.0)
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
