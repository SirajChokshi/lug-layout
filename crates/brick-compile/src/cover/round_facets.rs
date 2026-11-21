use rustc_hash::FxHashMap;

use crate::affine::{Affine, Vec3};
use crate::identify::{identifies, IDENTIFY_LDU};
use crate::lattice::STUD_LDU;
use crate::round::{place, plan_axes, PlacedRound, RoundShape, UnitShape};
use crate::trig::planar_length;

const VERTICAL: usize = 1;
const CELL_LDU: f64 = STUD_LDU;
const UNIT_HEIGHT: f64 = 1.0;

type Plan = [f64; 2];

type Cell = (usize, i64, i64);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoundFacets {
    rounds: Vec<PlacedRound>,
    cells: FxHashMap<Cell, Vec<usize>>,
}

impl RoundFacets {
    pub fn new(rounds: &[PlacedRound]) -> Self {
        let mut cells: FxHashMap<Cell, Vec<usize>> = FxHashMap::default();
        for (index, round) in rounds.iter().enumerate() {
            let reach = plan_reach(round);
            let [low, high] =
                [-reach, reach].map(|offset| round.center.map(|c| cell_of(c + offset)));
            for u in low[0]..=high[0] {
                for v in low[1]..=high[1] {
                    cells.entry((round.axis, u, v)).or_default().push(index);
                }
            }
        }
        RoundFacets {
            rounds: rounds.to_vec(),
            cells,
        }
    }

    pub fn same_bits(&self, other: &RoundFacets) -> bool {
        self.rounds
            .iter()
            .map(PlacedRound::bits)
            .eq(other.rounds.iter().map(PlacedRound::bits))
    }

    fn owner(&self, facet: &[Vec3; 3]) -> Option<&PlacedRound> {
        (0..3)
            .filter_map(|axis| {
                let (i, j) = plan_axes(axis);
                let key = (axis, cell_of(facet[0][i]), cell_of(facet[0][j]));
                self.cells
                    .get(&key)?
                    .iter()
                    .copied()
                    .find(|&index| lies_on(&self.rounds[index], facet))
            })
            .min()
            .map(|index| &self.rounds[index])
    }

    pub fn reading(
        &self,
        facet: &[Vec3; 3],
        to_world: &Affine,
        world: &[Vec3; 3],
        axis: Plan,
    ) -> Option<f64> {
        let upright = upright_in(self.owner(facet)?, to_world)?;
        let corners = world.map(|p| [p[0], p[2]]);
        match upright.shape {
            RoundShape::Wall { radius, .. } => {
                let [p, q] = farthest_pair(&corners);
                Some(arc_distance(world_center(&upright), radius, [p, q], axis))
            }
            RoundShape::Annulus { .. } => sector_distance(world_center(&upright), &corners, axis),
        }
    }
}

fn cell_of(value: f64) -> i64 {
    (value / CELL_LDU).floor() as i64
}

fn plan_reach(round: &PlacedRound) -> f64 {
    let radius = match round.shape {
        RoundShape::Wall { radius, .. } => radius,
        RoundShape::Annulus { outer, .. } => outer,
    };
    radius * (1.0 + 2.0 * IDENTIFY_LDU) + IDENTIFY_LDU
}

fn radius_of(round: &PlacedRound, p: &Vec3) -> f64 {
    let (i, j) = plan_axes(round.axis);
    planar_length(p[i] - round.center[0], p[j] - round.center[1])
}

fn on_circle(rho: f64, radius: f64) -> bool {
    radius > 0.0 && identifies(rho / radius - 1.0)
}

fn lies_on(round: &PlacedRound, facet: &[Vec3; 3]) -> bool {
    let along = |p: &Vec3| p[round.axis];
    match round.shape {
        RoundShape::Wall { radius, from, to } => {
            let on_band = |p: &Vec3| identifies((along(p) - along(p).clamp(from, to)).abs());
            let (i, j) = plan_axes(round.axis);
            let plan = facet.map(|p| [p[i], p[j]]);
            facet
                .iter()
                .all(|p| on_circle(radius_of(round, p), radius) && on_band(p))
                && distinct_points(&plan) == 2
        }
        RoundShape::Annulus { inner, outer, at } => facet.iter().all(|p| {
            let rho = radius_of(round, p);
            identifies(along(p) - at)
                && (on_circle(rho, inner) || on_circle(rho, outer) || identifies(rho))
        }),
    }
}

