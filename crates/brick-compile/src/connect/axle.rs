use std::collections::{HashMap, HashSet};
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, SQRT_2};

use crate::affine::Vec3;
use crate::identify::identifies;
use crate::trig::{atan2, planar_length};

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
    planar_length(from[0] + t * along[0], from[1] + t * along[1])
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
            for center in solid.grid(&plane, self.sweep_reach()) {
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
                let floor = solid.floor_beyond(&disc, inner, IDENTIFY_LDU);
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

    fn sweep_reach(&self) -> f64 {
        self.radius() + HALF_GRID_LDU * SQRT_2 + IDENTIFY_LDU
    }

    fn contact_reach(&self) -> f64 {
        self.radius() + IDENTIFY_LDU
    }

    fn angles(&self, section: &[Vec<Point>], reach: f64) -> Vec<f64> {
        let within = IDENTIFY_LDU / self.radius();
        let mut out: Vec<f64> = Vec::new();
        for polygon in section {
            for k in 0..polygon.len() {
                let (p, q) = (polygon[k], polygon[(k + 1) % polygon.len()]);
                let d = [q[0] - p[0], q[1] - p[1]];
                let span = planar_length(d[0], d[1]);
                if span <= IDENTIFY_LDU || segment_distance(p, d) > reach {
                    continue;
                }
                let distance = (p[0] * d[1] - p[1] * d[0]).abs() / span;
                let mut direction = None;
                for [side, along] in &self.sides {
                    if !identifies(distance - side) {
                        continue;
                    }
                    let direction = *direction.get_or_insert_with(|| atan2(d[1], d[0]));
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
        let reach = self.contact_reach();
        for (k, step) in STEPS.iter().enumerate() {
            let span = planar_length(step[0], step[1]);
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
        if !identifies(worst) {
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
        let reach = self.contact_reach();
        let glance = solid.cross_section(probe, near, reach);
        for angle in self.angles(&glance, reach) {
            let placed = self.profile.placed([0.0, 0.0], angle);
            let floor = solid.profile_floor(probe, &placed.eroded(IDENTIFY_LDU), self.radius());
            if floor.depth <= 2.0 * IDENTIFY_LDU || floor.faces_probe == Some(false) {
                continue;
            }
            let end = floor.depth.min(far);
            let section = solid.cross_section(
                probe,
                (IDENTIFY_LDU, end - IDENTIFY_LDU),
                self.sweep_reach(),
            );
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
        let reach = self.contact_reach();
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
            let section = solid.cross_section(probe, (IDENTIFY_LDU, end - IDENTIFY_LDU), reach);
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
    use std::fs;
    use std::path::Path;

    use super::super::inferred::axle_section;
    use super::*;
    use crate::flatten::{Library, Triangle};

    const AXLE_SECTION: &str = "p/axleend.dat";

    struct AxleEnd(String);

    impl Library for AxleEnd {
        fn source(&self, path: &str) -> Option<&str> {
            (path == AXLE_SECTION).then_some(self.0.as_str())
        }
    }

    fn axle_probe() -> AxleProbe {
        let text = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.cache/ldraw")
                .join(AXLE_SECTION),
        )
        .expect(
            "pinned inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`",
        );
        AxleProbe::new(
            axle_section(&AxleEnd(text), AXLE_SECTION).expect("the pinned axle end is flat"),
        )
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

    fn toothed_socket(arm_side_walls: (f64, f64)) -> Vec<Triangle> {
        let mut walls = Vec::new();
        for (sx, sz) in [(1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
            let tip = [3.464 * sx, 4.0 * sz];
            walls.extend(upright(tip, [6.0 * sx, 4.0 * sz], SOCKET_DEPTH));
            walls.extend(upright(tip, [6.0 * sx, 6.536 * sz], SOCKET_DEPTH));
        }
        let (from, to) = arm_side_walls;
        for x in [-2.0, 2.0] {
            for sz in [-1.0, 1.0] {
                walls.extend(upright([x, from * sz], [x, to * sz], SOCKET_DEPTH));
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
        let slotted = toothed_socket((8.657, 13.582));
        for size in CELL_SIZES {
            let (found, _) = probe.find(&Solid::with_cell_size(&slotted, Vec::new(), size));
            assert!(found.is_empty(), "cell size {size}: {found:?}");
        }
    }

    #[test]
    fn only_walls_that_reach_the_axle_sides_make_a_socket_an_axle_hole() {
        let probe = axle_probe();
        let corner = probe.radius() + 0.1;
        let stubs = toothed_socket((corner - 0.3, corner));
        let (found, _) = probe.find(&Solid::unpieced(&stubs, Vec::new()));
        assert!(found.is_empty(), "{found:?}");
        let hugging = toothed_socket((2.5, 5.5));
        let (found, _) = probe.find(&Solid::unpieced(&hugging, Vec::new()));
        assert!(
            matches!(
                found.as_slice(),
                [AxleFound::Hole { probe, angle, depth: Some(depth) }]
                    if probe.entrance == [0.0, 0.0, 0.0] && *angle == 0.0 && *depth == SOCKET_DEPTH
            ),
            "{found:?}"
        );
    }
}
