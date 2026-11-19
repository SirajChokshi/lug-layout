pub const SIXTEENTHS_PER_LDU: i32 = 16;
pub const IDENTIFY_LDU: f64 = 0.0005;
pub const JOIN_REPRESENTATION_EPSILON_LDU: f64 = 1e-6;
pub const IDENTIFY_REPRESENTATION_GUARD_LDU: f64 = 1e-9;

const IDENTIFY_TEN_THOUSANDTHS: i128 = 5;
const TEN_THOUSANDTHS_PER_LDU: i128 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BeyondExactRange;

pub fn identifies(residual: f64) -> bool {
    residual.abs() <= IDENTIFY_LDU + IDENTIFY_REPRESENTATION_GUARD_LDU
}

pub fn sixteenths(value: f64) -> Option<i64> {
    let per_ldu = f64::from(SIXTEENTHS_PER_LDU);
    let steps = (value * per_ldu).round();
    identifies(value - steps / per_ldu).then_some(steps as i64)
}

pub fn sixteenth(value: f64) -> Option<f64> {
    sixteenths(value).map(|steps| steps as f64 / f64::from(SIXTEENTHS_PER_LDU) + 0.0)
}

pub fn identified(value: f64) -> f64 {
    sixteenth(value).unwrap_or(value + 0.0)
}

pub fn decimal_sixteenths(units: i128, scale: u32) -> Result<Option<i64>, BeyondExactRange> {
    let denominator = 10i128.checked_pow(scale).ok_or(BeyondExactRange)?;
    let numerator = units
        .checked_mul(i128::from(SIXTEENTHS_PER_LDU))
        .ok_or(BeyondExactRange)?;
    let floor = numerator.div_euclid(denominator);
    let remainder = numerator.rem_euclid(denominator);
    let doubled = remainder.checked_mul(2).ok_or(BeyondExactRange)?;
    let steps = if doubled >= denominator {
        floor + 1
    } else {
        floor
    };
    let residual = steps
        .checked_mul(denominator)
        .and_then(|nearest| numerator.checked_sub(nearest))
        .map(i128::abs)
        .ok_or(BeyondExactRange)?;
    let scaled_residual = residual
        .checked_mul(TEN_THOUSANDTHS_PER_LDU)
        .ok_or(BeyondExactRange)?;
    let limit = denominator
        .checked_mul(IDENTIFY_TEN_THOUSANDTHS * i128::from(SIXTEENTHS_PER_LDU))
        .ok_or(BeyondExactRange)?;
    let steps = i64::try_from(steps).map_err(|_| BeyondExactRange)?;
    Ok((scaled_residual <= limit).then_some(steps))
}
