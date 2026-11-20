use std::cmp::Ordering;

use crate::exact::Exact;
use crate::identify::{identifies, IDENTIFY_LDU, IDENTIFY_REPRESENTATION_GUARD_LDU};

pub type Direction = [Exact; 2];

pub(crate) const TURNS: i32 = 48;
pub(crate) const ATAN2_SLACK: f64 = 64.0 * f64::EPSILON;

#[derive(Clone, Debug, PartialEq)]
pub enum Bearing {
    Turn(i32),
    Raw(Direction),
}

pub type ArcSpan = (Bearing, Bearing);

fn signed_turn(turn: i32) -> i32 {
    let reduced = turn.rem_euclid(TURNS);
    if reduced > TURNS / 2 {
        reduced - TURNS
    } else {
        reduced
    }
}

fn turn_angle(turn: i32) -> f64 {
    f64::from(signed_turn(turn)) * std::f64::consts::TAU / f64::from(TURNS)
}

fn turn_sincos(turn: i32) -> (f64, f64) {
    static TABLE: std::sync::OnceLock<Vec<(f64, f64)>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        (0..TURNS)
            .map(|turn| crate::trig::sincos(turn_angle(turn)))
            .collect()
    })[turn.rem_euclid(TURNS) as usize]
}

fn half_step_sine() -> f64 {
    static SINE: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *SINE.get_or_init(|| crate::trig::sin(std::f64::consts::PI / f64::from(TURNS)))
}

