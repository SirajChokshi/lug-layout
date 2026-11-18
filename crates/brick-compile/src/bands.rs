use crate::affine::{Affine, Vec3};
use crate::flatten::{ReferenceSpan, Triangle};
use crate::technic::is_circular_primitive;

const IDENTIFY_LDU: f64 = 0.0005;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RoundBand {
    pub point: Vec3,
    pub axis: Vec3,
    pub radius: f64,
    pub from: f64,
    pub to: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EndFace {
    pub origin: Vec3,
    pub normal: Vec3,
    pub radius: f64,
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

fn scaled(v: Vec3, s: f64) -> Vec3 {
    v.map(|c| c * s + 0.0)
}

fn length(v: Vec3) -> f64 {
    dot(v, v).sqrt()
}

fn column(m: &Affine, c: usize) -> Vec3 {
    [m.m[c], m.m[4 + c], m.m[8 + c]]
}

fn origin(m: &Affine) -> Vec3 {
    [m.m[3], m.m[7], m.m[11]]
}

struct Axis {
    point: Vec3,
    direction: Vec3,
}

impl Axis {
    fn along(&self, p: Vec3) -> f64 {
        dot(sub(p, self.point), self.direction)
    }

    fn off(&self, p: Vec3) -> Vec3 {
        let d = sub(p, self.point);
        sub(d, scaled(self.direction, dot(d, self.direction)))
    }

    fn radial(&self, p: Vec3) -> f64 {
        length(self.off(p))
    }

    fn canonical(&self) -> (Axis, f64) {
        let leading = self
            .direction
            .iter()
            .find(|c| c.abs() > IDENTIFY_LDU)
            .copied()
            .unwrap_or(1.0);
        let sign = if leading < 0.0 { -1.0 } else { 1.0 };
        let direction = scaled(self.direction, sign);
        let shift = dot(self.point, direction);
        let point = sub(self.point, scaled(direction, shift));
        (Axis { point, direction }, sign)
    }
}

fn round_frame(span: &ReferenceSpan) -> Option<(Axis, f64)> {
    let x = column(&span.matrix, 0);
    let y = column(&span.matrix, 1);
    let z = column(&span.matrix, 2);
    let radius = length(x);
    let height = length(y);
    if radius <= IDENTIFY_LDU || height <= IDENTIFY_LDU {
        return None;
    }
    let direction = scaled(y, 1.0 / height);
    let round = (length(z) - radius).abs() <= IDENTIFY_LDU
        && dot(x, direction).abs() <= IDENTIFY_LDU
        && dot(z, direction).abs() <= IDENTIFY_LDU
        && dot(x, z).abs() <= IDENTIFY_LDU * radius;
    round.then(|| {
        (
            Axis {
                point: origin(&span.matrix),
                direction,
            },
            radius,
        )
    })
}

fn front_normal(triangle: &Triangle) -> Vec3 {
    let [a, b, c] = triangle.points;
    cross(sub(b, a), sub(c, a))
}

fn centroid(triangle: &Triangle) -> Vec3 {
    let [a, b, c] = triangle.points;
    [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0)
}

fn outward_band(span: &ReferenceSpan, triangles: &[Triangle]) -> Option<RoundBand> {
    let (axis, radius) = round_frame(span)?;
    let surface: Vec<&Triangle> = triangles[span.triangles.clone()]
        .iter()
        .filter(|t| {
            t.points
                .iter()
                .all(|&p| (axis.radial(p) - radius).abs() <= IDENTIFY_LDU)
        })
        .collect();
    if surface.is_empty() || surface.iter().any(|t| t.double_sided) {
        return None;
    }
    let facing: Vec<f64> = surface
        .iter()
        .map(|t| dot(front_normal(t), axis.off(centroid(t))))
        .collect();
    if !facing.iter().all(|&f| f > 0.0) {
        return None;
    }
    let mut from = f64::INFINITY;
    let mut to = f64::NEG_INFINITY;
    for p in surface.iter().flat_map(|t| t.points) {
        let t = axis.along(p);
        from = from.min(t);
        to = to.max(t);
    }
    let (canonical, sign) = axis.canonical();
    let shift = dot(axis.point, canonical.direction);
    let (from, to) = if sign > 0.0 { (from, to) } else { (-to, -from) };
    Some(RoundBand {
        point: canonical.point,
        axis: canonical.direction,
        radius,
        from: from + shift,
        to: to + shift,
    })
}

fn same_line(a: &RoundBand, b: &RoundBand) -> bool {
    (0..3).all(|k| {
        (a.axis[k] - b.axis[k]).abs() <= IDENTIFY_LDU
            && (a.point[k] - b.point[k]).abs() <= IDENTIFY_LDU
    }) && (a.radius - b.radius).abs() <= IDENTIFY_LDU
}

pub fn outward_round_bands(spans: &[ReferenceSpan], triangles: &[Triangle]) -> Vec<RoundBand> {
    let mut pieces: Vec<RoundBand> = spans
        .iter()
        .filter(|span| is_circular_primitive(&span.reference))
        .filter_map(|span| outward_band(span, triangles))
        .collect();
    pieces.sort_by(|a, b| a.from.total_cmp(&b.from));
    let mut bands: Vec<RoundBand> = Vec::new();
    for piece in pieces {
        match bands
            .iter_mut()
            .find(|band| same_line(band, &piece) && piece.from <= band.to + IDENTIFY_LDU)
        {
            Some(band) => band.to = band.to.max(piece.to),
            None => bands.push(piece),
        }
    }
    bands
}

fn plane_face(band: &RoundBand, triangles: &[Triangle], at: f64, normal: Vec3) -> Option<EndFace> {
    let axis = Axis {
        point: band.point,
        direction: band.axis,
    };
    let within = |p: Vec3| axis.radial(p) <= band.radius + IDENTIFY_LDU;
    let in_plane: Vec<&Triangle> = triangles
        .iter()
        .filter(|t| {
            t.points
                .iter()
                .all(|&p| within(p) && (axis.along(p) - at).abs() <= IDENTIFY_LDU)
        })
        .collect();
    let radius = in_plane
        .iter()
        .flat_map(|t| t.points)
        .map(|p| axis.radial(p))
        .fold(None, |widest: Option<f64>, r| {
            Some(widest.map_or(r, |w| w.max(r)))
        })?;
    Some(EndFace {
        origin: [0, 1, 2].map(|k| band.point[k] + band.axis[k] * at + 0.0),
        normal,
        radius,
    })
}

pub fn end_faces(band: &RoundBand, triangles: &[Triangle]) -> Option<[EndFace; 2]> {
    let axis = Axis {
        point: band.point,
        direction: band.axis,
    };
    let mut near = f64::INFINITY;
    let mut far = f64::NEG_INFINITY;
    for p in triangles.iter().flat_map(|t| t.points) {
        if axis.radial(p) <= band.radius + IDENTIFY_LDU {
            let t = axis.along(p);
            near = near.min(t);
            far = far.max(t);
        }
    }
    if near > far {
        return None;
    }
    Some([
        plane_face(band, triangles, far, band.axis)?,
        plane_face(band, triangles, near, scaled(band.axis, -1.0))?,
    ])
}
