use std::collections::BTreeMap;

use super::{corner_box, inverse, world_box, CoverInstance, PartSolid, StudShape};
use crate::affine::{Affine, Vec3};
use crate::clip::{clip_to_box, polygon_area, Polygon, MAX_CLIPPED_VERTICES};
use crate::lattice::STUD_LDU;
use crate::mesh::{Mesh, WELD_EPSILON_LDU};
use crate::seat::{SeatProbe, StudIntrusion};
use crate::stud_fit::ReceptorSeats;
use crate::trig::planar_length;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Reading {
    First,
    Nearest,
}

pub struct StudField<'a> {
    instances: &'a [CoverInstance<'a>],
    solids: &'a [PartSolid],
    stud: StudShape,
    seats: &'a ReceptorSeats,
}

impl<'a> StudField<'a> {
    pub fn new(
        instances: &'a [CoverInstance<'a>],
        solids: &'a [PartSolid],
        stud: StudShape,
        seats: &'a ReceptorSeats,
    ) -> Self {
        StudField {
            instances,
            solids,
            stud,
            seats,
        }
    }

    fn reach(&self) -> f64 {
        self.stud.inscribed_radius - WELD_EPSILON_LDU
    }

    fn intruding(
        &self,
        index: usize,
        instance: &'a CoverInstance<'a>,
        phase: [u32; 2],
        floor_y: f64,
        reading: Reading,
    ) -> impl Iterator<Item = ([f64; 2], f64)> + 'a {
        let seats = self.seats;
        let reach = self.reach();
        let bottom = floor_y + WELD_EPSILON_LDU;
        let top = floor_y + self.stud.height - WELD_EPSILON_LDU;
        let solid = &self.solids[instance.part];
        let bounds = world_box(instance, solid);
        let [min, max] = bounds;
        let to_part = if min[1] < top && max[1] > bottom {
            inverse(instance.matrix)
        } else {
            None
        };
        to_part.into_iter().flat_map(move |to_part| {
            stud_centres(min[0] - reach, max[0] + reach, phase[0]).flat_map(move |x| {
                stud_centres(min[2] - reach, max[2] + reach, phase[1]).filter_map(move |z| {
                    let low = [x - reach, bottom, z - reach];
                    let high = [x + reach, top, z + reach];
                    if seats.seats(index, [x, floor_y, z]) || !overlaps(&bounds, low, high) {
                        return None;
                    }
                    let probe = [low, high];
                    nearest_reading(
                        instance.matrix,
                        &to_part,
                        solid,
                        probe,
                        [x, z],
                        reach,
                        reading,
                    )
                    .map(|distance| ([x, z], distance))
                })
            })
        })
    }
}

impl SeatProbe for StudField<'_> {
    fn seats(&self, phase: [u32; 2], floor_y: f64) -> bool {
        !self.instances.iter().enumerate().any(|(index, instance)| {
            self.intruding(index, instance, phase, floor_y, Reading::First)
                .next()
                .is_some()
        })
    }

    fn intrusions(&self, phase: [u32; 2], floor_y: f64) -> Vec<StudIntrusion> {
        let reach = self.reach();
        let mut deepest: BTreeMap<(i64, i64), StudIntrusion> = BTreeMap::new();
        for (index, instance) in self.instances.iter().enumerate() {
            for (at, distance) in self.intruding(index, instance, phase, floor_y, Reading::Nearest)
            {
                let found = StudIntrusion {
                    at,
                    depth: reach - distance,
                    instance: index,
                };
                deepest
                    .entry(lattice_key(at, phase))
                    .and_modify(|kept| {
                        if found.depth > kept.depth {
                            *kept = found;
                        }
                    })
                    .or_insert(found);
            }
        }
        deepest.into_values().collect()
    }
}

