use std::cmp::Ordering;

const LIMB_BITS: u32 = 32;
const DECIMAL_CHUNK: u32 = 1_000_000_000;
const DECIMAL_CHUNK_DIGITS: usize = 9;
const TEN: u32 = 10;
const TWO: u32 = 2;
const FIVE: u32 = 5;
const MAX_EXPONENT: i64 = 400;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Magnitude(Vec<u32>);

impl Magnitude {
    fn from_u32(value: u32) -> Magnitude {
        let mut out = Magnitude(vec![value]);
        out.trim();
        out
    }

    fn trim(&mut self) {
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
    }

    fn is_zero(&self) -> bool {
        self.0.is_empty()
    }

    fn compare(&self, other: &Magnitude) -> Ordering {
        self.0.len().cmp(&other.0.len()).then_with(|| {
            for (a, b) in self.0.iter().rev().zip(other.0.iter().rev()) {
                match a.cmp(b) {
                    Ordering::Equal => continue,
                    unequal => return unequal,
                }
            }
            Ordering::Equal
        })
    }

    fn add(&self, other: &Magnitude) -> Magnitude {
        let mut out = Vec::with_capacity(self.0.len().max(other.0.len()) + 1);
        let mut carry = 0u64;
        for k in 0..self.0.len().max(other.0.len()) {
            let sum = u64::from(self.0.get(k).copied().unwrap_or(0))
                + u64::from(other.0.get(k).copied().unwrap_or(0))
                + carry;
            out.push(sum as u32);
            carry = sum >> LIMB_BITS;
        }
        if carry > 0 {
            out.push(carry as u32);
        }
        let mut out = Magnitude(out);
        out.trim();
        out
    }

    fn subtract(&self, smaller: &Magnitude) -> Magnitude {
        let mut out = Vec::with_capacity(self.0.len());
        let mut borrow = 0i64;
        for (k, &limb) in self.0.iter().enumerate() {
            let mut difference =
                i64::from(limb) - i64::from(smaller.0.get(k).copied().unwrap_or(0)) - borrow;
            borrow = 0;
            if difference < 0 {
                difference += 1i64 << LIMB_BITS;
                borrow = 1;
            }
            out.push(difference as u32);
        }
        let mut out = Magnitude(out);
        out.trim();
        out
    }

    fn multiply(&self, other: &Magnitude) -> Magnitude {
        if self.is_zero() || other.is_zero() {
            return Magnitude::default();
        }
        let mut out = vec![0u32; self.0.len() + other.0.len()];
        for (i, &a) in self.0.iter().enumerate() {
            let mut carry = 0u64;
            for (j, &b) in other.0.iter().enumerate() {
                let product = u64::from(a) * u64::from(b) + u64::from(out[i + j]) + carry;
                out[i + j] = product as u32;
                carry = product >> LIMB_BITS;
            }
            let mut k = i + other.0.len();
            while carry > 0 {
                let sum = u64::from(out[k]) + carry;
                out[k] = sum as u32;
                carry = sum >> LIMB_BITS;
                k += 1;
            }
        }
        let mut out = Magnitude(out);
        out.trim();
        out
    }

    fn multiply_small(&self, factor: u32) -> Magnitude {
        self.multiply(&Magnitude::from_u32(factor))
    }

    fn divide_small(&self, divisor: u32) -> (Magnitude, u32) {
        let mut out = vec![0u32; self.0.len()];
        let mut remainder = 0u64;
        for k in (0..self.0.len()).rev() {
            let current = (remainder << LIMB_BITS) | u64::from(self.0[k]);
            out[k] = (current / u64::from(divisor)) as u32;
            remainder = current % u64::from(divisor);
        }
        let mut out = Magnitude(out);
        out.trim();
        (out, remainder as u32)
    }

    fn power(base: u32, exponent: u32) -> Magnitude {
        let mut out = Magnitude::from_u32(1);
        for _ in 0..exponent {
            out = out.multiply_small(base);
        }
        out
    }

    fn decimal(&self) -> String {
        if self.is_zero() {
            return "0".to_string();
        }
        let mut chunks = Vec::new();
        let mut rest = self.clone();
        while !rest.is_zero() {
            let (quotient, chunk) = rest.divide_small(DECIMAL_CHUNK);
            chunks.push(chunk);
            rest = quotient;
        }
        let mut text = String::new();
        for (k, chunk) in chunks.iter().rev().enumerate() {
            if k == 0 {
                text.push_str(&chunk.to_string());
            } else {
                text.push_str(&format!("{chunk:0width$}", width = DECIMAL_CHUNK_DIGITS));
            }
        }
        text
    }
}

struct Token<'a> {
    negative: bool,
    whole: &'a str,
    fraction: &'a str,
    exponent: i64,
}

