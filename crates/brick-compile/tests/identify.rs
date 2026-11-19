use std::collections::HashMap;
use std::f64::consts::TAU;

use brick_compile::compile::rolling_mode_from_studs;
use brick_compile::identify::{decimal_sixteenths, identifies, sixteenths, BeyondExactRange};
use brick_compile::rolling::RollingSurface;
use brick_compile::{compile_part, CompileOptions, Library, Lod, TechnicPrimitives};

const STANDARD_FACETS: usize = 16;
const LOW_FACETS: usize = 8;
const LIMIT_TEN_MILLIONTHS: i128 = 5_000;
const BEYOND_TEN_MILLIONTHS: i128 = 5_020;
const SIXTEENTH_TEN_MILLIONTHS: i128 = 625_000;
const TEN_MILLIONTHS_SCALE: u32 = 7;

struct MemoryLibrary(HashMap<String, String>);

impl Library for MemoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }
}

fn band_along_y(x: f64, z: f64, from: f64, to: f64, radius: f64, facets: usize) -> String {
    let point = |y: f64, angle: f64| [x + radius * angle.cos(), y, z + radius * angle.sin()];
    (0..facets)
        .map(|k| {
            let angle = |index: usize| TAU * (index % facets) as f64 / facets as f64;
            let (a, b) = (angle(k), angle(k + 1));
            let corners = [point(from, b), point(from, a), point(to, a), point(to, b)];
            let numbers: Vec<String> = corners.iter().flatten().map(|v| format!("{v}")).collect();
            format!("4 16 {}\n", numbers.join(" "))
        })
        .collect()
}

fn part(title: &str, body: &str) -> String {
    format!("0 {title}\n0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n{body}")
}

fn rolled(bands: &str) -> Vec<RollingSurface> {
    let library = MemoryLibrary(
        [
            ("parts/boundary.dat", part("Boundary Bands", bands)),
            (
                "p/stud.dat",
                part(
                    "Stud",
                    &band_along_y(0.0, 0.0, -4.0, 0.0, 6.0, STANDARD_FACETS),
                ),
            ),
            (
                "p/8/stud.dat",
                part("Stud", &band_along_y(0.0, 0.0, -4.0, 0.0, 6.0, LOW_FACETS)),
            ),
        ]
        .into_iter()
        .map(|(path, text)| (path.to_string(), text))
        .collect(),
    );
    let stud_primitives = vec!["stud.dat".to_string()];
    let options = CompileOptions {
        lod: Lod::Standard,
        rolling_mode: rolling_mode_from_studs(&library, &stud_primitives),
        stud_primitives,
        unofficial_allowlist: Vec::new(),
        technic: TechnicPrimitives::default(),
    };
    compile_part(&library, "boundary.dat", &options)
        .expect("compiles")
        .rolling
        .expect("roundness is measured from the stud")
        .surfaces
}

#[test]
fn the_guard_identifies_an_odd_sixteenth_printed_to_three_decimals_at_every_magnitude() {
    for (value, steps) in [
        (0.063, 1),
        (20.063, 321),
        (100.063, 1601),
        (-0.063, -1),
        (-20.063, -321),
        (-100.063, -1601),
        (0.062, 1),
        (20.062, 321),
        (-100.062, -1601),
    ] {
        assert_eq!(sixteenths(value), Some(steps), "{value}");
    }
}

#[test]
fn the_guard_refuses_two_billionths_beyond_the_limit() {
    for value in [
        0.063_000_002,
        20.063_000_002,
        -100.063_000_002,
        0.061_999_998,
    ] {
        assert_eq!(sixteenths(value), None, "{value}");
    }
    assert!(identifies(0.0005));
    assert!(!identifies(0.000_500_002));
}

#[test]
fn exact_decimals_decide_the_same_boundary_with_no_representation_guard() {
    for ((units, scale), steps) in [
        ((63, 3), 1),
        ((20_063, 3), 321),
        ((100_063, 3), 1601),
        ((-63, 3), -1),
        ((-20_063, 3), -321),
        ((-100_063, 3), -1601),
        ((62, 3), 1),
    ] {
        assert_eq!(
            decimal_sixteenths(units, scale),
            Ok(Some(steps)),
            "{units}e-{scale}"
        );
    }
    assert_eq!(decimal_sixteenths(63_000_002, 9), Ok(None));
    assert_eq!(decimal_sixteenths(630_000_005, 10), Ok(None));
    assert_eq!(sixteenths(0.063_000_000_5), Some(1));
    assert_eq!(decimal_sixteenths(1, 40), Err(BeyondExactRange));
}

#[test]
fn the_guard_agrees_with_exact_decimals_at_the_limit_across_magnitudes() {
    for step in -32_000i128..=32_000 {
        for offset in [
            LIMIT_TEN_MILLIONTHS,
            -LIMIT_TEN_MILLIONTHS,
            BEYOND_TEN_MILLIONTHS,
            -BEYOND_TEN_MILLIONTHS,
        ] {
            let units = step * SIXTEENTH_TEN_MILLIONTHS + offset;
            let sign = if units < 0 { "-" } else { "" };
            let magnitude = units.unsigned_abs();
            let text = format!(
                "{sign}{}.{:07}",
                magnitude / 10_000_000,
                magnitude % 10_000_000
            );
            let parsed: f64 = text.parse().expect("decimal text");
            assert_eq!(
                decimal_sixteenths(units, TEN_MILLIONTHS_SCALE),
                Ok(sixteenths(parsed)),
                "{text}"
            );
        }
    }
}

#[test]
fn band_ends_at_odd_sixteenths_identify_at_every_magnitude_and_beyond_the_limit_stay_unread() {
    let bands = [
        band_along_y(0.0, 0.0, -20.063, -0.063, 10.0, STANDARD_FACETS),
        band_along_y(40.0, 0.0, -100.063, -20.062, 10.0, STANDARD_FACETS),
        band_along_y(-40.0, 0.0, 20.063, 100.063, 10.0, STANDARD_FACETS),
        band_along_y(80.0, 0.0, 0.062, 20.062, 10.0, STANDARD_FACETS),
        band_along_y(-80.0, 0.0, -8.0, -0.063_000_002, 10.0, STANDARD_FACETS),
    ]
    .concat();
    let mut surfaces = rolled(&bands);
    surfaces.sort_by_key(|surface| surface.at);
    let read: Vec<(i32, i32, i32)> = surfaces
        .iter()
        .map(|surface| (surface.at[0], surface.from, surface.to))
        .collect();
    assert_eq!(
        read,
        vec![
            (-640, -1601, -321),
            (0, 1, 321),
            (640, 321, 1601),
            (1280, -321, -1)
        ]
    );
}
