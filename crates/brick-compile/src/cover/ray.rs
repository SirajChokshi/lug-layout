use crate::affine::Vec3;

pub(super) const HIT_EPSILON: f64 = 1e-9;
const EDGE_TOLERANCE: f64 = 1e-9;

pub(super) fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(super) fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn unit(v: Vec3) -> Vec3 {
    let length = dot(v, v).sqrt();
    v.map(|c| c / length)
}

#[derive(Clone, Copy)]
pub(super) struct Ray {
    pub origin: Vec3,
    pub direction: Vec3,
    pub reach: f64,
}

#[derive(Clone, Copy)]
pub(super) struct Bounds {
    pub min: Vec3,
    pub max: Vec3,
}

impl Bounds {
    pub const EMPTY: Bounds = Bounds {
        min: [f64::INFINITY; 3],
        max: [f64::NEG_INFINITY; 3],
    };

    pub fn grow(self, p: Vec3) -> Self {
        Bounds {
            min: [0, 1, 2].map(|axis| self.min[axis].min(p[axis])),
            max: [0, 1, 2].map(|axis| self.max[axis].max(p[axis])),
        }
    }

    pub fn union(self, other: Bounds) -> Self {
        self.grow(other.min).grow(other.max)
    }

    pub fn padded(self, margin: f64) -> Self {
        Bounds {
            min: self.min.map(|v| v - margin),
            max: self.max.map(|v| v + margin),
        }
    }

    pub fn contains(&self, p: Vec3) -> bool {
        (0..3).all(|axis| p[axis] >= self.min[axis] && p[axis] <= self.max[axis])
    }

    pub fn centre(&self, axis: usize) -> f64 {
        self.min[axis] + self.max[axis]
    }

    pub fn entry(&self, ray: &Ray) -> Option<f64> {
        self.seen_from(ray.origin).entry(ray.direction, ray.reach)
    }

    pub fn seen_from(&self, origin: Vec3) -> AnchoredBounds {
        AnchoredBounds {
            below: [0, 1, 2].map(|axis| self.min[axis] - origin[axis]),
            above: [0, 1, 2].map(|axis| self.max[axis] - origin[axis]),
            outside: [0, 1, 2]
                .map(|axis| origin[axis] < self.min[axis] || origin[axis] > self.max[axis]),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct AnchoredBounds {
    below: Vec3,
    above: Vec3,
    outside: [bool; 3],
}

impl AnchoredBounds {
    pub fn entry(&self, direction: Vec3, reach: f64) -> Option<f64> {
        let below = [0, 1, 2].map(|axis| self.below[axis] / direction[axis]);
        let above = [0, 1, 2].map(|axis| self.above[axis] / direction[axis]);
        let mut near = 0.0_f64;
        let mut far = reach;
        for axis in 0..3 {
            if direction[axis] == 0.0 {
                if self.outside[axis] {
                    return None;
                }
                continue;
            }
            let (a, b) = (below[axis], above[axis]);
            near = near.max(a.min(b));
            far = far.min(a.max(b));
            if near > far {
                return None;
            }
        }
        Some(near)
    }
}

#[derive(Clone, Copy)]
pub(super) struct RayTriangle {
    corner: Vec3,
    edge1: Vec3,
    edge2: Vec3,
}

impl RayTriangle {
    pub fn same_bits(&self, other: &RayTriangle) -> bool {
        let bits = |v: &Vec3| v.map(f64::to_bits);
        bits(&self.corner) == bits(&other.corner)
            && bits(&self.edge1) == bits(&other.edge1)
            && bits(&self.edge2) == bits(&other.edge2)
    }

    pub fn new(points: &[Vec3; 3]) -> Self {
        RayTriangle {
            corner: points[0],
            edge1: sub(points[1], points[0]),
            edge2: sub(points[2], points[0]),
        }
    }

    pub fn seen_from(&self, origin: Vec3) -> AnchoredTriangle {
        let s = sub(origin, self.corner);
        let q = cross(s, self.edge1);
        AnchoredTriangle {
            edge1: self.edge1,
            edge2: self.edge2,
            s,
            q,
            edge2_q: dot(self.edge2, q),
        }
    }

    pub fn blocks(&self, ray: &Ray) -> bool {
        self.seen_from(ray.origin).blocks(ray.direction, ray.reach)
    }
}

#[derive(Clone, Copy)]
pub(super) struct AnchoredTriangle {
    edge1: Vec3,
    edge2: Vec3,
    s: Vec3,
    q: Vec3,
    edge2_q: f64,
}

impl AnchoredTriangle {
    fn distance(&self, direction: Vec3) -> Option<f64> {
        let p = cross(direction, self.edge2);
        let determinant = dot(self.edge1, p);
        if determinant.abs() < HIT_EPSILON {
            return None;
        }
        let inverse = 1.0 / determinant;
        let u = dot(self.s, p) * inverse;
        if !(-EDGE_TOLERANCE..=1.0 + EDGE_TOLERANCE).contains(&u) {
            return None;
        }
        let v = dot(direction, self.q) * inverse;
        if v < -EDGE_TOLERANCE || u + v > 1.0 + EDGE_TOLERANCE {
            return None;
        }
        let t = self.edge2_q * inverse;
        (t > HIT_EPSILON).then_some(t)
    }

    pub fn blocks(&self, direction: Vec3, reach: f64) -> bool {
        self.distance(direction).is_some_and(|d| d <= reach)
    }
}