fn token(text: &str) -> Option<Token<'_>> {
    let (negative, unsigned) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = match mantissa.find('.') {
        Some(at) => (&mantissa[..at], &mantissa[at + 1..]),
        None => (mantissa, ""),
    };
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if whole.len() + fraction.len() == 0 || !digits(whole) || !digits(fraction) {
        return None;
    }
    let exponent = match exponent {
        Some(part) => {
            let unsigned = part.strip_prefix(['+', '-']).unwrap_or(part);
            if unsigned.is_empty() || !digits(unsigned) {
                return None;
            }
            part.parse()
                .ok()
                .filter(|e: &i64| e.abs() <= MAX_EXPONENT)?
        }
        None => 0,
    };
    Some(Token {
        negative,
        whole,
        fraction,
        exponent,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Decimal {
    negative: bool,
    magnitude: Magnitude,
    scale: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RationalText {
    pub numerator: String,
    pub denominator: String,
}

impl Decimal {
    pub fn zero() -> Decimal {
        Decimal::default()
    }

    pub fn is_token(text: &str) -> bool {
        token(text).is_some()
    }

    pub fn parse(text: &str) -> Option<Decimal> {
        let Token {
            negative,
            whole,
            fraction,
            exponent,
        } = token(text)?;
        let mut magnitude = Magnitude::default();
        for digit in whole.bytes().chain(fraction.bytes()) {
            magnitude = magnitude
                .multiply_small(TEN)
                .add(&Magnitude::from_u32(u32::from(digit - b'0')));
        }
        let scale = i64::try_from(fraction.len()).ok()? - exponent;
        let value = if scale >= 0 {
            Decimal {
                negative,
                magnitude,
                scale: u32::try_from(scale).ok()?,
            }
        } else {
            Decimal {
                negative,
                magnitude: magnitude.multiply(&Magnitude::power(TEN, u32::try_from(-scale).ok()?)),
                scale: 0,
            }
        };
        Some(value.normalized())
    }

    fn normalized(mut self) -> Decimal {
        if self.magnitude.is_zero() {
            return Decimal::zero();
        }
        while self.scale > 0 {
            let (quotient, remainder) = self.magnitude.divide_small(TEN);
            if remainder != 0 {
                break;
            }
            self.magnitude = quotient;
            self.scale -= 1;
        }
        self
    }

    fn scaled_to(&self, scale: u32) -> Magnitude {
        self.magnitude
            .multiply(&Magnitude::power(TEN, scale - self.scale))
    }

    pub fn negated(&self) -> Decimal {
        if self.magnitude.is_zero() {
            return Decimal::zero();
        }
        Decimal {
            negative: !self.negative,
            ..self.clone()
        }
    }

    pub fn add(&self, other: &Decimal) -> Decimal {
        let scale = self.scale.max(other.scale);
        let a = self.scaled_to(scale);
        let b = other.scaled_to(scale);
        let (negative, magnitude) = if self.negative == other.negative {
            (self.negative, a.add(&b))
        } else {
            match a.compare(&b) {
                Ordering::Less => (other.negative, b.subtract(&a)),
                _ => (self.negative, a.subtract(&b)),
            }
        };
        Decimal {
            negative,
            magnitude,
            scale,
        }
        .normalized()
    }

    pub fn multiply(&self, other: &Decimal) -> Decimal {
        Decimal {
            negative: self.negative != other.negative,
            magnitude: self.magnitude.multiply(&other.magnitude),
            scale: self.scale + other.scale,
        }
        .normalized()
    }

    pub fn compare(&self, other: &Decimal) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (negative, _) => {
                let scale = self.scale.max(other.scale);
                let order = self.scaled_to(scale).compare(&other.scaled_to(scale));
                if negative {
                    order.reverse()
                } else {
                    order
                }
            }
        }
    }

    pub fn rational(&self) -> RationalText {
        let mut numerator = self.magnitude.clone();
        let mut twos = self.scale;
        let mut fives = self.scale;
        for (factor, left) in [(TWO, &mut twos), (FIVE, &mut fives)] {
            while *left > 0 {
                let (quotient, remainder) = numerator.divide_small(factor);
                if remainder != 0 || numerator.is_zero() {
                    break;
                }
                numerator = quotient;
                *left -= 1;
            }
        }
        let denominator = Magnitude::power(TWO, twos).multiply(&Magnitude::power(FIVE, fives));
        let sign = if self.negative { "-" } else { "" };
        RationalText {
            numerator: format!("{sign}{}", numerator.decimal()),
            denominator: denominator.decimal(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(text: &str) -> Decimal {
        Decimal::parse(text).expect("a decimal token")
    }

    fn rational(text: &str) -> (String, String) {
        let RationalText {
            numerator,
            denominator,
        } = decimal(text).rational();
        (numerator, denominator)
    }

    #[test]
    fn parses_ldraw_decimal_tokens_exactly() {
        assert_eq!(rational("0.3"), ("3".into(), "10".into()));
        assert_eq!(rational("-2.250"), ("-9".into(), "4".into()));
        assert_eq!(rational("+1.5e2"), ("150".into(), "1".into()));
        assert_eq!(rational("1E-005"), ("1".into(), "100000".into()));
        assert_eq!(rational(".5"), ("1".into(), "2".into()));
        assert_eq!(rational("-0.000"), ("0".into(), "1".into()));
        for bad in [
            "", "-", ".", "1e", "1.2.3", "nan", "inf", "0x10", "1e+", "1e-401",
        ] {
            assert_eq!(Decimal::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn adds_multiplies_and_compares_past_the_double_precision() {
        let sum = decimal("0.1").add(&decimal("0.2"));
        assert_eq!(sum.compare(&decimal("0.3")), Ordering::Equal);
        assert_eq!(
            decimal("0.30000000000000001").compare(&sum),
            Ordering::Greater
        );
        let product = decimal("123456789.123456789").multiply(&decimal("-987654321.987654321"));
        assert_eq!(
            product.rational(),
            RationalText {
                numerator: "-121932631356500531347203169112635269".into(),
                denominator: "1000000000000000000".into(),
            }
        );
        assert_eq!(decimal("-1").compare(&decimal("-2")), Ordering::Greater);
        assert_eq!(decimal("-0.5").add(&decimal("0.5")), Decimal::zero());
        assert_eq!(
            decimal("2").negated().compare(&decimal("-2")),
            Ordering::Equal
        );
    }
}
