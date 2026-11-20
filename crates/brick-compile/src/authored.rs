use crate::identify::{decimal_sixteenths, sixteenths, SIXTEENTHS_PER_LDU};
use crate::ldraw::PrintedDecimal;

pub const AUTHORED_RULE_VERSION: u32 = 1;

const WHOLE_RESIDUAL_PER_LDU: i128 = 20;
const FINE_GRID_MIN_PRINTED_DECIMALS: u32 = 2;
const PRINT_BOUND_HALF_DIGIT: i128 = 5;
const PRINT_BOUND_FLOOR_SCALE: u32 = 4;
const FINE_GRIDS: [AuthoredGrid; 4] = [
    AuthoredGrid::Half,
    AuthoredGrid::Quarter,
    AuthoredGrid::Eighth,
    AuthoredGrid::Sixteenth,
];
const LARGEST_EXACT_FLOAT_SHIFT: i32 = 100;
const FLOAT_MANTISSA_BITS: u32 = 52;
const FLOAT_EXPONENT_MASK: u64 = 0x7ff;
const FLOAT_EXPONENT_BIAS: i32 = 1075;
const SUBNORMAL_EXPONENT: i32 = -1074;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthoredGrid {
    Whole,
    Half,
    Quarter,
    Eighth,
    Sixteenth,
}

