use std::collections::BTreeMap;

use crate::affine::{Affine, Vec3};
pub use crate::identify::IDENTIFY_LDU;

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
pub struct StudPose {
    pub origin: Vec3,
    pub axis: Vec3,
}

impl StudPose {
    pub fn of(matrix: &Affine) -> StudPose {
        StudPose {
            origin: [matrix.m[3], matrix.m[7], matrix.m[11]],
            axis: [matrix.m[1], matrix.m[5], matrix.m[9]],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LatticeInstance<'a> {
    pub matrix: &'a Affine,
    pub studs: &'a [StudPose],
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelLattice {
    pub phase: [u32; 2],
    pub phase_layer_y: f64,
    pub phase_layer_studs: usize,
    pub phase_layer_agreeing: usize,
    pub aabb_min: Vec3,
    pub aabb_max: Vec3,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LatticeError {
    NoInstances,
    NoIntegerPhaseStuds,
    TiedPhase { layer_y: f64, phases: Vec<[u32; 2]> },
}

impl std::fmt::Display for LatticeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LatticeError::NoInstances => write!(f, "model has no part instances"),
            LatticeError::NoIntegerPhaseStuds => {
                write!(f, "model has no stud on an integer lattice phase")
            }
            LatticeError::TiedPhase { layer_y, phases } => write!(
                f,
                "lowest stud layer at y = {layer_y} has tied lattice phases {phases:?}"
            ),
        }
    }
}

fn vertical(axis: Vec3) -> bool {
    axis[0] == 0.0 && axis[2] == 0.0 && axis[1] != 0.0
}

fn integer_phase(value: f64) -> Option<u32> {
    let phase = value.rem_euclid(STUD_LDU);
    (phase.fract() == 0.0).then_some(phase as u32 % STUD_LDU as u32)
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

pub fn model_lattice(instances: &[LatticeInstance]) -> Result<ModelLattice, LatticeError> {
    if instances.is_empty() {
        return Err(LatticeError::NoInstances);
    }
    let mut aabb_min = [f64::INFINITY; 3];
    let mut aabb_max = [f64::NEG_INFINITY; 3];
    let mut layers: BTreeMap<i64, BTreeMap<[u32; 2], usize>> = BTreeMap::new();
    for instance in instances {
        for corner in corners(instance.bounds_min, instance.bounds_max) {
            let p = instance.matrix.apply(corner);
            for axis in 0..3 {
                aabb_min[axis] = aabb_min[axis].min(p[axis]);
                aabb_max[axis] = aabb_max[axis].max(p[axis]);
            }
        }
        for stud in instance.studs {
            if !vertical(instance.matrix.rotate(stud.axis)) {
                continue;
            }
            let p = instance.matrix.apply(stud.origin);
            let (Some(px), Some(pz)) = (integer_phase(p[0]), integer_phase(p[2])) else {
                continue;
            };
            let layer = (p[1] * LAYER_KEY_SCALE).round() as i64;
            *layers
                .entry(layer)
                .or_default()
                .entry([px, pz])
                .or_default() += 1;
        }
    }
    let (&layer, phases) = layers
        .iter()
        .next()
        .ok_or(LatticeError::NoIntegerPhaseStuds)?;
    let layer_y = layer as f64 / LAYER_KEY_SCALE;
    let best = phases.values().copied().max().unwrap_or(0);
    let winners: Vec<[u32; 2]> = phases
        .iter()
        .filter(|(_, &count)| count == best)
        .map(|(&phase, _)| phase)
        .collect();
    let [phase] = winners.as_slice() else {
        return Err(LatticeError::TiedPhase {
            layer_y,
            phases: winners,
        });
    };
    Ok(ModelLattice {
        phase: *phase,
        phase_layer_y: layer_y,
        phase_layer_studs: phases.values().sum(),
        phase_layer_agreeing: best,
        aabb_min: aabb_min.map(|v| v + 0.0),
        aabb_max: aabb_max.map(|v| v + 0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: f64, y: f64, z: f64) -> Affine {
        Affine {
            m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z],
        }
    }

    const UP: Vec3 = [0.0, 1.0, 0.0];
    const BRICK_STUDS: [StudPose; 2] = [
        StudPose {
            origin: [-10.0, 24.0, 0.0],
            axis: UP,
        },
        StudPose {
            origin: [10.0, 24.0, 0.0],
            axis: UP,
        },
    ];

    fn brick(matrix: &Affine) -> LatticeInstance<'_> {
        LatticeInstance {
            matrix,
            studs: &BRICK_STUDS,
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
        let lattice = model_lattice(&instances).expect("lattice");
        assert_eq!(lattice.phase, [10, 0]);
        assert_eq!(lattice.phase_layer_y, 24.0);
        assert_eq!(lattice.aabb_min, [-20.0, 0.0, -10.0]);
        assert_eq!(lattice.aabb_max, [105.0, 52.0, 10.0]);
    }

    const HUB_STUDS: [StudPose; 2] = [
        StudPose {
            origin: [0.0, 0.0, -12.0],
            axis: [0.0, 0.0, -1.0],
        },
        StudPose {
            origin: [0.0, 0.0, 12.0],
            axis: [0.0, 0.0, 1.0],
        },
    ];

    fn wheel(matrix: &Affine) -> LatticeInstance<'_> {
        LatticeInstance {
            matrix,
            studs: &HUB_STUDS,
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
        let lattice = model_lattice(&instances).expect("lattice");
        assert_eq!(lattice.phase, [15, 0]);
        assert_eq!(lattice.phase_layer_y, 36.0);
        assert_eq!(lattice.phase_layer_studs, 2);
    }

    #[test]
    fn downward_studs_phase_the_lattice_like_upward_ones() {
        let inverted = Affine {
            m: [
                1.0, 0.0, 0.0, 5.0, 0.0, -1.0, 0.0, 30.0, 0.0, 0.0, -1.0, 0.0,
            ],
        };
        let lattice = model_lattice(&[brick(&inverted)]).expect("lattice");
        assert_eq!(lattice.phase, [15, 0]);
        assert_eq!(lattice.phase_layer_y, 6.0);
    }

    #[test]
    fn a_tie_in_the_lowest_layer_is_an_error_not_a_guess() {
        let a = at(0.0, 0.0, 0.0);
        let b = at(5.0, 0.0, 0.0);
        let error = model_lattice(&[brick(&a), brick(&b)]).expect_err("tie");
        assert!(matches!(error, LatticeError::TiedPhase { .. }));
    }
}
