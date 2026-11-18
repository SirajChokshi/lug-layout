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

    fn angles(&self, section: &[Vec<Point>]) -> Vec<f64> {
        let within = IDENTIFY_LDU / self.radius();
        let mut out: Vec<f64> = Vec::new();
        for polygon in section {
            for k in 0..polygon.len() {
                let (p, q) = (polygon[k], polygon[(k + 1) % polygon.len()]);
                let d = [q[0] - p[0], q[1] - p[1]];
                let span = d[0].hypot(d[1]);
                if span <= IDENTIFY_LDU {
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
        let glance = solid.cross_section(probe, near, self.radius() + IDENTIFY_LDU);
        for angle in self.angles(&glance) {
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
            self.radius() + IDENTIFY_LDU,
        );
        for angle in self.angles(&glance) {
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