fn lattice_key(at: [f64; 2], phase: [u32; 2]) -> (i64, i64) {
    let step = |value: f64, phase: u32| ((value - f64::from(phase)) / STUD_LDU).round() as i64;
    (step(at[0], phase[0]), step(at[1], phase[1]))
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

fn nearest_reading(
    to_world: &Affine,
    to_part: &Affine,
    solid: &PartSolid,
    [low, high]: [Vec3; 2],
    axis: [f64; 2],
    reach: f64,
    reading: Reading,
) -> Option<f64> {
    let [local_min, local_max] = corner_box(to_part, low, high);
    let mut closest: Option<f64> = None;
    let settled = |closest: Option<f64>| reading == Reading::First && closest.is_some();
    solid.tree.walk(|bounds, leaf| match leaf {
        None => {
            !settled(closest)
                && (0..3).all(|k| bounds.min[k] <= local_max[k] && bounds.max[k] >= local_min[k])
        }
        Some(range) => {
            for t in range {
                if settled(closest) {
                    break;
                }
                let local = &solid.tree_points[t];
                if (0..3).any(|k| {
                    local.iter().all(|p| p[k] > local_max[k])
                        || local.iter().all(|p| p[k] < local_min[k])
                }) {
                    continue;
                }
                let triangle = local.map(|p| to_world.apply(p));
                let clipped = clip_to_box(&triangle, low, high);
                if polygon_area(&clipped) <= 0.0 {
                    continue;
                }
                let drawn = plan_distance(&clipped, axis);
                if drawn >= reach {
                    continue;
                }
                let distance = solid
                    .round_reading(t, to_world, &triangle, axis)
                    .map_or(drawn, |ideal| ideal.max(drawn));
                if distance < reach && closest.is_none_or(|kept| distance < kept) {
                    closest = Some(distance);
                }
            }
            false
        }
    });
    closest
}

fn plan_distance((points, len): &Polygon, axis: [f64; 2]) -> f64 {
    let mut plan = [[0.0; 2]; MAX_CLIPPED_VERTICES];
    for (to, p) in plan.iter_mut().zip(&points[..*len]) {
        *to = [p[0] - axis[0], p[2] - axis[1]];
    }
    let plan = &plan[..*len];
    if surrounds_axis(plan) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flatten::Triangle;
    use crate::lattice::{AxisPose, LatticeInstance};
    use crate::mesh;
    use crate::round::{PlacedRound, RoundShape};
    use crate::trig::{cos, sincos};

    const OPAQUE: u32 = 4;
    const HEIGHT: f64 = 4.0;
    const CORNERS: [[f64; 2]; 4] = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0]];

    fn triangle(points: [Vec3; 3]) -> Triangle {
        Triangle {
            color: OPAQUE,
            points,
            double_sided: false,
        }
    }

    fn corner(half: f64, k: usize, y: f64) -> Vec3 {
        rectangle_corner([half, half], k, y)
    }

    fn rectangle_corner([half_x, half_z]: [f64; 2], k: usize, y: f64) -> Vec3 {
        let [x, z] = CORNERS[k % CORNERS.len()];
        [x * half_x, y, z * half_z]
    }

    fn rectangle_wall(triangles: &mut Vec<Triangle>, halves: [f64; 2]) {
        for k in 0..CORNERS.len() {
            let [a, b] = [
                rectangle_corner(halves, k, 0.0),
                rectangle_corner(halves, k + 1, 0.0),
            ];
            let [c, d] = [
                rectangle_corner(halves, k + 1, HEIGHT),
                rectangle_corner(halves, k, HEIGHT),
            ];
            triangles.push(triangle([a, b, c]));
            triangles.push(triangle([a, c, d]));
        }
    }

    fn square_wall(triangles: &mut Vec<Triangle>, half: f64) {
        rectangle_wall(triangles, [half, half]);
    }

    fn square_annulus(triangles: &mut Vec<Triangle>, outer: f64, inner: f64) {
        for k in 0..CORNERS.len() {
            let [a, b] = [corner(outer, k, HEIGHT), corner(outer, k + 1, HEIGHT)];
            let [c, d] = [corner(inner, k + 1, HEIGHT), corner(inner, k, HEIGHT)];
            triangles.push(triangle([a, b, c]));
            triangles.push(triangle([a, c, d]));
        }
    }

    #[test]
    fn a_hollow_stud_measures_the_flats_of_its_outer_wall_and_ignores_its_inner_wall_and_top() {
        let half_width = 3.0;
        let mut triangles = Vec::new();
        square_wall(&mut triangles, half_width);
        square_wall(&mut triangles, 2.0);
        square_annulus(&mut triangles, half_width, 2.0);
        assert_eq!(
            inscribed_radius(&mesh::build(&triangles, &[])),
            Some(half_width)
        );
    }

    #[test]
    fn a_flat_cap_whose_corners_all_lie_on_the_rim_is_not_part_of_the_outer_wall() {
        let half_width = 3.0;
        let mut triangles = Vec::new();
        square_wall(&mut triangles, half_width);
        let cap = [0, 1, 2, 3].map(|k| corner(half_width, k, HEIGHT));
        triangles.push(triangle([cap[0], cap[1], cap[2]]));
        triangles.push(triangle([cap[0], cap[2], cap[3]]));
        assert_eq!(
            inscribed_radius(&mesh::build(&triangles, &[])),
            Some(half_width)
        );
    }

    #[test]
    fn an_outer_wall_measures_its_nearest_face() {
        let mut triangles = Vec::new();
        rectangle_wall(&mut triangles, [3.0, 2.5]);
        assert_eq!(inscribed_radius(&mesh::build(&triangles, &[])), Some(2.5));
    }

    #[test]
    fn a_primitive_without_an_upright_outer_wall_measures_nothing() {
        let half_width = 3.0;
        let centre = [0.0, HEIGHT, 0.0];
        let disc: Vec<Triangle> = (0..CORNERS.len())
            .map(|k| {
                triangle([
                    centre,
                    corner(half_width, k, HEIGHT),
                    corner(half_width, k + 1, HEIGHT),
                ])
            })
            .collect();
        let cone: Vec<Triangle> = (0..CORNERS.len())
            .map(|k| {
                triangle([
                    centre,
                    corner(half_width, k, 0.0),
                    corner(half_width, k + 1, 0.0),
                ])
            })
            .collect();
        assert_eq!(inscribed_radius(&mesh::build(&disc, &[])), None);
        assert_eq!(inscribed_radius(&mesh::build(&cone, &[])), None);
    }

    const ARC_RADIUS: f64 = 20.0;
    const ARC_HEIGHT: f64 = 24.0;
    const STUD_SEGMENTS: f64 = 16.0;

    fn standard_stud() -> StudShape {
        StudShape {
            height: HEIGHT,
            radius: 6.0,
            inscribed_radius: 6.0 * cos(std::f64::consts::PI / STUD_SEGMENTS),
        }
    }

    fn arc_point(center: [f64; 2], step: f64, y: f64) -> Vec3 {
        let (sin, cos) = sincos(std::f64::consts::TAU * step / STUD_SEGMENTS);
        [
            center[0] + ARC_RADIUS * cos,
            y,
            center[1] + ARC_RADIUS * sin,
        ]
    }

    fn arc_quad(center: [f64; 2], step: f64) -> Vec<Triangle> {
        let [a, b] = [step, step + 1.0].map(|s| arc_point(center, s, 0.0));
        let [c, d] = [step + 1.0, step].map(|s| arc_point(center, s, ARC_HEIGHT));
        vec![triangle([a, b, c]), triangle([a, c, d])]
    }

    fn arc_wall(center: [f64; 2]) -> PlacedRound {
        PlacedRound {
            axis: 1,
            center: [center[1], center[0]],
            shape: RoundShape::Wall {
                radius: ARC_RADIUS,
                from: 0.0,
                to: ARC_HEIGHT,
            },
        }
    }

    fn seats_at_origin(solid: PartSolid) -> bool {
        let instance = CoverInstance {
            matrix: &Affine::IDENTITY,
            color: OPAQUE,
            part: 0,
            studs: &[],
        };
        let instances = [instance];
        let solids = [solid];
        StudField::new(
            &instances,
            &solids,
            standard_stud(),
            &ReceptorSeats::default(),
        )
        .seats([0, 0], 0.0)
    }

    #[test]
    fn a_round_wall_counts_against_a_stud_only_where_both_its_drawn_chord_and_its_ideal_circle_reach_the_stud(
    ) {
        let (sin, cos) = sincos(std::f64::consts::TAU * 0.5 / STUD_SEGMENTS);
        let outside = ARC_RADIUS + 5.6;
        let cases = [
            ([-10.0, -10.0], 1.0, false, true),
            ([-outside * cos, -outside * sin], 0.0, true, true),
        ];
        for (center, step, as_drawn, with_its_round) in cases {
            let mesh = mesh::build(&arc_quad(center, step), &[]);
            assert_eq!(
                seats_at_origin(PartSolid::from_mesh(&mesh)),
                as_drawn,
                "{center:?} as drawn"
            );
            assert_eq!(
                seats_at_origin(PartSolid::from_mesh(&mesh).with_rounds(&[arc_wall(center)])),
                with_its_round,
                "{center:?} with its round"
            );
        }
    }

    #[test]
    fn a_receptor_that_takes_the_stud_vouches_for_its_own_parts_cavity_and_never_for_another_part()
    {
        const STUD: StudShape = StudShape {
            height: HEIGHT,
            radius: 6.0,
            inscribed_radius: 5.8848,
        };
        const TIGHT_CAVITY: f64 = 5.5;
        const DOWN: Vec3 = [0.0, -1.0, 0.0];
        let mut walls = Vec::new();
        square_wall(&mut walls, TIGHT_CAVITY);
        let solids = [PartSolid::from_mesh(&mesh::build(&walls, &[]))];
        let at = Affine::IDENTITY;
        let cavity = || CoverInstance {
            matrix: &at,
            color: OPAQUE,
            part: 0,
            studs: &[],
        };
        let receptor = |axis: Vec3| {
            [AxisPose {
                origin: [0.0, 0.0, 0.0],
                axis,
            }]
        };
        let (downward, upward) = (receptor(DOWN), receptor([0.0, 1.0, 0.0]));
        let seats_of = |receptors: &[AxisPose]| {
            ReceptorSeats::of(&[LatticeInstance {
                matrix: &at,
                studs: &[],
                receptors,
                bounds_min: [-TIGHT_CAVITY, 0.0, -TIGHT_CAVITY],
                bounds_max: [TIGHT_CAVITY, HEIGHT, TIGHT_CAVITY],
            }])
        };
        let collides = |instances: &[CoverInstance], seats: &ReceptorSeats| {
            !StudField::new(instances, &solids, STUD, seats).seats([0, 0], 0.0)
        };

        assert!(collides(&[cavity()], &ReceptorSeats::default()));
        assert!(collides(&[cavity()], &seats_of(&upward)));
        assert!(!collides(&[cavity()], &seats_of(&downward)));
        assert!(collides(&[cavity(), cavity()], &seats_of(&downward)));
    }
}
