use std::thread;

use crate::affine::Vec3;
use crate::flatten::Triangle;
use crate::trig::{cos, sin};

const HEMISPHERE_RAYS: usize = 1024;
const HORIZON_RAYS: usize = 64;
const SIDE_OFFSET_LDU: f64 = 1e-3;
const HIT_EPSILON: f64 = 1e-9;
const GOLDEN_ANGLE: f64 = 2.399_963_229_728_653;
const SAMPLE_PULL_TO_CENTROID: f64 = 0.1;
const LEAF_TRIANGLES: usize = 4;

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

fn lerp(a: Vec3, b: Vec3, t: f64) -> Vec3 {
    [0, 1, 2].map(|axis| a[axis] + (b[axis] - a[axis]) * t)
}

fn upward_directions() -> Vec<Vec3> {
    let hemisphere = (0..HEMISPHERE_RAYS).map(|i| {
        let y = (i as f64 + 0.5) / HEMISPHERE_RAYS as f64;
        let radius = (1.0 - y * y).sqrt();
        let angle = GOLDEN_ANGLE * i as f64;
        [radius * cos(angle), y, radius * sin(angle)]
    });
    let horizon = (0..HORIZON_RAYS).map(|i| {
        let angle = std::f64::consts::TAU * i as f64 / HORIZON_RAYS as f64;
        [cos(angle), 0.0, sin(angle)]
    });
    hemisphere.chain(horizon).collect()
}

fn sample_points(points: &[Vec3; 3]) -> [Vec3; 7] {
    let [a, b, c] = *points;
    let centroid = [0, 1, 2].map(|axis| (a[axis] + b[axis] + c[axis]) / 3.0);
    let toward = |p: Vec3| lerp(p, centroid, SAMPLE_PULL_TO_CENTROID);
    [
        centroid,
        toward(a),
        toward(b),
        toward(c),
        toward(lerp(a, b, 0.5)),
        toward(lerp(b, c, 0.5)),
        toward(lerp(c, a, 0.5)),
    ]
}

#[derive(Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

impl Bounds {
    const EMPTY: Bounds = Bounds {
        min: [f64::INFINITY; 3],
        max: [f64::NEG_INFINITY; 3],
    };

    fn of(points: &[Vec3; 3]) -> Self {
        points.iter().fold(Bounds::EMPTY, |b, p| b.grow(*p))
    }

    fn grow(self, p: Vec3) -> Self {
        Bounds {
            min: [0, 1, 2].map(|axis| self.min[axis].min(p[axis])),
            max: [0, 1, 2].map(|axis| self.max[axis].max(p[axis])),
        }
    }

    fn union(self, other: Bounds) -> Self {
        self.grow(other.min).grow(other.max)
    }

    fn ray_misses(&self, origin: Vec3, inverse: Vec3) -> bool {
        let mut near = 0.0_f64;
        let mut far = f64::INFINITY;
        for axis in 0..3 {
            let a = (self.min[axis] - origin[axis]) * inverse[axis];
            let b = (self.max[axis] - origin[axis]) * inverse[axis];
            let (lo, hi) = if a.is_nan() || b.is_nan() {
                if origin[axis] < self.min[axis] || origin[axis] > self.max[axis] {
                    return true;
                }
                (f64::NEG_INFINITY, f64::INFINITY)
            } else {
                (a.min(b), a.max(b))
            };
            near = near.max(lo);
            far = far.min(hi);
            if near > far {
                return true;
            }
        }
        false
    }
}

enum Node {
    Leaf {
        bounds: Bounds,
        triangles: Vec<usize>,
    },
    Branch {
        bounds: Bounds,
        children: Box<[Node; 2]>,
    },
}

struct Ray {
    origin: Vec3,
    direction: Vec3,
    inverse: Vec3,
}

impl Node {
    fn build(mut triangles: Vec<usize>, bounds: &[Bounds], centroids: &[Vec3]) -> Node {
        let all = triangles
            .iter()
            .fold(Bounds::EMPTY, |b, &t| b.union(bounds[t]));
        if triangles.len() <= LEAF_TRIANGLES {
            return Node::Leaf {
                bounds: all,
                triangles,
            };
        }
        let extent = sub(all.max, all.min);
        let axis = (0..3)
            .max_by(|&a, &b| extent[a].total_cmp(&extent[b]))
            .unwrap_or(0);
        triangles.sort_by(|&a, &b| centroids[a][axis].total_cmp(&centroids[b][axis]));
        let upper = triangles.split_off(triangles.len() / 2);
        Node::Branch {
            bounds: all,
            children: Box::new([
                Node::build(triangles, bounds, centroids),
                Node::build(upper, bounds, centroids),
            ]),
        }
    }

    fn blocks(&self, ray: &Ray, mesh: &[Triangle], own: usize) -> bool {
        match self {
            Node::Leaf { bounds, triangles } => {
                !bounds.ray_misses(ray.origin, ray.inverse)
                    && triangles
                        .iter()
                        .any(|&t| t != own && ray_hits(ray.origin, ray.direction, &mesh[t].points))
            }
            Node::Branch { bounds, children } => {
                !bounds.ray_misses(ray.origin, ray.inverse)
                    && children.iter().any(|child| child.blocks(ray, mesh, own))
            }
        }
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

fn triangle_visible(i: usize, triangles: &[Triangle], tree: &Node, directions: &[Vec3]) -> bool {
    let [a, b, c] = triangles[i].points;
    let normal = cross(sub(b, a), sub(c, a));
    let length = dot(normal, normal).sqrt();
    if length < HIT_EPSILON {
        return false;
    }
    let unit = normal.map(|v| v / length);
    let samples = sample_points(&triangles[i].points);
    [unit, unit.map(|v| -v)].iter().any(|side| {
        samples.iter().any(|sample| {
            let origin = [0, 1, 2].map(|axis| sample[axis] + side[axis] * SIDE_OFFSET_LDU);
            directions
                .iter()
                .filter(|d| dot(**d, *side) > 0.0)
                .any(|d| {
                    let ray = Ray {
                        origin,
                        direction: *d,
                        inverse: d.map(|v| 1.0 / v),
                    };
                    !tree.blocks(&ray, triangles, i)
                })
        })
    })
}

pub fn visible_from_above(triangles: &[Triangle]) -> Vec<bool> {
    if triangles.is_empty() {
        return Vec::new();
    }
    let directions = upward_directions();
    let bounds: Vec<Bounds> = triangles.iter().map(|t| Bounds::of(&t.points)).collect();
    let centroids: Vec<Vec3> = triangles
        .iter()
        .map(|t| [0, 1, 2].map(|axis| t.points.iter().map(|p| p[axis]).sum::<f64>() / 3.0))
        .collect();
    let tree = Node::build((0..triangles.len()).collect(), &bounds, &centroids);
    let workers = thread::available_parallelism().map_or(1, |n| n.get());
    if workers == 1 {
        return (0..triangles.len())
            .map(|i| triangle_visible(i, triangles, &tree, &directions))
            .collect();
    }
    let chunk = triangles.len().div_ceil(workers);
    let mut visible = vec![false; triangles.len()];
    thread::scope(|scope| {
        for (w, slice) in visible.chunks_mut(chunk).enumerate() {
            let (tree, directions) = (&tree, &directions);
            scope.spawn(move || {
                for (k, out) in slice.iter_mut().enumerate() {
                    *out = triangle_visible(w * chunk + k, triangles, tree, directions);
                }
            });
        }
    });
    visible
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
