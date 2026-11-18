use crate::affine::Vec3;

const MAX_CLIPPED_VERTICES: usize = 12;

pub type Polygon = ([Vec3; MAX_CLIPPED_VERTICES], usize);

fn clip_axis(polygon: &Polygon, axis: usize, bound: f64, keep_above: bool) -> Polygon {
    let (points, len) = polygon;
    let mut out = ([[0.0; 3]; MAX_CLIPPED_VERTICES], 0);
    if *len == 0 {
        return out;
    }
    let inside = |p: &Vec3| {
        if keep_above {
            p[axis] >= bound
        } else {
            p[axis] <= bound
        }
    };
    for i in 0..*len {
        let current = points[i];
        let next = points[(i + 1) % len];
        let current_in = inside(&current);
        let next_in = inside(&next);
        if current_in && out.1 < MAX_CLIPPED_VERTICES {
            out.0[out.1] = current;
            out.1 += 1;
        }
        if current_in != next_in && out.1 < MAX_CLIPPED_VERTICES {
            let t = (bound - current[axis]) / (next[axis] - current[axis]);
            let mut crossing = [0.0; 3];
            for k in 0..3 {
                crossing[k] = current[k] + t * (next[k] - current[k]);
            }
            crossing[axis] = bound;
            out.0[out.1] = crossing;
            out.1 += 1;
        }
    }
    out
}

pub fn clip_to_box(triangle: &[Vec3; 3], low: Vec3, high: Vec3) -> Polygon {
    let mut polygon: Polygon = ([[0.0; 3]; MAX_CLIPPED_VERTICES], 3);
    polygon.0[..3].copy_from_slice(triangle);
    for axis in 0..3 {
        polygon = clip_axis(&polygon, axis, low[axis], true);
        polygon = clip_axis(&polygon, axis, high[axis], false);
    }
    polygon
}

pub fn polygon_area(polygon: &Polygon) -> f64 {
    let (points, len) = polygon;
    if *len < 3 {
        return 0.0;
    }
    let origin = points[0];
    let mut sum = [0.0; 3];
    for i in 1..len - 1 {
        let a = [
            points[i][0] - origin[0],
            points[i][1] - origin[1],
            points[i][2] - origin[2],
        ];
        let b = [
            points[i + 1][0] - origin[0],
            points[i + 1][1] - origin[1],
            points[i + 1][2] - origin[2],
        ];
        sum[0] += a[1] * b[2] - a[2] * b[1];
        sum[1] += a[2] * b[0] - a[0] * b[2];
        sum[2] += a[0] * b[1] - a[1] * b[0];
    }
    0.5 * (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt()
}
