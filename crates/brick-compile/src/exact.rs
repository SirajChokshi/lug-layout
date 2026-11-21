use std::cmp::Ordering;

use num_bigint::BigInt;

const MAX_DIGITS: usize = 1100;
const MAX_EXPONENT_DIGITS: usize = 4;
const MAX_EXPONENT_MAGNITUDE: i64 = 1100;
const MAX_LITERAL_LENGTH: usize = MAX_DIGITS + 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decimal {
    coefficient: Coefficient,
    places: u32,
}

fn all_digits(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit())
}

impl Decimal {
    pub fn parse(text: &str) -> Option<Decimal> {
        Decimal::parse_plain(text).or_else(|| Decimal::parse_general(text))
    }

    fn parse_plain(text: &str) -> Option<Decimal> {
        const PLAIN_DIGITS: usize = 36;
        let bytes = text.as_bytes();
        let (negative, unsigned) = match bytes.first()? {
            b'-' => (true, &bytes[1..]),
            b'+' => (false, &bytes[1..]),
            _ => (false, bytes),
        };
        let mut value: i128 = 0;
        let mut places: u32 = 0;
        let mut digits = 0;
        let mut pointed = false;
        for &byte in unsigned {
            match byte {
                b'0'..=b'9' if digits < PLAIN_DIGITS => {
                    value = value * 10 + i128::from(byte - b'0');
                    digits += 1;
                    places += u32::from(pointed);
                }
                b'.' if !pointed => pointed = true,
                _ => return None,
            }
        }
        if digits == 0 {
            return None;
        }
        while places > 0 && value % 10 == 0 && value != 0 {
            value /= 10;
            places -= 1;
        }
        if value == 0 {
            places = 0;
        }
        Some(Decimal {
            coefficient: Coefficient::Small(if negative { -value } else { value }),
            places,
        })
    }

    fn parse_general(text: &str) -> Option<Decimal> {
        if text.len() > MAX_LITERAL_LENGTH {
            return None;
        }
        let (negative, unsigned) = match text.as_bytes().first()? {
            b'-' => (true, &text[1..]),
            b'+' => (false, &text[1..]),
            _ => (false, text),
        };
        let (mantissa, power) = match unsigned.find(['e', 'E']) {
            Some(at) => {
                let exponent = &unsigned[at + 1..];
                let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
                if digits.is_empty() || digits.len() > MAX_EXPONENT_DIGITS || !all_digits(digits) {
                    return None;
                }
                (&unsigned[..at], exponent.parse::<i64>().ok()?)
            }
            None => (unsigned, 0),
        };
        if power.abs() > MAX_EXPONENT_MAGNITUDE {
            return None;
        }
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let shaped = if whole.is_empty() {
            !fraction.is_empty()
        } else {
            true
        };
        if !shaped || !all_digits(whole) || !all_digits(fraction) {
            return None;
        }
        let digits = format!("{whole}{fraction}");
        if digits.len() > MAX_DIGITS {
            return None;
        }
        let places = i64::try_from(fraction.len()).ok()? - power;
        let significant = digits.trim_start_matches('0').len();
        if places < 0 && significant as i64 - places > MAX_DIGITS as i64 {
            return None;
        }
        let magnitude = BigInt::parse_bytes(
            if digits.is_empty() {
                b"0"
            } else {
                digits.as_bytes()
            },
            10,
        )?;
        let signed = if negative { -magnitude } else { magnitude };
        let (coefficient, places) = if places < 0 {
            (
                Coefficient::from_big(signed).scaled(u32::try_from(-places).ok()?),
                0,
            )
        } else {
            (Coefficient::from_big(signed), u32::try_from(places).ok()?)
        };
        let (coefficient, places) = coefficient.without_trailing_zeros(places);
        let within = (places as usize) < MAX_DIGITS
            && coefficient.to_string().trim_start_matches('-').len() <= MAX_DIGITS;
        within.then_some(Decimal {
            coefficient,
            places,
        })
    }

    pub fn exact(&self) -> Exact {
        Exact {
            coefficient: self.coefficient.clone(),
            places: self.places,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
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

    fn without_trailing_zeros(self, places: u32) -> (Coefficient, u32) {
        let ten = BigInt::from(10u32);
        let mut value = self.big();
        let mut places = places;
        while places > 0 && &value % &ten == BigInt::from(0u32) && value != BigInt::from(0u32) {
            value /= &ten;
            places -= 1;
        }
        if value == BigInt::from(0u32) {
            places = 0;
        }
        (Coefficient::from_big(value), places)
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
            places: self
                .places
                .checked_add(other.places)
                .expect("decimal places stay within u32"),
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

    pub fn small_decimal(&self) -> Option<(i128, u32)> {
        match self.coefficient {
            Coefficient::Small(units) => Some((units, self.places)),
            Coefficient::Big(_) => None,
        }
    }

    pub fn to_f64(&self) -> f64 {
        const EXACT_INTEGER_LIMIT: u128 = 1 << 53;
        const EXACT_POWERS_OF_TEN: [f64; 23] = [
            1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15,
            1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
        ];
        if let Coefficient::Small(value) = self.coefficient {
            if let Some(power) = EXACT_POWERS_OF_TEN.get(self.places as usize) {
                if value.unsigned_abs() < EXACT_INTEGER_LIMIT {
                    return value as f64 / power;
                }
            }
        }
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
        if mantissa == 0 {
            return Exact::zero();
        }
        let twos = mantissa.trailing_zeros();
        let (mantissa, exponent) = (mantissa >> twos, exponent + i64::from(twos));
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
        let [x, y, z, a, b, c, d, e, f, g, h, i]: [Exact; 12] =
            std::array::from_fn(|k| numbers[k].exact());
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
        let v: [Exact; 3] = std::array::from_fn(|k| point[k].exact());
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
