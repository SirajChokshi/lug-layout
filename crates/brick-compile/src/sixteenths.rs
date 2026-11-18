pub const PER_LDU: i32 = 16;
const IDENTIFY_LDU: f64 = 0.0005;

pub fn identified(value: f64) -> Option<i32> {
    let steps = f64::from(PER_LDU);
    let q = value * steps;
    let n = q.round();
    ((q - n).abs() <= IDENTIFY_LDU * steps).then_some(n as i32)
}
