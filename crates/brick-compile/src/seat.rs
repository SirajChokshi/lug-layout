use crate::lattice::{model_lattice, LatticeError, LatticeInstance, ModelLattice};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StudIntrusion {
    pub at: [f64; 2],
    pub depth: f64,
    pub instance: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RefusedSeat {
    pub phase: [u32; 2],
    pub floor_y: f64,
    pub intrusions: Vec<StudIntrusion>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Seating {
    pub lattice: Result<ModelLattice, LatticeError>,
    pub refused: Vec<RefusedSeat>,
}

impl RefusedSeat {
    pub fn deepest(&self) -> Option<&StudIntrusion> {
        self.intrusions
            .iter()
            .max_by(|a, b| a.depth.total_cmp(&b.depth))
    }

    fn describe(&self) -> String {
        let deepest = self.deepest().map_or(String::new(), |intrusion| {
            format!(
                ", the deepest {:.4} LDU into the stud at ({}, {})",
                intrusion.depth, intrusion.at[0], intrusion.at[1]
            )
        });
        format!(
            "at phase {:?} the model reaches into {} of the field's studs{deepest}",
            self.phase,
            self.intrusions.len()
        )
    }
}

impl Seating {
    pub fn issue(&self) -> Option<String> {
        match &self.lattice {
            Ok(_) => None,
            Err(LatticeError::NoIntegerPhase) if !self.refused.is_empty() => {
                let refused: Vec<String> = self.refused.iter().map(RefusedSeat::describe).collect();
                Some(format!(
                    "no lattice frame seats on a stud field: {}",
                    refused.join("; ")
                ))
            }
            Err(LatticeError::NoIntegerPhase) => None,
            Err(error) => Some(error.to_string()),
        }
    }
}

pub trait SeatProbe {
    fn seats(&self, phase: [u32; 2], floor_y: f64) -> bool;

    fn intrusions(&self, phase: [u32; 2], floor_y: f64) -> Vec<StudIntrusion>;
}

pub fn seat(instances: &[LatticeInstance], probe: &impl SeatProbe) -> Seating {
    let mut refused_frames = Vec::new();
    let lattice = model_lattice(instances, |phase, floor_y| {
        let seats = probe.seats(phase, floor_y);
        if !seats {
            refused_frames.push((phase, floor_y));
        }
        !seats
    });
    let refused = refused_frames
        .into_iter()
        .map(|(phase, floor_y)| RefusedSeat {
            phase,
            floor_y,
            intrusions: probe.intrusions(phase, floor_y),
        })
        .collect();
    Seating { lattice, refused }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::affine::{Affine, Vec3};
    use crate::lattice::AxisPose;

    const DOWN: Vec3 = [0.0, -1.0, 0.0];
    const UP: Vec3 = [0.0, 1.0, 0.0];
    const UNDERSIDE: [AxisPose; 2] = [
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
    const SHALLOW: StudIntrusion = StudIntrusion {
        at: [-10.0, 0.0],
        depth: 0.25,
        instance: 0,
    };
    const DEEP: StudIntrusion = StudIntrusion {
        at: [10.0, 0.0],
        depth: 0.5,
        instance: 0,
    };

    struct RefusingPhase([u32; 2]);

    impl SeatProbe for RefusingPhase {
        fn seats(&self, phase: [u32; 2], _: f64) -> bool {
            phase != self.0
        }

        fn intrusions(&self, phase: [u32; 2], _: f64) -> Vec<StudIntrusion> {
            if phase == self.0 {
                vec![SHALLOW, DEEP]
            } else {
                Vec::new()
            }
        }
    }

    fn one_by_two<'a>(matrix: &'a Affine, studs: &'static [AxisPose]) -> LatticeInstance<'a> {
        LatticeInstance {
            matrix,
            studs,
            receptors: &UNDERSIDE,
            bounds_min: [-20.0, 0.0, -10.0],
            bounds_max: [20.0, 8.0, 10.0],
        }
    }

    #[test]
    fn a_model_left_without_a_lattice_reports_the_frame_it_refused_and_names_its_deepest_stud() {
        let seating = seat(
            &[one_by_two(&Affine::IDENTITY, &[])],
            &RefusingPhase([10, 0]),
        );
        assert_eq!(seating.lattice, Err(LatticeError::NoIntegerPhase));
        assert_eq!(
            seating.refused,
            vec![RefusedSeat {
                phase: [10, 0],
                floor_y: 0.0,
                intrusions: vec![SHALLOW, DEEP],
            }]
        );
        let issue = seating.issue().expect("the refusal is the issue");
        assert!(issue.contains("(10, 0)"), "{issue}");
        assert!(!issue.contains("(-10, 0)"), "{issue}");
    }

    #[test]
    fn a_model_that_seats_on_another_frame_reports_the_one_it_refused_without_an_issue() {
        let seating = seat(
            &[one_by_two(&Affine::IDENTITY, &CENTRE_STUD)],
            &RefusingPhase([0, 0]),
        );
        assert_eq!(
            seating.lattice.as_ref().map(|lattice| lattice.phase).ok(),
            Some([10, 0])
        );
        assert_eq!(
            seating
                .refused
                .iter()
                .map(|refused| refused.phase)
                .collect::<Vec<_>>(),
            vec![[0, 0]]
        );
        assert_eq!(seating.issue(), None);
    }
}
