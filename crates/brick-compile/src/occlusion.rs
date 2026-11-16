use crate::affine::Vec3;
use crate::flatten::Triangle;

const HEMISPHERE_RAYS: usize = 64;
const SIDE_OFFSET_LDU: f64 = 1e-3;
const HIT_EPSILON: f64 = 1e-9;
const GOLDEN_ANGLE: f64 = 2.399_963_229_728_653;

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

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn upper_hemisphere() -> Vec<Vec3> {
    (0..HEMISPHERE_RAYS)
        .map(|i| {
            let y = i as f64 / (HEMISPHERE_RAYS - 1) as f64;
            let radius = (1.0 - y * y).sqrt();
            let angle = GOLDEN_ANGLE * i as f64;
            [radius * angle.cos(), y, radius * angle.sin()]
        })
        .collect()
}

struct Bounds {
    min: Vec3,
    max: Vec3,
}

impl Bounds {
    fn of(points: &[Vec3; 3]) -> Self {
        let mut min = points[0];
        let mut max = points[0];
        for p in &points[1..] {
            for axis in 0..3 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
        }
        Bounds { min, max }
    }

    fn ray_misses(&self, origin: Vec3, direction: Vec3) -> bool {
        let mut near = 0.0_f64;
        let mut far = f64::INFINITY;
        for axis in 0..3 {
            if direction[axis].abs() < HIT_EPSILON {
                if origin[axis] < self.min[axis] || origin[axis] > self.max[axis] {
                    return true;
                }
                continue;
            }
            let inverse = 1.0 / direction[axis];
            let a = (self.min[axis] - origin[axis]) * inverse;
            let b = (self.max[axis] - origin[axis]) * inverse;
            near = near.max(a.min(b));
            far = far.min(a.max(b));
            if near > far {
                return true;
            }
        }
        false
    }
}

fn ray_hits(origin: Vec3, direction: Vec3, points: &[Vec3; 3]) -> bool {
    let edge1 = sub(points[1], points[0]);
    let edge2 = sub(points[2], points[0]);
    let p = cross(direction, edge2);
    let determinant = dot(edge1, p);
    if determinant.abs() < HIT_EPSILON {
        return false;
    }
    let inverse = 1.0 / determinant;
    let s = sub(origin, points[0]);
    let u = dot(s, p) * inverse;
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = cross(s, edge1);
    let v = dot(direction, q) * inverse;
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    dot(edge2, q) * inverse > HIT_EPSILON
}

fn escapes(
    origin: Vec3,
    direction: Vec3,
    triangles: &[Triangle],
    bounds: &[Bounds],
    own: usize,
) -> bool {
    triangles.iter().zip(bounds).enumerate().all(|(j, (t, b))| {
        j == own || b.ray_misses(origin, direction) || !ray_hits(origin, direction, &t.points)
    })
}

pub fn visible_from_above(triangles: &[Triangle]) -> Vec<bool> {
    let directions = upper_hemisphere();
    let bounds: Vec<Bounds> = triangles.iter().map(|t| Bounds::of(&t.points)).collect();
    triangles
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let [a, b, c] = t.points;
            let normal = cross(sub(b, a), sub(c, a));
            let length = dot(normal, normal).sqrt();
            if length < HIT_EPSILON {
                return false;
            }
            let unit = normal.map(|v| v / length);
            let centroid = [0, 1, 2].map(|axis| (a[axis] + b[axis] + c[axis]) / 3.0);
            [unit, unit.map(|v| -v)].iter().any(|side| {
                let origin = [0, 1, 2].map(|axis| centroid[axis] + side[axis] * SIDE_OFFSET_LDU);
                directions
                    .iter()
                    .filter(|d| dot(**d, *side) > 0.0)
                    .any(|d| escapes(origin, *d, triangles, &bounds, i))
            })
        })
        .collect()
}

pub fn drop_hidden_from_above(triangles: &mut Vec<Triangle>) {
    let visible = visible_from_above(triangles);
    let mut keep = visible.into_iter();
    triangles.retain(|_| keep.next().unwrap_or(true));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quad(corners: [Vec3; 4]) -> [Triangle; 2] {
        let [a, b, c, d] = corners;
        [
            Triangle {
                color: 16,
                points: [a, b, c],
                double_sided: false,
            },
            Triangle {
                color: 16,
                points: [a, c, d],
                double_sided: false,
            },
        ]
    }

    #[test]
    fn a_floor_under_a_closed_lid_is_hidden_and_the_lid_is_not() {
        let mut triangles = Vec::new();
        let (lo, hi, top, bottom) = (-10.0, 10.0, 0.0, -24.0);
        triangles.extend(quad([
            [lo, top, lo],
            [hi, top, lo],
            [hi, top, hi],
            [lo, top, hi],
        ]));
        triangles.extend(quad([
            [lo, bottom, lo],
            [lo, bottom, hi],
            [hi, bottom, hi],
            [hi, bottom, lo],
        ]));
        for (x0, z0, x1, z1) in [
            (lo, lo, hi, lo),
            (hi, lo, hi, hi),
            (hi, hi, lo, hi),
            (lo, hi, lo, lo),
        ] {
            triangles.extend(quad([
                [x0, bottom, z0],
                [x1, bottom, z1],
                [x1, top, z1],
                [x0, top, z0],
            ]));
        }
        let inner = -12.0;
        triangles.extend(quad([
            [-5.0, inner, -5.0],
            [5.0, inner, -5.0],
            [5.0, inner, 5.0],
            [-5.0, inner, 5.0],
        ]));
        let visible = visible_from_above(&triangles);
        assert!(visible[0] && visible[1], "lid");
        assert!(
            !visible[2] && !visible[3],
            "floor faces down onto the support"
        );
        assert!(visible[4..12].iter().all(|v| *v), "outer walls");
        assert!(!visible[12] && !visible[13], "enclosed inner plate");
    }
}
