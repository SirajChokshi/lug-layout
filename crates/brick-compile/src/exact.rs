use std::cmp::Ordering;

use num_bigint::BigInt;

const MAX_TOKEN_PLACES: u32 = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decimal {
    coefficient: i128,
    places: u32,
}

impl Decimal {
    pub fn parse(text: &str) -> Option<Decimal> {
        let (negative, unsigned) = match text.as_bytes().first()? {
            b'-' => (true, &text[1..]),
            b'+' => (false, &text[1..]),
            _ => (false, text),
        };
        let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
            Some(at) => (&unsigned[..at], unsigned[at + 1..].parse::<i32>().ok()?),
            None => (unsigned, 0),
        };
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        if whole.is_empty() && fraction.is_empty() {
            return None;
        }
        let mut coefficient: i128 = 0;
        for byte in whole.bytes().chain(fraction.bytes()) {
            if !byte.is_ascii_digit() {
                return None;
            }
            coefficient = coefficient
                .checked_mul(10)?
                .checked_add(i128::from(byte - b'0'))?;
        }
        let mut places = i64::try_from(fraction.len()).ok()? - i64::from(exponent);
        while places < 0 {
            coefficient = coefficient.checked_mul(10)?;
            places += 1;
        }
        let places = u32::try_from(places)
            .ok()
            .filter(|p| *p <= MAX_TOKEN_PLACES)?;
        Some(Decimal {
            coefficient: if negative { -coefficient } else { coefficient },
            places,
        })
    }

    pub fn exact(self) -> Exact {
        Exact {
            coefficient: Coefficient::Small(self.coefficient),
            places: self.places,
        }
    }
}

#[derive(Clone, Debug)]
enum Coefficient {
    Small(i128),
    Big(BigInt),
}

fn power_of_ten(exponent: u32) -> BigInt {
    BigInt::from(10u32).pow(exponent)
}

impl Coefficient {
    fn big(&self) -> BigInt {
        match self {
            Coefficient::Small(value) => BigInt::from(*value),
            Coefficient::Big(value) => value.clone(),
        }
    }

    fn from_big(value: BigInt) -> Coefficient {
        i128::try_from(&value).map_or(Coefficient::Big(value), Coefficient::Small)
    }

    fn scaled(&self, exponent: u32) -> Coefficient {
        if exponent == 0 {
            return self.clone();
        }
        if let Coefficient::Small(value) = self {
            if let Some(scaled) = 10i128
                .checked_pow(exponent)
                .and_then(|p| value.checked_mul(p))
            {
                return Coefficient::Small(scaled);
            }
        }
        Coefficient::Big(self.big() * power_of_ten(exponent))
    }

    fn combine(
        &self,
        other: &Coefficient,
        small: fn(i128, i128) -> Option<i128>,
        big: fn(BigInt, BigInt) -> BigInt,
    ) -> Coefficient {
        if let (Coefficient::Small(a), Coefficient::Small(b)) = (self, other) {
            if let Some(value) = small(*a, *b) {
                return Coefficient::Small(value);
            }
        }
        Coefficient::from_big(big(self.big(), other.big()))
    }

    fn sign(&self) -> Ordering {
        match self {
            Coefficient::Small(value) => value.cmp(&0),
            Coefficient::Big(value) => value.sign().cmp(&num_bigint::Sign::NoSign),
        }
    }
}

impl std::fmt::Display for Coefficient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Coefficient::Small(value) => write!(f, "{value}"),
            Coefficient::Big(value) => write!(f, "{value}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Exact {
    coefficient: Coefficient,
    places: u32,
}

impl Exact {
    pub fn zero() -> Exact {
        Exact::integer(0)
    }

    pub fn integer(value: i64) -> Exact {
        Exact {
            coefficient: Coefficient::Small(i128::from(value)),
            places: 0,
        }
    }

    fn aligned(&self, places: u32) -> Coefficient {
        self.coefficient.scaled(places - self.places)
    }

    pub fn add(&self, other: &Exact) -> Exact {
        let places = self.places.max(other.places);
        Exact {
            coefficient: self.aligned(places).combine(
                &other.aligned(places),
                i128::checked_add,
                |a, b| a + b,
            ),
            places,
        }
    }

