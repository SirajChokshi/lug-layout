use super::ray::Bounds;
use super::{corner_box, inverse, world_box, CoverInstance, PartSolid, StudShape};
use crate::affine::Vec3;
use crate::clip::{clip_to_box, polygon_area, Polygon};
use crate::lattice::STUD_LDU;
use crate::mesh::{Mesh, WELD_EPSILON_LDU};
use crate::trig::planar_length;

pub fn stud_field_collides(
    instances: &[CoverInstance],
    solids: &[PartSolid],
    stud: StudShape,
    phase: [u32; 2],
    floor_y: f64,
) -> bool {
    let reach = stud.inscribed_radius - WELD_EPSILON_LDU;
    let bottom = floor_y + WELD_EPSILON_LDU;
    let top = floor_y + stud.height - WELD_EPSILON_LDU;
    let in_band: Vec<(&CoverInstance, [Vec3; 2])> = instances
        .iter()
        .map(|instance| (instance, world_box(instance, &solids[instance.part])))
        .filter(|(_, [min, max])| min[1] < top && max[1] > bottom)
        .collect();
    let mut plan = Bounds::EMPTY;
    for (_, [min, max]) in &in_band {
        plan = plan.grow(*min).grow(*max);
    }
    if plan.min[0] > plan.max[0] {
        return false;
    }
    for x in stud_centres(plan.min[0] - reach, plan.max[0] + reach, phase[0]) {
        for z in stud_centres(plan.min[2] - reach, plan.max[2] + reach, phase[1]) {
            let low = [x - reach, bottom, z - reach];
            let high = [x + reach, top, z + reach];
            let reached = in_band.iter().any(|(instance, bounds)| {
                overlaps(bounds, low, high)
                    && solid_reaches(instance, &solids[instance.part], [low, high], [x, z], reach)
            });
            if reached {
                return true;
            }
        }
    }
    false
}

pub fn inscribed_radius(mesh: &Mesh) -> Option<f64> {
    let [min, max] = mesh.bounds()?;
    let centre = [
        (f64::from(min[0]) + f64::from(max[0])) / 2.0,
        (f64::from(min[2]) + f64::from(max[2])) / 2.0,
    ];
    let outer = (f64::from(max[0] - min[0]) / 2.0).max(f64::from(max[2] - min[2]) / 2.0);
    let (positions, _) = mesh.positions.as_chunks::<3>();
    let plan = |index: u32| {
        let p = positions[index as usize];
        [f64::from(p[0]) - centre[0], f64::from(p[2]) - centre[1]]
    };
    mesh.groups
        .iter()
        .flat_map(|group| group.indices.as_chunks::<3>().0)
        .filter_map(|triangle| outer_wall_distance(triangle.map(plan), outer))
        .reduce(f64::min)
}

fn outer_wall_distance(corners: [[f64; 2]; 3], outer: f64) -> Option<f64> {
    let on_rim = corners
        .iter()
        .all(|corner| planar_length(corner[0], corner[1]) >= outer - WELD_EPSILON_LDU);
    let [a, b, c] = corners;
    let upright = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) == 0.0;
    if !(on_rim && upright) {
        return None;
    }
    let span = |[p, q]: [[f64; 2]; 2]| planar_length(q[0] - p[0], q[1] - p[1]);
    let [p, q] = [[a, b], [b, c], [a, c]]
        .into_iter()
        .max_by(|x, y| span(*x).total_cmp(&span(*y)))?;
    Some(segment_distance(p, q))
}

fn stud_centres(min: f64, max: f64, phase: u32) -> impl Iterator<Item = f64> {
    let phase = f64::from(phase);
    let first = ((min - phase) / STUD_LDU).ceil() as i64;
    let last = ((max - phase) / STUD_LDU).floor() as i64;
    (first..=last).map(move |k| phase + STUD_LDU * k as f64)
}

fn overlaps([min, max]: &[Vec3; 2], low: Vec3, high: Vec3) -> bool {
    (0..3).all(|axis| min[axis] < high[axis] && max[axis] > low[axis])
}

fn solid_reaches(
    instance: &CoverInstance,
    solid: &PartSolid,
    [low, high]: [Vec3; 2],
    axis: [f64; 2],
    reach: f64,
) -> bool {
    let Some(to_part) = inverse(instance.matrix) else {
        return false;
    };
    let [local_min, local_max] = corner_box(&to_part, low, high);
    let mut reached = false;
    solid.tree.walk(|bounds, leaf| match leaf {
        None => {
            !reached
                && (0..3).all(|k| bounds.min[k] <= local_max[k] && bounds.max[k] >= local_min[k])
        }
        Some(range) => {
            for t in range {
                if reached {
                    break;
                }
                let triangle = solid.tree_points[t].map(|p| instance.matrix.apply(p));
                let clipped = clip_to_box(&triangle, low, high);
                reached = polygon_area(&clipped) > 0.0 && plan_distance(&clipped, axis) < reach;
            }
            false
        }
    });
    reached
}

fn plan_distance((points, len): &Polygon, axis: [f64; 2]) -> f64 {
    let plan: Vec<[f64; 2]> = points[..*len]
        .iter()
        .map(|p| [p[0] - axis[0], p[2] - axis[1]])
        .collect();
    if surrounds_axis(&plan) {
        return 0.0;
    }
    (0..plan.len())
        .map(|i| segment_distance(plan[i], plan[(i + 1) % plan.len()]))
        .fold(f64::INFINITY, f64::min)
}

fn surrounds_axis(plan: &[[f64; 2]]) -> bool {
    let mut turning = 0.0;
    for (i, a) in plan.iter().enumerate() {
        let b = plan[(i + 1) % plan.len()];
        let cross = a[0] * b[1] - a[1] * b[0];
        if cross == 0.0 {
            continue;
        }
        if turning == 0.0 {
            turning = cross.signum();
        } else if cross.signum() != turning {
            return false;
        }
    }
    turning != 0.0
}

fn segment_distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let along = [b[0] - a[0], b[1] - a[1]];
    let length = along[0] * along[0] + along[1] * along[1];
    let t = if length == 0.0 {
        0.0
    } else {
        (-(a[0] * along[0] + a[1] * along[1]) / length).clamp(0.0, 1.0)
    };
    planar_length(a[0] + along[0] * t, a[1] + along[1] * t)
}