impl AuthoredGrid {
    pub fn per_ldu(self) -> i128 {
        match self {
            AuthoredGrid::Whole => 1,
            AuthoredGrid::Half => 2,
            AuthoredGrid::Quarter => 4,
            AuthoredGrid::Eighth => 8,
            AuthoredGrid::Sixteenth => i128::from(SIXTEENTHS_PER_LDU),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AuthoredGrid::Whole => "whole",
            AuthoredGrid::Half => "half",
            AuthoredGrid::Quarter => "quarter",
            AuthoredGrid::Eighth => "eighth",
            AuthoredGrid::Sixteenth => "sixteenth",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rational {
    pub numerator: i128,
    pub denominator: i128,
}

impl Rational {
    fn reduced(numerator: i128, denominator: i128) -> Rational {
        let divisor = gcd(numerator.unsigned_abs(), denominator.unsigned_abs()).max(1);
        let sign = if denominator < 0 { -1 } else { 1 };
        let divisor = divisor as i128;
        Rational {
            numerator: sign * numerator / divisor,
            denominator: sign * denominator / divisor,
        }
    }

    pub fn to_f64(self) -> f64 {
        self.numerator as f64 / self.denominator as f64 + 0.0
    }
}

fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authored {
    SixteenthStep(Rational),
    Identified {
        grid: AuthoredGrid,
        value: Rational,
        residual: Rational,
    },
    Unidentified,
}

impl Authored {
    pub fn value(self) -> Option<Rational> {
        match self {
            Authored::SixteenthStep(value) | Authored::Identified { value, .. } => Some(value),
            Authored::Unidentified => None,
        }
    }
}

pub fn identify_authored(printed: Option<PrintedDecimal>, value: f64) -> Authored {
    match printed {
        Some(decimal) => authored_decimal(decimal).unwrap_or(Authored::Unidentified),
        None => authored_float(value).unwrap_or(Authored::Unidentified),
    }
}

fn authored_decimal(decimal: PrintedDecimal) -> Option<Authored> {
    if let Some(steps) = decimal_sixteenths(decimal.units, decimal.scale).ok()? {
        return Some(Authored::SixteenthStep(Rational::reduced(
            i128::from(steps),
            AuthoredGrid::Sixteenth.per_ldu(),
        )));
    }
    let printed = Rational {
        numerator: decimal.units,
        denominator: 10i128.checked_pow(decimal.scale)?,
    };
    if let Some(whole) = within_whole(printed)? {
        return Some(whole);
    }
    if decimal.scale < FINE_GRID_MIN_PRINTED_DECIMALS {
        return Some(Authored::Unidentified);
    }
    let bound = print_bound(decimal.scale)?;
    for grid in FINE_GRIDS {
        let below_half_spacing = 2i128
            .checked_mul(grid.per_ldu())?
            .checked_mul(bound.numerator)?
            < bound.denominator;
        if !below_half_spacing {
            continue;
        }
        let (steps, offset) = nearest(printed, grid)?;
        let within = offset.checked_mul(bound.denominator)?
            <= bound
                .numerator
                .checked_mul(grid.per_ldu())?
                .checked_mul(printed.denominator)?;
        if within {
            return identified(printed, grid, steps);
        }
    }
    Some(Authored::Unidentified)
}

fn authored_float(value: f64) -> Option<Authored> {
    if let Some(steps) = sixteenths(value) {
        return Some(Authored::SixteenthStep(Rational::reduced(
            i128::from(steps),
            AuthoredGrid::Sixteenth.per_ldu(),
        )));
    }
    Some(within_whole(exact_float(value)?)?.unwrap_or(Authored::Unidentified))
}

fn within_whole(printed: Rational) -> Option<Option<Authored>> {
    let (steps, offset) = nearest(printed, AuthoredGrid::Whole)?;
    if offset.checked_mul(WHOLE_RESIDUAL_PER_LDU)? <= printed.denominator {
        Some(Some(identified(printed, AuthoredGrid::Whole, steps)?))
    } else {
        Some(None)
    }
}

fn print_bound(scale: u32) -> Option<Rational> {
    let digits = (scale + 1).min(PRINT_BOUND_FLOOR_SCALE);
    Some(Rational {
        numerator: PRINT_BOUND_HALF_DIGIT,
        denominator: 10i128.checked_pow(digits)?,
    })
}

fn nearest(printed: Rational, grid: AuthoredGrid) -> Option<(i128, i128)> {
    let scaled = printed.numerator.checked_mul(grid.per_ldu())?;
    let doubled = scaled.checked_mul(2)?.checked_add(printed.denominator)?;
    let steps = doubled.div_euclid(printed.denominator.checked_mul(2)?);
    let offset = scaled
        .checked_sub(steps.checked_mul(printed.denominator)?)?
        .checked_abs()?;
    Some((steps, offset))
}

fn identified(printed: Rational, grid: AuthoredGrid, steps: i128) -> Option<Authored> {
    let per_ldu = grid.per_ldu();
    let residual = steps
        .checked_mul(printed.denominator)?
        .checked_sub(printed.numerator.checked_mul(per_ldu)?)?;
    Some(Authored::Identified {
        grid,
        value: Rational::reduced(steps, per_ldu),
        residual: Rational::reduced(residual, per_ldu.checked_mul(printed.denominator)?),
    })
}

fn exact_float(value: f64) -> Option<Rational> {
    if !value.is_finite() {
        return None;
    }
    let bits = value.to_bits();
    let biased = ((bits >> FLOAT_MANTISSA_BITS) & FLOAT_EXPONENT_MASK) as i32;
    let fraction = i128::from(bits & ((1u64 << FLOAT_MANTISSA_BITS) - 1));
    let (mantissa, exponent) = if biased == 0 {
        (fraction, SUBNORMAL_EXPONENT)
    } else {
        (
            fraction | (1i128 << FLOAT_MANTISSA_BITS),
            biased - FLOAT_EXPONENT_BIAS,
        )
    };
    let signed = if value.is_sign_negative() {
        -mantissa
    } else {
        mantissa
    };
    if exponent.abs() > LARGEST_EXACT_FLOAT_SHIFT {
        return (signed == 0).then_some(Rational {
            numerator: 0,
            denominator: 1,
        });
    }
    Some(if exponent >= 0 {
        Rational::reduced(signed.checked_mul(1i128 << exponent)?, 1)
    } else {
        Rational::reduced(signed, 1i128 << -exponent)
    })
}

pub fn is_signed_permutation(rotation: [f64; 9]) -> bool {
    let mut columns = [false; 3];
    for row in rotation.as_chunks::<3>().0 {
        let mut found = None;
        for (column, &entry) in row.iter().enumerate() {
            if entry == 0.0 {
                continue;
            }
            if entry.abs() != 1.0 || found.is_some() {
                return false;
            }
            found = Some(column);
        }
        let Some(column) = found else {
            return false;
        };
        if columns[column] {
            return false;
        }
        columns[column] = true;
    }
    true
}