    pub fn sub(&self, other: &Exact) -> Exact {
        let places = self.places.max(other.places);
        Exact {
            coefficient: self.aligned(places).combine(
                &other.aligned(places),
                i128::checked_sub,
                |a, b| a - b,
            ),
            places,
        }
    }

    pub fn mul(&self, other: &Exact) -> Exact {
        Exact {
            coefficient: self
                .coefficient
                .combine(&other.coefficient, i128::checked_mul, |a, b| a * b),
            places: self.places + other.places,
        }
    }

    pub fn neg(&self) -> Exact {
        Exact {
            coefficient: Coefficient::Small(0).combine(
                &self.coefficient,
                i128::checked_sub,
                |a, b| a - b,
            ),
            places: self.places,
        }
    }

    pub fn sign(&self) -> Ordering {
        self.coefficient.sign()
    }

    pub fn is_zero(&self) -> bool {
        self.sign() == Ordering::Equal
    }

    pub fn compare(&self, other: &Exact) -> Ordering {
        self.sub(other).sign()
    }

    pub fn canonical(&self) -> String {
        let digits = self.coefficient.to_string();
        let (negative, magnitude) = match digits.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, digits.as_str()),
        };
        let places = self.places as usize;
        let padded = format!("{magnitude:0>width$}", width = places + 1);
        let (whole, fraction) = padded.split_at(padded.len() - places);
        let whole = whole.trim_start_matches('0');
        let fraction = fraction.trim_end_matches('0');
        let whole = if whole.is_empty() { "0" } else { whole };
        let body = if fraction.is_empty() {
            whole.to_string()
        } else {
            format!("{whole}.{fraction}")
        };
        if negative && body != "0" {
            format!("-{body}")
        } else {
            body
        }
    }

    pub fn to_f64(&self) -> f64 {
        format!("{}e-{}", self.coefficient, self.places)
            .parse()
            .unwrap_or(f64::NAN)
    }

    pub fn from_f64(value: f64) -> Exact {
        const MANTISSA_BITS: u32 = 52;
        const EXPONENT_MASK: u64 = 0x7ff;
        const EXPONENT_BIAS: i64 = 1075;
        let bits = value.to_bits();
        let biased = i64::try_from((bits >> MANTISSA_BITS) & EXPONENT_MASK).unwrap_or(0);
        let fraction = bits & ((1u64 << MANTISSA_BITS) - 1);
        let (mantissa, exponent) = if biased == 0 {
            (fraction, 1 - EXPONENT_BIAS)
        } else {
            (fraction | (1u64 << MANTISSA_BITS), biased - EXPONENT_BIAS)
        };
        let magnitude = BigInt::from(mantissa);
        let signed = if value.is_sign_negative() {
            -magnitude
        } else {
            magnitude
        };
        match u32::try_from(exponent) {
            Ok(shift) => Exact {
                coefficient: Coefficient::from_big(signed << shift),
                places: 0,
            },
            Err(_) => {
                let places = u32::try_from(-exponent).unwrap_or(u32::MAX);
                Exact {
                    coefficient: Coefficient::from_big(signed * BigInt::from(5u32).pow(places)),
                    places,
                }
            }
        }
    }
}

impl PartialEq for Exact {
    fn eq(&self, other: &Exact) -> bool {
        self.compare(other) == Ordering::Equal
    }
}

pub type ExactVec3 = [Exact; 3];

#[derive(Clone, Debug)]
pub struct ExactAffine {
    m: [Exact; 12],
}

impl ExactAffine {
    pub fn identity() -> ExactAffine {
        let one = |k: usize| Exact::integer(i64::from(k == 0 || k == 5 || k == 10));
        ExactAffine {
            m: std::array::from_fn(one),
        }
    }

    pub fn from_ldraw(numbers: &[Decimal; 12]) -> ExactAffine {
        let [x, y, z, a, b, c, d, e, f, g, h, i] = numbers.map(Decimal::exact);
        ExactAffine {
            m: [a, b, c, x, d, e, f, y, g, h, i, z],
        }
    }

    pub fn then(&self, child: &ExactAffine) -> ExactAffine {
        let p = &self.m;
        let c = &child.m;
        ExactAffine {
            m: std::array::from_fn(|k| {
                let (row, col) = (k / 4, k % 4);
                let mut value = if col == 3 {
                    p[row * 4 + 3].clone()
                } else {
                    Exact::zero()
                };
                for inner in 0..3 {
                    value = value.add(&p[row * 4 + inner].mul(&c[inner * 4 + col]));
                }
                value
            }),
        }
    }

