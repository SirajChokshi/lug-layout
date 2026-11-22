use std::collections::BTreeMap;

use crate::affine::{Affine, Vec3};
pub use crate::identify::IDENTIFY_LDU;
use crate::identify::{sixteenths, SIXTEENTHS_PER_LDU};

pub const STUD_LDU: f64 = 20.0;
pub const RESOLVABLE_LDU: f64 = IDENTIFY_LDU / f64::EPSILON;
const LAYER_KEY_SCALE: f64 = 1_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Malformation {
    NonFinite,
    Unparsed,
    Unresolvable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MalformedGeometry {
    pub file: String,
    pub malformation: Malformation,
}

pub fn describe_malformed(findings: &[MalformedGeometry]) -> String {
    let described: Vec<String> = findings
        .iter()
        .map(|finding| {
            let what = match finding.malformation {
                Malformation::NonFinite => "a non-finite number",
                Malformation::Unparsed => "a line that does not parse",
                Malformation::Unresolvable => "a position beyond the resolvable range",
            };
            format!("{what} in {}", finding.file)
        })
        .collect();
    format!("malformed geometry: {}", described.join("; "))
}

pub fn non_finite(values: &[f64]) -> bool {
    values.iter().any(|value| !value.is_finite())
}

pub fn unplaceable(values: &[f64]) -> Option<Malformation> {
    if non_finite(values) {
        Some(Malformation::NonFinite)
    } else if values.iter().any(|value| value.abs() > RESOLVABLE_LDU) {
        Some(Malformation::Unresolvable)
    } else {
        None
    }
}

pub fn record(found: &mut Vec<MalformedGeometry>, file: &str, malformation: Malformation) {
    let finding = MalformedGeometry {
        file: file.to_string(),
        malformation,
    };
    if !found.contains(&finding) {
        found.push(finding);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisPose {
    pub origin: Vec3,
    pub axis: Vec3,
}

impl AxisPose {
    pub fn of(matrix: &Affine) -> AxisPose {
        AxisPose {
            origin: [matrix.m[3], matrix.m[7], matrix.m[11]],
            axis: [matrix.m[1], matrix.m[5], matrix.m[9]],
        }
    }

    pub fn of_face(sixteenths: [i32; 3], direction: u8) -> Option<AxisPose> {
        let dimension = usize::from(direction / 2);
        if dimension >= 3 {
            return None;
        }
        let mut axis = [0.0; 3];
        axis[dimension] = if direction.is_multiple_of(2) {
            1.0
        } else {
            -1.0
        };
        Some(AxisPose {
            origin: sixteenths.map(|steps| f64::from(steps) / f64::from(SIXTEENTHS_PER_LDU)),
            axis,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LatticeInstance<'a> {
    pub matrix: &'a Affine,
    pub studs: &'a [AxisPose],
    pub receptors: &'a [AxisPose],
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelLattice {
    pub phase: [u32; 2],
    pub phase_layer_y: f64,
    pub phase_layer_votes: usize,
    pub phase_layer_agreeing: usize,
    pub aabb_min: Vec3,
    pub aabb_max: Vec3,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LatticeError {
    NoInstances,
    NoIntegerPhase,
    TiedPhase { layer_y: f64, phases: Vec<[u32; 2]> },
}

impl std::fmt::Display for LatticeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LatticeError::NoInstances => write!(f, "model has no part instances"),
            LatticeError::NoIntegerPhase => write!(
                f,
                "model has no stud on an integer lattice phase, and stands on no receptor that seats on a stud field"
            ),
            LatticeError::TiedPhase { layer_y, phases } => write!(
                f,
                "lowest stud layer at y = {layer_y} has tied lattice phases {phases:?}, and no receptor phase the model stands on seats"
            ),
        }
    }
}

type PhaseLayers = BTreeMap<i64, BTreeMap<[u32; 2], usize>>;

struct LayerPhase {
    phase: [u32; 2],
    votes: usize,
    agreeing: usize,
}

struct Standing {
    floor_y: f64,
    phase: LayerPhase,
}

fn vertical(axis: Vec3) -> bool {
    axis[0] == 0.0 && axis[2] == 0.0 && axis[1] != 0.0
}

fn downward(axis: Vec3) -> bool {
    axis[0] == 0.0 && axis[2] == 0.0 && axis[1] < 0.0
}

fn integer_phase(value: f64) -> Option<u32> {
    let phase = value.rem_euclid(STUD_LDU);
    (phase.fract() == 0.0).then_some(phase as u32 % STUD_LDU as u32)
}

fn sixteenth_phase(steps: i64) -> Option<u32> {
    let per_ldu = i64::from(SIXTEENTHS_PER_LDU);
    let stud_steps = STUD_LDU as i64 * per_ldu;
    let phase = steps.rem_euclid(stud_steps);
    (phase % per_ldu == 0).then_some((phase / per_ldu) as u32)
}

fn layer_key(y: f64) -> i64 {
    (y * LAYER_KEY_SCALE).round() as i64
}

fn count_vertical(layers: &mut PhaseLayers, matrix: &Affine, poses: &[AxisPose]) {
    for pose in poses {
        if !vertical(matrix.rotate(pose.axis)) {
            continue;
        }
        let p = matrix.apply(pose.origin);
        let (Some(px), Some(pz)) = (integer_phase(p[0]), integer_phase(p[2])) else {
            continue;
        };
        *layers
            .entry(layer_key(p[1]))
            .or_default()
            .entry([px, pz])
            .or_default() += 1;
    }
}

fn majority(phases: &BTreeMap<[u32; 2], usize>) -> Result<LayerPhase, Vec<[u32; 2]>> {
    let best = phases.values().copied().max().unwrap_or(0);
    let winners: Vec<[u32; 2]> = phases
        .iter()
        .filter(|(_, &count)| count == best)
        .map(|(&phase, _)| phase)
        .collect();
    match winners.as_slice() {
        [phase] => Ok(LayerPhase {
            phase: *phase,
            votes: phases.values().sum(),
            agreeing: best,
        }),
        _ => Err(winners),
    }
}

fn stood_on(instances: &[LatticeInstance], underside: i64) -> Option<Standing> {
    let mut phases: BTreeMap<[u32; 2], usize> = BTreeMap::new();
    for instance in instances {
        for receptor in instance.receptors {
            if !downward(instance.matrix.rotate(receptor.axis)) {
                continue;
            }
            let p = instance.matrix.apply(receptor.origin);
            let (Some(x), Some(y), Some(z)) =
                (sixteenths(p[0]), sixteenths(p[1]), sixteenths(p[2]))
            else {
                continue;
            };
            if y != underside {
                continue;
            }
            if let (Some(px), Some(pz)) = (sixteenth_phase(x), sixteenth_phase(z)) {
                *phases.entry([px, pz]).or_default() += 1;
            }
        }
    }
    let phase = majority(&phases).ok()?;
    Some(Standing {
        floor_y: underside as f64 / f64::from(SIXTEENTHS_PER_LDU),
        phase,
    })
}

fn corners(min: Vec3, max: Vec3) -> [Vec3; 8] {
    let mut out = [[0.0; 3]; 8];
    for (i, corner) in out.iter_mut().enumerate() {
        *corner = [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ];
    }
    out
}

pub fn model_lattice(
    instances: &[LatticeInstance],
    mut collides: impl FnMut([u32; 2], f64) -> bool,
) -> Result<ModelLattice, LatticeError> {
    if instances.is_empty() {
        return Err(LatticeError::NoInstances);
    }
    let mut aabb_min = [f64::INFINITY; 3];
    let mut aabb_max = [f64::NEG_INFINITY; 3];
    let mut studs = PhaseLayers::new();
    for instance in instances {
        for corner in corners(instance.bounds_min, instance.bounds_max) {
            let p = instance.matrix.apply(corner);
            for axis in 0..3 {
                aabb_min[axis] = aabb_min[axis].min(p[axis]);
                aabb_max[axis] = aabb_max[axis].max(p[axis]);
            }
        }
        count_vertical(&mut studs, instance.matrix, instance.studs);
    }
    let lattice = |layer_y: f64, phase: LayerPhase| ModelLattice {
        phase: phase.phase,
        phase_layer_y: layer_y + 0.0,
        phase_layer_votes: phase.votes,
        phase_layer_agreeing: phase.agreeing,
        aabb_min: aabb_min.map(|v| v + 0.0),
        aabb_max: aabb_max.map(|v| v + 0.0),
    };
    let standing = sixteenths(aabb_min[1]).and_then(|underside| stood_on(instances, underside));
    let Some((&layer, phases)) = studs.iter().next() else {
        return match standing {
            Some(receptors) if !collides(receptors.phase.phase, receptors.floor_y) => {
                Ok(lattice(receptors.floor_y, receptors.phase))
            }
            _ => Err(LatticeError::NoIntegerPhase),
        };
    };
    let layer_y = layer as f64 / LAYER_KEY_SCALE;
    let stud = match majority(phases) {
        Ok(stud) => stud,
        Err(tied) => {
            return match standing {
                Some(receptors) if !collides(receptors.phase.phase, receptors.floor_y) => {
                    Ok(lattice(layer_y, receptors.phase))
                }
                _ => Err(LatticeError::TiedPhase {
                    layer_y,
                    phases: tied,
                }),
            };
        }
    };
    match standing {
        Some(receptors)
            if receptors.phase.phase != stud.phase
                && collides(stud.phase, receptors.floor_y)
                && !collides(receptors.phase.phase, receptors.floor_y) =>
        {
            Ok(lattice(layer_y, receptors.phase))
        }
        _ => Ok(lattice(layer_y, stud)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: f64, y: f64, z: f64) -> Affine {
        Affine {
            m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z],
        }
    }

    fn no_collision(_: [u32; 2], _: f64) -> bool {
        false
    }

    const UP: Vec3 = [0.0, 1.0, 0.0];
    const DOWN: Vec3 = [0.0, -1.0, 0.0];
    const NONE: [AxisPose; 0] = [];
    const BRICK_STUDS: [AxisPose; 2] = [
        AxisPose {
            origin: [-10.0, 24.0, 0.0],
            axis: UP,
        },
        AxisPose {
            origin: [10.0, 24.0, 0.0],
            axis: UP,
        },
    ];

    fn brick(matrix: &Affine) -> LatticeInstance<'_> {
        LatticeInstance {
            matrix,
            studs: &BRICK_STUDS,
            receptors: &NONE,
            bounds_min: [-20.0, 0.0, -10.0],
            bounds_max: [20.0, 28.0, 10.0],
        }
    }

    #[test]
    fn the_lowest_integer_stud_layer_decides_the_phase_over_a_larger_upper_layer() {
        let base = at(0.0, 0.0, 0.0);
        let upper = [at(5.0, 24.0, 0.0), at(45.0, 24.0, 0.0), at(85.0, 24.0, 0.0)];
        let mut instances = vec![brick(&base)];
        instances.extend(upper.iter().map(brick));
        let lattice = model_lattice(&instances, no_collision).expect("lattice");
        assert_eq!(lattice.phase, [10, 0]);
        assert_eq!(lattice.phase_layer_y, 24.0);
        assert_eq!(lattice.aabb_min, [-20.0, 0.0, -10.0]);
        assert_eq!(lattice.aabb_max, [105.0, 52.0, 10.0]);
    }

    const HUB_STUDS: [AxisPose; 2] = [
        AxisPose {
            origin: [0.0, 0.0, -12.0],
            axis: [0.0, 0.0, -1.0],
        },
        AxisPose {
            origin: [0.0, 0.0, 12.0],
            axis: [0.0, 0.0, 1.0],
        },
    ];

    fn wheel(matrix: &Affine) -> LatticeInstance<'_> {
        LatticeInstance {
            matrix,
            studs: &HUB_STUDS,
            receptors: &NONE,
            bounds_min: [-9.0, -9.0, -12.0],
            bounds_max: [9.0, 9.0, 12.0],
        }
    }

    #[test]
    fn studs_off_the_vertical_never_phase_the_lattice_though_they_lie_lowest() {
        let wheels = [at(-27.0, 9.0, 40.0), at(33.0, 9.0, -40.0)];
        let body = at(5.0, 12.0, 0.0);
        let mut instances: Vec<LatticeInstance> = wheels.iter().map(wheel).collect();
        instances.push(brick(&body));
        let lattice = model_lattice(&instances, no_collision).expect("lattice");
        assert_eq!(lattice.phase, [15, 0]);
        assert_eq!(lattice.phase_layer_y, 36.0);
        assert_eq!(lattice.phase_layer_votes, 2);
    }

    #[test]
    fn downward_studs_phase_the_lattice_like_upward_ones() {
        let inverted = Affine {
            m: [
                1.0, 0.0, 0.0, 5.0, 0.0, -1.0, 0.0, 30.0, 0.0, 0.0, -1.0, 0.0,
            ],
        };
        let lattice = model_lattice(&[brick(&inverted)], no_collision).expect("lattice");
        assert_eq!(lattice.phase, [15, 0]);
        assert_eq!(lattice.phase_layer_y, 6.0);
    }

    #[test]
    fn a_tie_in_the_lowest_layer_is_an_error_not_a_guess() {
        let a = at(0.0, 0.0, 0.0);
        let b = at(5.0, 0.0, 0.0);
        let error = model_lattice(&[brick(&a), brick(&b)], no_collision).expect_err("tie");
        assert!(matches!(error, LatticeError::TiedPhase { .. }));
    }

    #[test]
    fn a_tied_stud_layer_takes_the_receptor_phase_where_it_seats_and_stays_an_error_where_it_does_not(
    ) {
        const ONE_BY_ONE_STUD: [AxisPose; 1] = [AxisPose {
            origin: [0.0, 8.0, 0.0],
            axis: UP,
        }];
        const ONE_BY_ONE_UNDERSIDE: [AxisPose; 1] = [AxisPose {
            origin: [0.0, 0.0, 0.0],
            axis: DOWN,
        }];
        let jumper = at(0.0, 0.0, 0.0);
        let plate = at(10.0, 0.0, 20.0);
        let instances = [
            one_by_two(&jumper, &CENTRE_STUD, &ONE_BY_TWO_UNDERSIDE),
            LatticeInstance {
                matrix: &plate,
                studs: &ONE_BY_ONE_STUD,
                receptors: &ONE_BY_ONE_UNDERSIDE,
                bounds_min: [-10.0, 0.0, -10.0],
                bounds_max: [10.0, 8.0, 10.0],
            },
        ];
        let seated = model_lattice(&instances, no_collision).expect("its receptors frame it");
        assert_eq!((seated.phase, seated.phase_layer_y), ([10, 0], 8.0));
        let refused = model_lattice(&instances, |_, _| true).expect_err("nothing seats");
        assert!(matches!(refused, LatticeError::TiedPhase { .. }));
    }

    const ONE_BY_TWO_UNDERSIDE: [AxisPose; 2] = [
        AxisPose {
            origin: [-10.0, 0.0, 0.0],
            axis: DOWN,
        },
        AxisPose {
            origin: [10.0, 0.0, 0.0],
            axis: DOWN,
        },
    ];
    const CENTRE_STUD: [AxisPose; 1] = [AxisPose {
        origin: [0.0, 8.0, 0.0],
        axis: UP,
    }];

    fn one_by_two<'a>(
        matrix: &'a Affine,
        studs: &'static [AxisPose],
        receptors: &'static [AxisPose],
    ) -> LatticeInstance<'a> {
        LatticeInstance {
            matrix,
            studs,
            receptors,
            bounds_min: [-20.0, 0.0, -10.0],
            bounds_max: [20.0, 8.0, 10.0],
        }
    }

    #[test]
    fn a_part_without_studs_takes_its_phase_and_height_from_the_receptors_it_stands_on() {
        let tile = at(0.0, 0.0, 0.0);
        let mut seen = Vec::new();
        let lattice = model_lattice(
            &[one_by_two(&tile, &NONE, &ONE_BY_TWO_UNDERSIDE)],
            |phase, floor_y| {
                seen.push((phase, floor_y));
                false
            },
        )
        .expect("the tile stands on its two receptors");
        assert_eq!(lattice.phase, [10, 0]);
        assert_eq!(lattice.phase_layer_y, 0.0);
        assert_eq!(
            (lattice.phase_layer_votes, lattice.phase_layer_agreeing),
            (2, 2)
        );
        assert_eq!(seen, vec![([10, 0], 0.0)]);
    }

    #[test]
    fn a_part_without_studs_whose_receptor_frame_collides_with_a_stud_field_gets_no_lattice() {
        let tile = at(0.0, 0.0, 0.0);
        let error = model_lattice(
            &[one_by_two(&tile, &NONE, &ONE_BY_TWO_UNDERSIDE)],
            |_, _| true,
        )
        .expect_err("no frame seats");
        assert_eq!(error, LatticeError::NoIntegerPhase);
    }

    #[test]
    fn a_part_keeps_its_stud_phase_wherever_that_phase_seats_on_a_stud_field() {
        let jumper = at(0.0, 0.0, 0.0);
        let instances = [one_by_two(&jumper, &CENTRE_STUD, &ONE_BY_TWO_UNDERSIDE)];
        let seats = model_lattice(&instances, no_collision).expect("lattice");
        let both_collide = model_lattice(&instances, |_, _| true).expect("lattice");
        assert_eq!((seats.phase, seats.phase_layer_y), ([0, 0], 8.0));
        assert_eq!(
            (both_collide.phase, both_collide.phase_layer_y),
            ([0, 0], 8.0)
        );
    }

    #[test]
    fn a_part_takes_its_receptor_phase_where_only_that_phase_seats_and_keeps_its_stud_height() {
        let jumper = at(0.0, 0.0, 0.0);
        let lattice = model_lattice(
            &[one_by_two(&jumper, &CENTRE_STUD, &ONE_BY_TWO_UNDERSIDE)],
            |phase, _| phase == [0, 0],
        )
        .expect("the jumper seats on its receptors");
        assert_eq!(lattice.phase, [10, 0]);
        assert_eq!(lattice.phase_layer_y, 8.0);
    }

    #[test]
    fn receptors_that_point_up_or_lie_above_the_underside_never_stand() {
        const UPWARD: [AxisPose; 2] = [
            AxisPose {
                origin: [-10.0, 0.0, 0.0],
                axis: UP,
            },
            AxisPose {
                origin: [10.0, 0.0, 0.0],
                axis: UP,
            },
        ];
        const RAISED: [AxisPose; 2] = [
            AxisPose {
                origin: [-10.0, 4.0, 0.0],
                axis: DOWN,
            },
            AxisPose {
                origin: [10.0, 4.0, 0.0],
                axis: DOWN,
            },
        ];
        let tile = at(0.0, 0.0, 0.0);
        for receptors in [&UPWARD, &RAISED] {
            let error = model_lattice(&[one_by_two(&tile, &NONE, receptors)], no_collision)
                .expect_err("nothing stands");
            assert_eq!(error, LatticeError::NoIntegerPhase);
        }
    }

    #[test]
    fn a_receptor_stands_when_it_and_the_underside_identify_to_one_sixteenth_and_reports_it_exactly(
    ) {
        let identified = |box_y: f64, receptor_y: f64| {
            let receptors = [AxisPose {
                origin: [10.0, receptor_y, 10.0],
                axis: DOWN,
            }];
            let matrix = at(0.0, 0.0, 0.0);
            let instance = LatticeInstance {
                matrix: &matrix,
                studs: &NONE,
                receptors: &receptors,
                bounds_min: [0.0, box_y, 0.0],
                bounds_max: [20.0, box_y + 8.0, 20.0],
            };
            model_lattice(&[instance], no_collision).map(|lattice| lattice.phase_layer_y)
        };
        assert_eq!(identified(0.0625, 0.0625), Ok(0.0625));
        assert_eq!(identified(8.0625, 8.0625), Ok(8.0625));
        assert_eq!(identified(-0.0004, 0.0004), Ok(0.0));
        assert_eq!(identified(23.9995, 24.0), Ok(24.0));
        assert_eq!(identified(0.0, 0.0625), Err(LatticeError::NoIntegerPhase));
        assert_eq!(identified(0.0, 0.03), Err(LatticeError::NoIntegerPhase));
    }

    #[test]
    fn receptors_that_tie_on_the_underside_leave_the_phase_to_the_lowest_studs() {
        const ONE_BY_ONE_UNDERSIDE: [AxisPose; 1] = [AxisPose {
            origin: [0.0, 0.0, 0.0],
            axis: DOWN,
        }];
        let tiles = [at(0.0, 0.0, 0.0), at(25.0, 0.0, 0.0)];
        let mut instances: Vec<LatticeInstance> = tiles
            .iter()
            .map(|matrix| LatticeInstance {
                matrix,
                studs: &NONE,
                receptors: &ONE_BY_ONE_UNDERSIDE,
                bounds_min: [-10.0, 0.0, -10.0],
                bounds_max: [10.0, 8.0, 10.0],
            })
            .collect();
        let plate = at(0.0, 8.0, 0.0);
        const PLATE_STUDS: [AxisPose; 2] = [
            AxisPose {
                origin: [-10.0, 8.0, 0.0],
                axis: UP,
            },
            AxisPose {
                origin: [10.0, 8.0, 0.0],
                axis: UP,
            },
        ];
        instances.push(one_by_two(&plate, &PLATE_STUDS, &NONE));
        let lattice = model_lattice(&instances, |_, _| true).expect("the plate's studs phase it");
        assert_eq!(lattice.phase, [10, 0]);
        assert_eq!(lattice.phase_layer_y, 16.0);
    }

    #[test]
    fn a_face_direction_names_a_signed_axis_and_its_origin_counts_sixteenths() {
        assert_eq!(
            AxisPose::of_face([-160, -128, 8], 3),
            Some(AxisPose {
                origin: [-10.0, -8.0, 0.5],
                axis: DOWN,
            })
        );
        assert_eq!(
            AxisPose::of_face([0, 0, 0], 4).map(|face| face.axis),
            Some([0.0, 0.0, 1.0])
        );
        assert_eq!(AxisPose::of_face([0, 0, 0], 6), None);
    }
}
