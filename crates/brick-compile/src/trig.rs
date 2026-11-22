pub fn planar_length(a: f64, b: f64) -> f64 {
    (a * a + b * b).sqrt()
}

pub use libm::{acos, atan2, cos, sin, sincos};