fn distinct_points(plan: &[Plan; 3]) -> usize {
    let same = |a: Plan, b: Plan| identifies(planar_length(a[0] - b[0], a[1] - b[1]));
    let [a, b, c] = *plan;
    match (same(a, b), same(b, c), same(a, c)) {
        (true, true, _) | (true, _, true) | (_, true, true) => 1,
        (false, false, false) => 3,
        _ => 2,
    }
}

fn upright_in(round: &PlacedRound, to_world: &Affine) -> Option<PlacedRound> {
    let (i, j) = plan_axes(round.axis);
    let unit = |k: usize, length: f64| {
        let mut v = [0.0; 3];
        v[k] = length;
        v
    };
    let point_at = |along: f64| {
        let mut p = unit(round.axis, along);
        p[i] = round.center[0];
        p[j] = round.center[1];
        p
    };
    let (shape, scale, base, height) = match round.shape {
        RoundShape::Wall { radius, from, to } => (UnitShape::Wall, radius, from, to - from),
        RoundShape::Annulus { inner, outer, at } => (
            UnitShape::Annulus {
                inner: inner / outer,
                outer: UNIT_HEIGHT,
            },
            outer,
            at,
            UNIT_HEIGHT,
        ),
    };
    let [x, y, z] = [unit(i, scale), unit(round.axis, height), unit(j, scale)];
    let base = point_at(base);
    let local = Affine::from_ldraw(base, [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]);
    place(shape, &to_world.then(&local))
        .ok()
        .filter(|world| world.axis == VERTICAL)
}

fn world_center(round: &PlacedRound) -> Plan {
    let [z, x] = round.center;
    [x, z]
}

fn sub(a: Plan, b: Plan) -> Plan {
    [a[0] - b[0], a[1] - b[1]]
}

fn cross(a: Plan, b: Plan) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn dot(a: Plan, b: Plan) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn length(a: Plan) -> f64 {
    planar_length(a[0], a[1])
}

fn farthest_pair(corners: &[Plan; 3]) -> [Plan; 2] {
    let [a, b, c] = *corners;
    [[a, b], [b, c], [a, c]]
        .into_iter()
        .max_by(|x, y| length(sub(x[0], x[1])).total_cmp(&length(sub(y[0], y[1]))))
        .unwrap_or([a, b])
}

fn within_minor_cone(from: Plan, to: Plan, direction: Plan) -> bool {
    let turning = cross(from, to);
    turning != 0.0
        && cross(from, direction) * turning >= 0.0
        && cross(direction, to) * turning >= 0.0
}

fn arc_distance(center: Plan, radius: f64, [p, q]: [Plan; 2], axis: Plan) -> f64 {
    let toward = sub(axis, center);
    if within_minor_cone(sub(p, center), sub(q, center), toward) {
        (radius - length(toward)).abs()
    } else {
        length(sub(axis, p)).min(length(sub(axis, q)))
    }
}

fn segment_distance(a: Plan, b: Plan, point: Plan) -> f64 {
    let along = sub(b, a);
    let span = dot(along, along);
    let t = if span == 0.0 {
        0.0
    } else {
        (dot(sub(point, a), along) / span).clamp(0.0, 1.0)
    };
    length(sub(point, [a[0] + along[0] * t, a[1] + along[1] * t]))
}

fn sector_distance(center: Plan, corners: &[Plan; 3], axis: Plan) -> Option<f64> {
    let radii = corners.map(|corner| length(sub(corner, center)));
    let (low, high) = (
        radii.iter().copied().fold(f64::INFINITY, f64::min),
        radii.iter().copied().fold(0.0, f64::max),
    );
    let [first, last] = bounding_spokes(center, corners, high)?;
    let toward = sub(axis, center);
    if within_minor_cone(first, last, toward) {
        let rho = length(toward);
        return Some((low - rho).max(rho - high).max(0.0));
    }
    let edge = |direction: Plan| {
        let at = |r: f64| [center[0] + direction[0] * r, center[1] + direction[1] * r];
        segment_distance(at(low), at(high), axis)
    };
    Some(edge(first).min(edge(last)))
}

