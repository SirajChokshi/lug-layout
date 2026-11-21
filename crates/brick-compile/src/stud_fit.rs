use std::collections::HashSet;

use crate::affine::Vec3;
use crate::connect::{FaceSection, Mate, ShapeError, SnapShape, CAP_ROOT, ROUND};
use crate::cover::StudShape;
use crate::identify::sixteenths;
use crate::lattice::{downward, AxisPose, LatticeInstance, LatticeReceptor};

const SEATED_OFFSET_SIXTEENTHS: i32 = 0;
const ROOTED_ON_THE_FLOOR: u8 = CAP_ROOT;
const FIXED: bool = false;
const UNGROUPED: Option<&str> = None;

#[derive(Clone, Debug, PartialEq)]
pub struct StudFit {
    stud: SnapShape,
}

impl StudFit {
    pub fn measured(stud: &StudShape) -> Result<StudFit, ShapeError> {
        let section = FaceSection {
            code: ROUND,
            size: stud.radius,
            length: stud.height,
        };
        let stud = SnapShape::new(ROOTED_ON_THE_FLOOR, FIXED, UNGROUPED, &[section])?;
        Ok(StudFit { stud })
    }

    pub fn admits(&self, receptor: &SnapShape) -> bool {
        Mate::new(&self.stud, receptor)
            .offsets()
            .contains(SEATED_OFFSET_SIXTEENTHS)
    }

    pub fn seated(&self, receptors: &[LatticeReceptor]) -> Vec<AxisPose> {
        receptors
            .iter()
            .filter(|receptor| self.admits(&receptor.shape))
            .map(|receptor| receptor.pose)
            .collect()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReceptorSeats {
    seats: HashSet<(usize, [i64; 3])>,
}

impl ReceptorSeats {
    pub fn of(instances: &[LatticeInstance]) -> ReceptorSeats {
        let seats = instances
            .iter()
            .enumerate()
            .flat_map(|(index, instance)| {
                instance
                    .receptors
                    .iter()
                    .filter(|receptor| downward(instance.matrix.rotate(receptor.axis)))
                    .filter_map(move |receptor| {
                        let at = instance.matrix.apply(receptor.origin);
                        let [x, y, z] = at.map(sixteenths);
                        Some((index, [x?, y?, z?]))
                    })
            })
            .collect();
        ReceptorSeats { seats }
    }

    pub fn seats(&self, instance: usize, stud_root: Vec3) -> bool {
        match stud_root.map(sixteenths) {
            [Some(x), Some(y), Some(z)] => self.seats.contains(&(instance, [x, y, z])),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect::CAP_FAR;

    fn measured(radius: f64, height: f64) -> StudFit {
        StudFit::measured(&StudShape {
            height,
            radius,
            inscribed_radius: radius,
        })
        .expect("a measured stud reads")
    }

    fn blind_cavity(radius: f64, depth: f64) -> SnapShape {
        let section = FaceSection {
            code: ROUND,
            size: radius,
            length: depth,
        };
        SnapShape::new(CAP_FAR, false, None, &[section]).expect("a cavity reads")
    }

    #[test]
    fn the_measured_stud_seats_in_a_cavity_of_its_radius_at_least_as_deep_as_it_is_tall() {
        assert!(measured(6.0, 4.0).admits(&blind_cavity(6.0, 4.0)));
        assert!(measured(6.0, 4.0).admits(&blind_cavity(6.0, 20.0)));
        assert!(!measured(6.0, 5.0).admits(&blind_cavity(6.0, 4.0)));
        assert!(!measured(4.0, 4.0).admits(&blind_cavity(6.0, 4.0)));
        assert!(!measured(8.0, 4.0).admits(&blind_cavity(6.0, 4.0)));
    }
}