    pub fn apply(&self, point: &[Decimal; 3]) -> ExactVec3 {
        let v = point.map(Decimal::exact);
        std::array::from_fn(|row| {
            let m = &self.m[row * 4..row * 4 + 4];
            m[0].mul(&v[0])
                .add(&m[1].mul(&v[1]))
                .add(&m[2].mul(&v[2]))
                .add(&m[3])
        })
    }

    pub fn column(&self, col: usize) -> ExactVec3 {
        std::array::from_fn(|row| self.m[row * 4 + col].clone())
    }

    pub fn translation(&self) -> ExactVec3 {
        self.column(3)
    }
}

pub type Direction = [Exact; 2];

pub const TURNS: i32 = 48;

const IDENTIFY_LDU: f64 = 0.0005;
const CERTIFIED_CROSS: f64 = 1e-12;

#[derive(Clone, Debug, PartialEq)]
pub enum Bearing {
    Turn(i32),
    Raw(Direction),
}

pub type Arc = (Bearing, Bearing);

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

fn turns_identifiable(radius: f64) -> bool {
    let spacing = 2.0 * radius * crate::trig::sin(std::f64::consts::PI / f64::from(TURNS));
    spacing > std::f64::consts::SQRT_2 * 2.0 * IDENTIFY_LDU
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Identified {
    Turn(i32),
    Raw,
    Unsure,
}

pub fn identify_turn(x: f64, y: f64, uncertainty: f64) -> Identified {
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
        let (sine, cosine) = crate::trig::sincos(turn_angle(turn));
        let off = (x - radius * cosine).abs().max((y - radius * sine).abs());
        if (off - IDENTIFY_LDU).abs() <= uncertainty && uncertainty > 0.0 {
            return Identified::Unsure;
        }
        if off <= IDENTIFY_LDU {
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

fn turn_versus(turn: i32, direction: &Direction) -> Ordering {
    let by_class = Bearing::Turn(turn).class().cmp(&class(direction));
    if by_class != Ordering::Equal {
        return by_class;
    }
    if let Some(exact) = eighth_turn(turn) {
        return angle_order(&exact, direction);
    }
    let (sine, cosine) = crate::trig::sincos(turn_angle(turn));
    let (x, y) = (direction[0].to_f64(), direction[1].to_f64());
    let turned = cosine * y - sine * x;
    let margin = CERTIFIED_CROSS * x.abs().max(y.abs());
    if turned > margin {
        Ordering::Less
    } else if turned < -margin {
        Ordering::Greater
    } else {
        angle_order(&[Exact::from_f64(cosine), Exact::from_f64(sine)], direction)
    }
}

pub fn bearing_order(a: &Bearing, b: &Bearing) -> Ordering {
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

pub fn cross(a: &Direction, b: &Direction) -> Exact {
    a[0].mul(&b[1]).sub(&a[1].mul(&b[0]))
}

pub fn dot(a: &Direction, b: &Direction) -> Exact {
    a[0].mul(&b[0]).add(&a[1].mul(&b[1]))
}

pub fn is_origin(direction: &Direction) -> bool {
    direction[0].is_zero() && direction[1].is_zero()
}

pub fn angle_order(a: &Direction, b: &Direction) -> Ordering {
    class(a).cmp(&class(b)).then_with(|| cross(b, a).sign())
}

pub fn span(bearings: Vec<Bearing>) -> Option<Arc> {
    let mut sorted = bearings;
    sorted.sort_by(bearing_order);
    let angles: Vec<f64> = sorted.iter().map(Bearing::angle).collect();
    let count = angles.len();
    let gap = |k: usize| {
        if k + 1 == count {
            angles[0] + std::f64::consts::TAU - angles[k]
        } else {
            angles[k + 1] - angles[k]
        }
    };
    let widest = (0..count).max_by(|a, b| gap(*a).total_cmp(&gap(*b)))?;
    let low = sorted[(widest + 1) % count].clone();
    let high = sorted.swap_remove(widest);
    Some((low, high))
}

fn wraps(arc: &Arc) -> bool {
    bearing_order(&arc.1, &arc.0) == Ordering::Less
}

pub fn contains(arc: &Arc, bearing: &Bearing) -> bool {
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

pub fn covers_circle(arcs: &[Arc]) -> bool {
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

#[derive(Clone, Debug)]
pub struct Homogeneous {
    pub point: ExactVec3,
    pub weight: Exact,
}

impl Homogeneous {
    pub fn of(point: ExactVec3) -> Homogeneous {
        Homogeneous {
            point,
            weight: Exact::integer(1),
        }
    }

    pub fn relative(&self, axes: (usize, usize), center: &Direction) -> Direction {
        [
            self.point[axes.0].sub(&center[0].mul(&self.weight)),
            self.point[axes.1].sub(&center[1].mul(&self.weight)),
        ]
    }
}

fn clip_against(
    polygon: Vec<Homogeneous>,
    inside: impl Fn(&Homogeneous) -> Exact,
) -> Vec<Homogeneous> {
    let mut out = Vec::with_capacity(polygon.len() + 1);
    for (k, current) in polygon.iter().enumerate() {
        let next = &polygon[(k + 1) % polygon.len()];
        let (here, there) = (inside(current), inside(next));
        let here_in = here.sign() != Ordering::Less;
        let there_in = there.sign() != Ordering::Less;
        if here_in {
            out.push(current.clone());
        }
        if here_in != there_in {
            let point: ExactVec3 = std::array::from_fn(|c| {
                current.point[c].mul(&there).sub(&next.point[c].mul(&here))
            });
            let weight = current.weight.mul(&there).sub(&next.weight.mul(&here));
            let crossing = if weight.sign() == Ordering::Less {
                Homogeneous {
                    point: point.map(|v| v.neg()),
                    weight: weight.neg(),
                }
            } else {
                Homogeneous { point, weight }
            };
            out.push(crossing);
        }
    }
    out
}

pub fn clip_between(
    polygon: Vec<Homogeneous>,
    axis: usize,
    low: &Exact,
    high: &Exact,
) -> Vec<Homogeneous> {
    let above = clip_against(polygon, |p| p.point[axis].sub(&low.mul(&p.weight)));
    if above.is_empty() {
        return above;
    }
    clip_against(above, |p| high.mul(&p.weight).sub(&p.point[axis]))
}

pub fn touches_origin(directions: &[Direction]) -> bool {
    if directions.iter().any(is_origin) {
        return true;
    }
    let turns: Vec<Ordering> = (0..directions.len())
        .map(|k| cross(&directions[k], &directions[(k + 1) % directions.len()]).sign())
        .collect();
    let left = turns.contains(&Ordering::Greater);
    let right = turns.contains(&Ordering::Less);
    if left && right {
        return false;
    }
    if left || right {
        return true;
    }
    directions.iter().enumerate().any(|(k, a)| {
        directions[k + 1..]
            .iter()
            .any(|b| dot(a, b).sign() == Ordering::Less)
    })
}

pub fn ray_crosses(directions: &[Direction], along: usize, forward: Ordering) -> bool {
    let across = 1 - along;
    (0..directions.len()).any(|k| {
        let a = &directions[k];
        let b = &directions[(k + 1) % directions.len()];
        let (sa, sb) = (a[across].sign(), b[across].sign());
        if sa != Ordering::Equal && sa == sb {
            return false;
        }
        if sa == Ordering::Equal && sb == Ordering::Equal {
            let ahead = |d: &Direction| d[along].sign() == forward || d[along].is_zero();
            return ahead(a) || ahead(b);
        }
        let crossing = a[across]
            .mul(&b[along])
            .sub(&a[along].mul(&b[across]))
            .sign();
        let span = a[across].sub(&b[across]).sign();
        let value = match (crossing, span) {
            (Ordering::Equal, _) => Ordering::Equal,
            (c, s) if c == s => Ordering::Greater,
            _ => Ordering::Less,
        };
        value == Ordering::Equal || value == forward
    })
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
            error: (uncertainty / radius + f64::EPSILON) * per_radian * 4.0,
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

pub type ApproximateArc = (Approximate, Approximate);

pub fn approximate_span(ends: Vec<Approximate>) -> Option<ApproximateArc> {
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

fn float_covers(arcs: &[ApproximateArc], optimistic: bool) -> Option<bool> {
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

pub fn approximately_covers(arcs: &[ApproximateArc]) -> Option<bool> {
    if !float_covers(arcs, true)? {
        return Some(false);
    }
    float_covers(arcs, false)?.then_some(true)
}