fn bounding_spokes(center: Plan, corners: &[Plan; 3], rim: f64) -> Option<[Plan; 2]> {
    let mut directions: Vec<Plan> = Vec::new();
    for &corner in corners {
        let spoke = sub(corner, center);
        if identifies(length(spoke)) {
            continue;
        }
        let direction = spoke.map(|v| v / length(spoke));
        if directions
            .iter()
            .all(|&seen| !identifies(length(sub(seen, direction)) * rim))
        {
            directions.push(direction);
        }
    }
    match directions.as_slice() {
        [a, b] => Some([*a, *b]),
        [a, b, c] => [[*a, *b, *c], [*b, *c, *a], [*a, *c, *b]]
            .into_iter()
            .find(|[from, to, between]| within_minor_cone(*from, *to, *between))
            .map(|[from, to, _]| [from, to]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trig::sincos;

    const SEGMENTS: f64 = 16.0;
    const RADIUS: f64 = 20.0;
    const HEIGHT: f64 = 24.0;
    const CENTER: Plan = [-10.0, -10.0];
    const STUD: Plan = [0.0, 0.0];

    fn rim(radius: f64, step: f64, y: f64) -> Vec3 {
        let (sin, cos) = sincos(std::f64::consts::TAU * step / SEGMENTS);
        [CENTER[0] + radius * cos, y, CENTER[1] + radius * sin]
    }

    fn wall() -> PlacedRound {
        PlacedRound {
            axis: VERTICAL,
            center: [CENTER[1], CENTER[0]],
            shape: RoundShape::Wall {
                radius: RADIUS,
                from: 0.0,
                to: HEIGHT,
            },
        }
    }

    fn wall_facet(radius: f64, step: f64) -> [Vec3; 3] {
        [
            rim(radius, step, 0.0),
            rim(radius, step + 1.0, 0.0),
            rim(radius, step + 1.0, HEIGHT),
        ]
    }

    fn read(round: PlacedRound, facet: [Vec3; 3], to_world: &Affine) -> Option<f64> {
        let world = facet.map(|p| to_world.apply(p));
        RoundFacets::new(&[round]).reading(&facet, to_world, &world, STUD)
    }

    fn inside_by() -> f64 {
        RADIUS - length(sub(STUD, CENTER))
    }

    #[test]
    fn a_facet_of_a_round_wall_reads_at_the_ideal_circle_its_chord_approximates() {
        let facet = wall_facet(RADIUS, 1.0);
        let world = facet.map(|p| [p[0], p[2]]);
        assert!(segment_distance(world[0], world[1], STUD) < inside_by());
        assert_eq!(read(wall(), facet, &Affine::IDENTITY), Some(inside_by()));
    }

    #[test]
    fn a_ring_facet_reads_at_the_ideal_sector_its_triangle_approximates() {
        let ring = PlacedRound {
            axis: VERTICAL,
            center: [CENTER[1], CENTER[0]],
            shape: RoundShape::Annulus {
                inner: RADIUS,
                outer: RADIUS + 1.0,
                at: 1.0,
            },
        };
        let facet = [
            rim(RADIUS, 1.0, 1.0),
            rim(RADIUS, 2.0, 1.0),
            rim(RADIUS + 1.0, 2.0, 1.0),
        ];
        assert_eq!(read(ring, facet, &Affine::IDENTITY), Some(inside_by()));
    }

    #[test]
    fn only_upright_facets_whose_corners_lie_on_the_round_are_read_as_it() {
        let cap = [
            rim(RADIUS, 0.0, HEIGHT),
            rim(RADIUS, 1.0, HEIGHT),
            rim(RADIUS, 2.0, HEIGHT),
        ];
        let beside = wall_facet(RADIUS + 0.5, 1.0);
        let above = [
            rim(RADIUS, 1.0, HEIGHT),
            rim(RADIUS, 2.0, HEIGHT),
            rim(RADIUS, 2.0, 2.0 * HEIGHT),
        ];
        for facet in [cap, beside, above] {
            assert_eq!(read(wall(), facet, &Affine::IDENTITY), None);
        }
    }

    #[test]
    fn a_round_its_instance_turns_off_the_vertical_is_read_as_drawn() {
        let on_its_side = Affine {
            m: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        };
        assert_eq!(read(wall(), wall_facet(RADIUS, 1.0), &on_its_side), None);
    }
}