fn turns_identifiable(radius: f64) -> bool {
    let spacing = 2.0 * radius * half_step_sine();
    spacing > std::f64::consts::SQRT_2 * 2.0 * IDENTIFY_LDU
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Identified {
    Turn(i32),
    Raw,
    Unsure,
}

fn identify_turn(x: f64, y: f64, uncertainty: f64) -> Identified {
    let radius = crate::trig::planar_length(x, y);
    if !turns_identifiable(radius + uncertainty) {
        return Identified::Raw;
    }
    if !turns_identifiable(radius - uncertainty) {
        return Identified::Unsure;
    }
    let step = std::f64::consts::TAU / f64::from(TURNS);
    let nearest = (crate::trig::atan2(y, x) / step).round() as i32;
    let mut found = Vec::new();
    for turn in nearest - 1..=nearest + 1 {
        let (sine, cosine) = turn_sincos(turn);
        let off = (x - radius * cosine).abs().max((y - radius * sine).abs());
        let boundary = IDENTIFY_LDU + IDENTIFY_REPRESENTATION_GUARD_LDU;
        if (off - boundary).abs() <= uncertainty && uncertainty > 0.0 {
            return Identified::Unsure;
        }
        if identifies(off) {
            found.push(turn);
        }
    }
    match found[..] {
        [turn] => Identified::Turn(turn.rem_euclid(TURNS)),
        _ => Identified::Raw,
    }
}

impl Bearing {
    pub fn identify(direction: Direction, scale: f64) -> Bearing {
        let x = direction[0].to_f64() / scale;
        let y = direction[1].to_f64() / scale;
        match identify_turn(x, y, 0.0) {
            Identified::Turn(turn) => Bearing::Turn(turn),
            Identified::Raw | Identified::Unsure => Bearing::Raw(direction),
        }
    }

    pub fn approximate(&self, uncertainty: f64) -> Approximate {
        match self {
            Bearing::Turn(turn) => Approximate::Turn(*turn),
            Bearing::Raw(d) => Approximate::raw(d[0].to_f64(), d[1].to_f64(), uncertainty),
        }
    }

    pub fn angle(&self) -> f64 {
        match self {
            Bearing::Turn(turn) => turn_angle(*turn),
            Bearing::Raw(d) => crate::trig::atan2(d[1].to_f64(), d[0].to_f64()),
        }
    }

    fn class(&self) -> u8 {
        match self {
            Bearing::Raw(direction) => class(direction),
            Bearing::Turn(turn) => match signed_turn(*turn) {
                t if t < 0 => 0,
                0 => 1,
                t if t < TURNS / 2 => 2,
                _ => 3,
            },
        }
    }
}

fn eighth_turn(turn: i32) -> Option<Direction> {
    let eighth = TURNS / 8;
    let t = signed_turn(turn);
    (t % eighth == 0).then(|| {
        let (x, y) = match t / eighth {
            0 => (1, 0),
            1 => (1, 1),
            2 => (0, 1),
            3 => (-1, 1),
            4 => (-1, 0),
            -1 => (1, -1),
            -2 => (0, -1),
            _ => (-1, -1),
        };
        [Exact::integer(x), Exact::integer(y)]
    })
}

fn turn_direction(turn: i32) -> Direction {
    eighth_turn(turn).unwrap_or_else(|| {
        let (sine, cosine) = turn_sincos(turn);
        [Exact::from_f64(cosine), Exact::from_f64(sine)]
    })
}

fn direction_of(bearing: &Bearing) -> Direction {
    match bearing {
        Bearing::Turn(turn) => turn_direction(*turn),
        Bearing::Raw(direction) => direction.clone(),
    }
}

fn turn_versus(turn: i32, direction: &Direction) -> Ordering {
    angle_order(&turn_direction(turn), direction)
}

fn bearing_order(a: &Bearing, b: &Bearing) -> Ordering {
    match (a, b) {
        (Bearing::Turn(x), Bearing::Turn(y)) => signed_turn(*x).cmp(&signed_turn(*y)),
        (Bearing::Raw(x), Bearing::Raw(y)) => angle_order(x, y),
        (Bearing::Turn(turn), Bearing::Raw(direction)) => turn_versus(*turn, direction),
        (Bearing::Raw(direction), Bearing::Turn(turn)) => turn_versus(*turn, direction).reverse(),
    }
}

fn class(direction: &Direction) -> u8 {
    match (direction[1].sign(), direction[0].sign()) {
        (Ordering::Less, _) => 0,
        (Ordering::Equal, Ordering::Greater) => 1,
        (Ordering::Greater, _) => 2,
        (Ordering::Equal, _) => 3,
    }
}

pub(crate) fn cross(a: &Direction, b: &Direction) -> Exact {
    a[0].mul(&b[1]).sub(&a[1].mul(&b[0]))
}

pub(crate) fn dot(a: &Direction, b: &Direction) -> Exact {
    a[0].mul(&b[0]).add(&a[1].mul(&b[1]))
}

pub(crate) fn is_origin(direction: &Direction) -> bool {
    direction[0].is_zero() && direction[1].is_zero()
}

fn angle_order(a: &Direction, b: &Direction) -> Ordering {
    class(a).cmp(&class(b)).then_with(|| cross(b, a).sign())
}

fn gap_class(turned: &Direction) -> u8 {
    match (turned[1].sign(), turned[0].sign()) {
        (Ordering::Equal, Ordering::Greater) => 0,
        (Ordering::Greater, _) => 1,
        (Ordering::Equal, _) => 2,
        (Ordering::Less, _) => 3,
    }
}

fn gap_order(a: &Direction, b: &Direction) -> Ordering {
    gap_class(a)
        .cmp(&gap_class(b))
        .then_with(|| cross(b, a).sign())
}

pub fn span(bearings: Vec<Bearing>) -> Option<ArcSpan> {
    let mut sorted = bearings;
    sorted.sort_by(bearing_order);
    let count = sorted.len();
    let directions: Vec<Direction> = sorted.iter().map(direction_of).collect();
    let gap = |k: usize| {
        let (a, b) = (&directions[k], &directions[(k + 1) % count]);
        [dot(a, b), cross(a, b)]
    };
    let gaps: Vec<Direction> = (0..count).map(gap).collect();
    let widest = (0..count).fold(None, |best: Option<usize>, k| match best {
        Some(b) if gap_order(&gaps[k], &gaps[b]) != Ordering::Greater => Some(b),
        _ => Some(k),
    })?;
    let low = sorted[(widest + 1) % count].clone();
    let high = sorted.swap_remove(widest);
    Some((low, high))
}

pub(crate) fn wraps(arc: &ArcSpan) -> bool {
    bearing_order(&arc.1, &arc.0) == Ordering::Less
}

pub fn contains(arc: &ArcSpan, bearing: &Bearing) -> bool {
    let after_low = bearing_order(&arc.0, bearing) != Ordering::Greater;
    let before_high = bearing_order(bearing, &arc.1) != Ordering::Greater;
    if wraps(arc) {
        after_low || before_high
    } else {
        after_low && before_high
    }
}

#[derive(Clone)]
enum Position {
    Start,
    At(Bearing),
    End,
}

fn rank(position: &Position) -> u8 {
    match position {
        Position::Start => 0,
        Position::At(bearing) if bearing.class() == 3 => 2,
        Position::At(_) => 1,
        Position::End => 2,
    }
}

fn position_order(a: &Position, b: &Position) -> Ordering {
    match (a, b) {
        (Position::At(x), Position::At(y)) if rank(a) == 1 && rank(b) == 1 => bearing_order(x, y),
        _ => rank(a).cmp(&rank(b)),
    }
}

pub fn covers_circle(arcs: &[ArcSpan]) -> bool {
    let mut pieces: Vec<(Position, Position)> = Vec::with_capacity(arcs.len() + 1);
    for arc in arcs {
        if wraps(arc) {
            pieces.push((Position::At(arc.0.clone()), Position::End));
            pieces.push((Position::Start, Position::At(arc.1.clone())));
        } else {
            pieces.push((Position::At(arc.0.clone()), Position::At(arc.1.clone())));
        }
    }
    pieces.sort_by(|a, b| position_order(&a.0, &b.0));
    let mut reached = Position::Start;
    for (low, high) in pieces {
        if position_order(&low, &reached) == Ordering::Greater {
            return false;
        }
        if position_order(&high, &reached) == Ordering::Greater {
            reached = high;
        }
    }
    position_order(&reached, &Position::End) == Ordering::Equal
}

#[derive(Clone, Copy, Debug)]
pub enum Approximate {
    Turn(i32),
    Raw { turns: f64, error: f64 },
}

impl Approximate {
    pub fn raw(x: f64, y: f64, uncertainty: f64) -> Approximate {
        let per_radian = f64::from(TURNS) / std::f64::consts::TAU;
        let radius = crate::trig::planar_length(x, y);
        Approximate::Raw {
            turns: crate::trig::atan2(y, x) * per_radian,
            error: (4.0 * uncertainty / radius + ATAN2_SLACK) * per_radian,
        }
    }

    pub fn of(x: f64, y: f64, uncertainty: f64) -> Option<Approximate> {
        match identify_turn(x, y, uncertainty) {
            Identified::Turn(turn) => Some(Approximate::Turn(turn)),
            Identified::Raw => Some(Approximate::raw(x, y, uncertainty)),
            Identified::Unsure => None,
        }
    }

    fn nominal(&self) -> f64 {
        match self {
            Approximate::Turn(turn) => f64::from(signed_turn(*turn)),
            Approximate::Raw { turns, .. } => *turns,
        }
    }

    fn error(&self) -> f64 {
        match self {
            Approximate::Turn(_) => 0.0,
            Approximate::Raw { error, .. } => *error,
        }
    }
}

pub type ApproximateSpan = (Approximate, Approximate);

pub fn approximate_span(ends: Vec<Approximate>) -> Option<ApproximateSpan> {
    let mut sorted = ends;
    sorted.sort_by(|a, b| a.nominal().total_cmp(&b.nominal()));
    let count = sorted.len();
    let whole = f64::from(TURNS);
    let gap = |k: usize| {
        if k + 1 == count {
            sorted[0].nominal() + whole - sorted[k].nominal()
        } else {
            sorted[k + 1].nominal() - sorted[k].nominal()
        }
    };
    let widest = (0..count).max_by(|a, b| gap(*a).total_cmp(&gap(*b)))?;
    let slack: f64 = sorted.iter().map(Approximate::error).sum();
    if gap(widest) <= whole / 2.0 + slack {
        return None;
    }
    Some((sorted[(widest + 1) % count], sorted[widest]))
}

fn float_covers(arcs: &[ApproximateSpan], optimistic: bool) -> Option<bool> {
    let half = f64::from(TURNS / 2);
    let mut pieces: Vec<(f64, f64)> = Vec::with_capacity(arcs.len() + 1);
    for (low, high) in arcs {
        let spread = low.error() + high.error();
        if spread > 0.0 && (high.nominal() - low.nominal()).abs() <= spread {
            return None;
        }
        let widen = if optimistic { 1.0 } else { -1.0 };
        let from = low.nominal() - widen * low.error();
        let to = high.nominal() + widen * high.error();
        if high.nominal() < low.nominal() {
            pieces.push((from, half));
            pieces.push((-half, to));
        } else {
            pieces.push((from, to));
        }
    }
    pieces.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut reached = -half;
    for (from, to) in pieces {
        if from > reached {
            return Some(false);
        }
        reached = reached.max(to);
    }
    Some(reached >= half)
}

#[derive(Clone, Copy)]
pub(crate) struct Junction<K> {
    pub approximate: Approximate,
    pub key: K,
}

#[derive(Clone, Copy)]
enum Placed {
    Start,
    At(usize),
    End,
}

struct Filtered<K> {
    junctions: Vec<Junction<K>>,
    resolved: Vec<Option<Bearing>>,
}

impl<K: Copy> Filtered<K> {
    fn seam_uncertain(&self, index: usize) -> bool {
        let a = self.junctions[index].approximate;
        a.error() > 0.0 && a.nominal().abs() + a.error() >= f64::from(TURNS / 2)
    }

    fn certain(&self, a: usize, b: usize) -> bool {
        let (x, y) = (self.junctions[a].approximate, self.junctions[b].approximate);
        !self.seam_uncertain(a)
            && !self.seam_uncertain(b)
            && (x.nominal() - y.nominal()).abs() > x.error() + y.error()
    }

    fn bearing(&self, index: usize) -> Bearing {
        match self.junctions[index].approximate {
            Approximate::Turn(turn) => Bearing::Turn(turn),
            Approximate::Raw { .. } => self.resolved[index]
                .clone()
                .expect("every raw end a comparison can reach is resolved before sorting"),
        }
    }

    fn bearing_order(&self, a: usize, b: usize) -> Ordering {
        let (x, y) = (self.junctions[a].approximate, self.junctions[b].approximate);
        if self.certain(a, b) {
            return (x.nominal() - y.nominal()).total_cmp(&0.0);
        }
        bearing_order(&self.bearing(a), &self.bearing(b))
    }

    fn rank(&self, placed: Placed) -> u8 {
        match placed {
            Placed::Start => 0,
            Placed::End => 2,
            Placed::At(index) => match self.junctions[index].approximate {
                Approximate::Turn(turn) if signed_turn(turn) >= TURNS / 2 => 2,
                Approximate::Turn(_) => 1,
                Approximate::Raw { .. } if !self.seam_uncertain(index) => 1,
                Approximate::Raw { .. } => match self.bearing(index).class() {
                    3 => 2,
                    _ => 1,
                },
            },
        }
    }

    fn order(&self, a: (Placed, u8), b: (Placed, u8)) -> Ordering {
        match (a, b) {
            ((Placed::At(x), 1), (Placed::At(y), 1)) => self.bearing_order(x, y),
            _ => a.1.cmp(&b.1),
        }
    }
}

fn uncertain_raw_ends<K>(junctions: &[Junction<K>]) -> Vec<bool> {
    let half = f64::from(TURNS / 2);
    let raw = |j: &Junction<K>| matches!(j.approximate, Approximate::Raw { .. });
    let near_seam = |j: &Junction<K>| j.approximate.nominal().abs() + j.approximate.error() >= half;
    if junctions.iter().any(|j| raw(j) && near_seam(j)) {
        return junctions.iter().map(raw).collect();
    }
    let mut needed = vec![false; junctions.len()];
    let mut order: Vec<usize> = (0..junctions.len()).collect();
    let low = |k: usize| junctions[k].approximate.nominal() - junctions[k].approximate.error();
    let high = |k: usize| junctions[k].approximate.nominal() + junctions[k].approximate.error();
    order.sort_by(|&a, &b| low(a).total_cmp(&low(b)));
    let mut start = 0;
    while start < order.len() {
        let mut end = start + 1;
        let mut reach = high(order[start]);
        while end < order.len() && low(order[end]) <= reach {
            reach = reach.max(high(order[end]));
            end += 1;
        }
        let cluster = &order[start..end];
        if cluster.len() > 1 {
            for &k in cluster {
                needed[k] |= raw(&junctions[k]);
            }
        }
        start = end;
    }
    needed
}

pub(crate) fn certainly_uncovered<K>(arcs: &[(Junction<K>, Junction<K>)]) -> bool {
    let spans: Vec<ApproximateSpan> = arcs
        .iter()
        .map(|(low, high)| (low.approximate, high.approximate))
        .collect();
    float_covers(&spans, true) == Some(false)
}

pub(crate) fn covers_circle_filtered<K: Copy>(
    arcs: &[(Junction<K>, Junction<K>)],
    exact: &mut impl FnMut(K) -> Option<Bearing>,
) -> Option<bool> {
    let junctions: Vec<Junction<K>> = arcs.iter().flat_map(|(low, high)| [*low, *high]).collect();
    let needed = uncertain_raw_ends(&junctions);
    let mut resolved: Vec<Option<Bearing>> = vec![None; junctions.len()];
    for (index, junction) in junctions.iter().enumerate() {
        if needed[index] {
            resolved[index] = Some(exact(junction.key)?);
        }
    }
    let filtered = Filtered {
        junctions,
        resolved,
    };
    let mut pieces: Vec<((Placed, u8), (Placed, u8))> = Vec::with_capacity(arcs.len() + 1);
    for k in 0..arcs.len() {
        let (low, high) = (Placed::At(2 * k), Placed::At(2 * k + 1));
        let ranked = |placed| (placed, filtered.rank(placed));
        if filtered.bearing_order(2 * k + 1, 2 * k) == Ordering::Less {
            pieces.push((ranked(low), (Placed::End, 2)));
            pieces.push(((Placed::Start, 0), ranked(high)));
        } else {
            pieces.push((ranked(low), ranked(high)));
        }
    }
    pieces.sort_by(|p, q| filtered.order(p.0, q.0));
    let mut reached = (Placed::Start, 0);
    for (low, high) in pieces {
        if filtered.order(low, reached) == Ordering::Greater {
            return Some(false);
        }
        if filtered.order(high, reached) == Ordering::Greater {
            reached = high;
        }
    }
    Some(reached.1 == 2)
}

pub(crate) fn inner_turns((low, high): &ApproximateSpan) -> Option<Vec<(f64, f64)>> {
    let half = f64::from(TURNS / 2);
    let spread = low.error() + high.error();
    if spread > 0.0 && (high.nominal() - low.nominal()).abs() <= spread {
        return None;
    }
    let from = low.nominal() + low.error();
    let to = high.nominal() - high.error();
    Some(if high.nominal() < low.nominal() {
        vec![(from, half), (-half, to)]
    } else {
        vec![(from, to)]
    })
}

pub(crate) fn inner_complete(inner: &[(f64, f64)]) -> bool {
    let half = f64::from(TURNS / 2);
    matches!(inner, [(low, high)] if *low <= -half && *high >= half)
}
