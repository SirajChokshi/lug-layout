use std::collections::{HashMap, HashSet};
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, SQRT_2};

use crate::affine::Vec3;

use super::inferred::by_key;
use super::profile::{collides, Placed, Point, Profile};
use super::solid::{plan_axes, Probe, Solid, HALF_GRID_LDU, IDENTIFY_LDU};

const TRAVEL_PRECISION_LDU: f64 = IDENTIFY_LDU / 64.0;

const STEPS: [Point; 8] = [
    [HALF_GRID_LDU, 0.0],
    [-HALF_GRID_LDU, 0.0],
    [0.0, HALF_GRID_LDU],
    [0.0, -HALF_GRID_LDU],
    [HALF_GRID_LDU, HALF_GRID_LDU],
    [HALF_GRID_LDU, -HALF_GRID_LDU],
    [-HALF_GRID_LDU, HALF_GRID_LDU],
    [-HALF_GRID_LDU, -HALF_GRID_LDU],
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AxleFound {
    Hole {
        probe: Probe,
        angle: f64,
        depth: Option<f64>,
    },
    Axle {
        probe: Probe,
        angle: f64,
        length: Option<f64>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AxleMiss {
    OffCentre { offset: f64 },
    Sliding,
}

pub struct AxleProbe {
    profile: Profile,
    sides: Vec<[f64; 2]>,
}

type BlindColumn = (usize, i8, i64, i64, i64);

fn point_on(axis: usize, center: [f64; 2], along: f64) -> Vec3 {
    let (i, j) = plan_axes(axis);
    let mut p = [0.0; 3];
    p[axis] = along;
    p[i] = center[0];
    p[j] = center[1];
    p
}

fn bisect(contact: impl Fn(f64) -> bool, first: f64, last: f64, scale: f64) -> f64 {
    let (mut free, mut blocked) = if contact(first) {
        (0.0, first)
    } else if contact(last) {
        (first, last)
    } else {
        return f64::INFINITY;
    };
    while (blocked - free) * scale > TRAVEL_PRECISION_LDU {
        let middle = 0.5 * (free + blocked);
        if contact(middle) {
            blocked = middle;
        } else {
            free = middle;
        }
    }
    free
}

fn within(section: &[Vec<Point>], low: Point, high: Point) -> Vec<&Vec<Point>> {
    section
        .iter()
        .filter(|polygon| {
            (0..2).all(|k| {
                polygon.iter().any(|p| p[k] >= low[k]) && polygon.iter().any(|p| p[k] <= high[k])
            })
        })
        .collect()
}

fn segment_distance(from: Point, along: Point) -> f64 {
    let squared = along[0] * along[0] + along[1] * along[1];
    let t = (-(from[0] * along[0] + from[1] * along[1]) / squared).clamp(0.0, 1.0);
    (from[0] + t * along[0]).hypot(from[1] + t * along[1])
}

fn offset(forward: f64, back: f64) -> f64 {
    (forward - back).abs() / 2.0
}

fn depth_key(probe: &Probe, depth: f64) -> i64 {
    ((probe.entrance[probe.axis] + probe.inward * depth) / IDENTIFY_LDU).round() as i64
}

impl AxleProbe {
    pub fn new(profile: Profile) -> Result<Self, String> {
        if !profile.symmetric_under(FRAC_PI_2, IDENTIFY_LDU) {
            return Err("axle profile is not symmetric under a quarter turn".to_string());
        }
        if !profile.has_pockets() {
            return Err("axle profile has no pockets between its arms".to_string());
        }
        let sides = profile.sides(FRAC_PI_2, IDENTIFY_LDU / profile.radius());
        Ok(AxleProbe { profile, sides })
    }

    pub fn radius(&self) -> f64 {
        self.profile.radius()
    }

    pub fn find(&self, solid: &Solid) -> (Vec<AxleFound>, Vec<(Vec3, AxleMiss)>) {
        let (low, high) = solid.bounds();
        let mut holes: HashMap<BlindColumn, (f64, AxleFound)> = HashMap::new();
        let mut found = Vec::new();
        let mut missed = Vec::new();
        let mut seen: HashSet<(usize, i8, [i64; 3])> = HashSet::new();
        for plane in solid.planes() {
            let inward = -plane.outward;
            let far = if inward > 0.0 {
                high[plane.axis] - plane.at
            } else {
                plane.at - low[plane.axis]
            };
            for center in solid.grid(&plane, self.reach()) {
                let entrance = point_on(plane.axis, center, plane.at);
                let cell = entrance.map(|c| (c / IDENTIFY_LDU).round() as i64);
                if !seen.insert((plane.axis, inward as i8, cell)) {
                    continue;
                }
                let probe = Probe {
                    axis: plane.axis,
                    inward,
                    entrance,
                    radius: self.radius(),
                };
                let inner = self.profile.inner();
                let disc = Probe {
                    radius: inner,
                    ..probe
                };
                let floor = solid.floor_beyond(&disc, inner - IDENTIFY_LDU, IDENTIFY_LDU);
                let clear = floor.map(|floor| floor.depth.min(far));
                let outcome = match clear {
                    Some(clear) if clear > 2.0 * IDENTIFY_LDU => {
                        self.hole(solid, &probe, clear, far)
                    }
                    Some(clear) if clear > IDENTIFY_LDU => None,
                    _ => self.tip(solid, &probe, far),
                };
                match outcome {
                    Some(Ok(
                        feature @ AxleFound::Hole {
                            depth: Some(depth), ..
                        },
                    )) => {
                        let (i, j) = plan_axes(probe.axis);
                        let column = (
                            probe.axis,
                            inward as i8,
                            cell[i],
                            cell[j],
                            depth_key(&probe, depth),
                        );
                        if holes.get(&column).is_none_or(|(kept, _)| depth > *kept) {
                            holes.insert(column, (depth, feature));
                        }
                    }
                    Some(Ok(feature)) => found.push(feature),
                    Some(Err(miss)) => missed.push((entrance, miss)),
                    None => {}
                }
            }
        }
        let mut blind: Vec<(f64, AxleFound)> = by_key(holes);
        blind.sort_by(|a, b| {
            let at = |f: &AxleFound| match f {
                AxleFound::Hole { probe, .. } | AxleFound::Axle { probe, .. } => probe.entrance,
            };
            at(&a.1)
                .partial_cmp(&at(&b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        found.extend(blind.into_iter().map(|(_, feature)| feature));
        (found, missed)
    }

    fn reach(&self) -> f64 {
        self.radius() + HALF_GRID_LDU * SQRT_2 + IDENTIFY_LDU
    }

    fn angles(&self, section: &[Vec<Point>], reach: f64) -> Vec<f64> {
        let within = IDENTIFY_LDU / self.radius();
        let mut out: Vec<f64> = Vec::new();
        for polygon in section {
            for k in 0..polygon.len() {
                let (p, q) = (polygon[k], polygon[(k + 1) % polygon.len()]);
                let d = [q[0] - p[0], q[1] - p[1]];
                let span = d[0].hypot(d[1]);
                if span <= IDENTIFY_LDU || segment_distance(p, d) > reach {
                    continue;
                }
                let distance = (p[0] * d[1] - p[1] * d[0]).abs() / span;
                let mut direction = None;
                for [side, along] in &self.sides {
                    if (distance - side).abs() > IDENTIFY_LDU {
                        continue;
                    }
                    let direction = *direction.get_or_insert_with(|| d[1].atan2(d[0]));
                    let mut angle = (direction - along).rem_euclid(FRAC_PI_2);
                    if FRAC_PI_2 - angle <= within {
                        angle = 0.0;
                    }
                    if out.iter().all(|a| (a - angle).abs() > within) {
                        out.push(angle);
                    }
                }
            }
        }
        out.sort_by(f64::total_cmp);
        out
    }

    fn located(&self, placed: &Placed, angle: f64, section: &[Vec<Point>]) -> Result<(), AxleMiss> {
        let mut travel = [0.0; 8];
        let reach = self.radius() + IDENTIFY_LDU;
        for (k, step) in STEPS.iter().enumerate() {
            let span = step[0].hypot(step[1]);
            let path = within(
                section,
                [step[0].min(0.0) - reach, step[1].min(0.0) - reach],
                [step[0].max(0.0) + reach, step[1].max(0.0) + reach],
            );
            let contact = |s: f64| {
                let swept = placed.swept([step[0] * s, step[1] * s]);
                path.iter().any(|p| swept.contact(p))
            };
            travel[k] = bisect(contact, IDENTIFY_LDU / span, 1.0, span) * span;
            if travel[k].is_infinite() {
                return Err(AxleMiss::Sliding);
            }
        }
        let radius = self.radius();
        let swing = within(section, [-reach, -reach], [reach, reach]);
        let turning = |sign: f64| {
            let contact = |phi: f64| {
                let turned = self.profile.placed([0.0, 0.0], angle + sign * phi);
                swing.iter().any(|p| turned.contact(p))
            };
            bisect(contact, IDENTIFY_LDU / radius, FRAC_PI_4, radius) * radius
        };
        let worst = [
            offset(travel[0], travel[1]),
            offset(travel[2], travel[3]),
            offset(travel[4], travel[7]),
            offset(travel[5], travel[6]),
            offset(turning(1.0), turning(-1.0)),
        ]
        .into_iter()
        .fold(0.0, f64::max);
        if worst > IDENTIFY_LDU {
            return Err(AxleMiss::OffCentre { offset: worst });
        }
        Ok(())
    }

    fn keyed(&self, angle: f64, section: &[Vec<Point>]) -> bool {
        let turned = self
            .profile
            .placed([0.0, 0.0], angle + FRAC_PI_4)
            .eroded(IDENTIFY_LDU);
        section.iter().any(|p| collides(&turned, p))
    }

    fn hole(
        &self,
        solid: &Solid,
        probe: &Probe,
        clear: f64,
        far: f64,
    ) -> Option<Result<AxleFound, AxleMiss>> {
        let near = (IDENTIFY_LDU, clear - IDENTIFY_LDU);
        if !solid.comes_within(probe, near, self.radius(), self.radius() - IDENTIFY_LDU) {
            return None;
        }
        let reach = self.radius() + IDENTIFY_LDU;
        let glance = solid.cross_section(probe, near, reach);
        for angle in self.angles(&glance, reach) {
            let placed = self.profile.placed([0.0, 0.0], angle);
            let floor = solid.profile_floor(probe, &placed.eroded(IDENTIFY_LDU), self.radius());
            if floor.depth <= 2.0 * IDENTIFY_LDU || floor.faces_probe == Some(false) {
                continue;
            }
            let end = floor.depth.min(far);
            let section =
                solid.cross_section(probe, (IDENTIFY_LDU, end - IDENTIFY_LDU), self.reach());
            let toothed = placed.eroded_pockets(IDENTIFY_LDU).iter().all(|pocket| {
                section
                    .iter()
                    .any(|p| collides(std::slice::from_ref(pocket), p))
            });
            if !toothed || !self.keyed(angle, &section) {
                continue;
            }
            return Some(
                self.located(&placed, angle, &section)
                    .map(|()| AxleFound::Hole {
                        probe: *probe,
                        angle,
                        depth: floor.depth.is_finite().then_some(floor.depth),
                    }),
            );
        }
        None
    }

    fn tip(&self, solid: &Solid, probe: &Probe, far: f64) -> Option<Result<AxleFound, AxleMiss>> {
        let reach = self.radius() + IDENTIFY_LDU;
        if solid.section_reaches(probe, (-IDENTIFY_LDU, IDENTIFY_LDU), reach, reach) {
            return None;
        }
        let glance = solid.cross_section(
            probe,
            (IDENTIFY_LDU, far.min(self.radius()) - IDENTIFY_LDU),
            reach,
        );
        for angle in self.angles(&glance, reach) {
            let placed = self.profile.placed([0.0, 0.0], angle);
            let floor =
                solid.profile_floor(probe, &placed.eroded_pockets(IDENTIFY_LDU), self.radius());
            let root = floor.depth;
            if root <= 2.0 * IDENTIFY_LDU || floor.faces_probe == Some(false) {
                continue;
            }
            let end = root.min(far);
            let section = solid.cross_section(
                probe,
                (IDENTIFY_LDU, end - IDENTIFY_LDU),
                self.radius() + IDENTIFY_LDU,
            );
            if !placed.outline_covered(&section, IDENTIFY_LDU) || !self.keyed(angle, &section) {
                continue;
            }
            return Some(
                self.located(&placed, angle, &section)
                    .map(|()| AxleFound::Axle {
                        probe: *probe,
                        angle,
                        length: root.is_finite().then_some(root),
                    }),
            );
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;

    use super::super::inferred::axle_section;
    use super::*;
    use crate::flatten::{Library, Triangle};

    #[derive(Default)]
    struct Pinned(RefCell<HashMap<String, Option<&'static str>>>);

    impl Library for Pinned {
        fn source(&self, path: &str) -> Option<&str> {
            *self
                .0
                .borrow_mut()
                .entry(path.to_string())
                .or_insert_with(|| {
                    fs::read_to_string(
                        Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("../../.cache/ldraw")
                            .join(path),
                    )
                    .ok()
                    .map(|text| &*Box::leak(text.into_boxed_str()))
                })
        }
    }

    const AXLE_SECTION: &str = "p/axleend.dat";

    fn axle_probe() -> AxleProbe {
        let library = Pinned::default();
        AxleProbe::new(axle_section(&library, AXLE_SECTION).expect(
            "pinned inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`",
        ))
        .expect("the pinned axle section is an axle probe")
    }

    fn triangle(points: [Vec3; 3]) -> Triangle {
        Triangle {
            color: 16,
            points,
            double_sided: true,
        }
    }

    fn upright(a: Point, b: Point, depth: f64) -> [Triangle; 2] {
        let at = |p: Point, y: f64| [p[0], y, p[1]];
        [
            triangle([at(a, 0.0), at(b, 0.0), at(b, depth)]),
            triangle([at(a, 0.0), at(b, depth), at(a, depth)]),
        ]
    }

    fn level(low: Point, high: Point, y: f64) -> [Triangle; 2] {
        let at = |x: f64, z: f64| [x, y, z];
        [
            triangle([
                at(low[0], low[1]),
                at(high[0], low[1]),
                at(high[0], high[1]),
            ]),
            triangle([
                at(low[0], low[1]),
                at(high[0], high[1]),
                at(low[0], high[1]),
            ]),
        ]
    }

    const SOCKET_DEPTH: f64 = 29.0;

    fn toothed_socket_with_slots() -> Vec<Triangle> {
        let mut walls = Vec::new();
        for (sx, sz) in [(1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
            let tip = [3.464 * sx, 4.0 * sz];
            walls.extend(upright(tip, [6.0 * sx, 4.0 * sz], SOCKET_DEPTH));
            walls.extend(upright(tip, [6.0 * sx, 6.536 * sz], SOCKET_DEPTH));
        }
        for x in [-2.0, 2.0] {
            for sz in [-1.0, 1.0] {
                walls.extend(upright([x, 8.657 * sz], [x, 13.582 * sz], SOCKET_DEPTH));
            }
        }
        for (low, high) in [
            ([-20.0, -20.0], [-7.0, 20.0]),
            ([7.0, -20.0], [20.0, 20.0]),
            ([-7.0, -20.0], [7.0, -15.0]),
            ([-7.0, 15.0], [7.0, 20.0]),
        ] {
            walls.extend(level(low, high, 0.0));
        }
        walls.extend(level([-7.0, -7.0], [7.0, 7.0], SOCKET_DEPTH));
        walls
    }

    const CELL_SIZES: [f64; 5] = [2.5, 5.0, HALF_GRID_LDU, 20.0, 40.0];

    #[test]
    fn a_socket_whose_walls_miss_the_axle_sides_takes_no_axle_whatever_the_index_cell_size() {
        let probe = axle_probe();
        let socket = toothed_socket_with_slots();
        let found: Vec<Vec<AxleFound>> = CELL_SIZES
            .iter()
            .map(|&size| {
                probe
                    .find(&Solid::with_cell_size(&socket, Vec::new(), size))
                    .0
            })
            .collect();
        for (size, at) in CELL_SIZES.iter().zip(&found) {
            assert_eq!(at, &found[0], "cell size {size}");
        }
        assert!(!found[0].iter().any(|feature| matches!(
            feature,
            AxleFound::Hole { probe, .. } if probe.entrance[0] == 0.0 && probe.entrance[2] == 0.0
        )));
    }

    #[test]
    fn an_edge_whose_segment_stays_outside_the_axle_gives_no_side_angle() {
        let probe = axle_probe();
        let reach = probe.radius() + IDENTIFY_LDU;
        let corner = probe.radius() + 0.2;
        let on_the_arm_side_line = |from: f64, to: f64| vec![[from, 2.0], [to, 2.0], [to, 2.5]];
        assert!(probe
            .angles(&[on_the_arm_side_line(corner, corner + 0.1)], reach)
            .is_empty());
        assert_eq!(
            probe.angles(&[on_the_arm_side_line(3.0, 4.0)], reach),
            vec![0.0]
        );
    }
}
