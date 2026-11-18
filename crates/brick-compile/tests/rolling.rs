mod common;

use std::f64::consts::TAU;

use brick_compile::rolling::{RollingSurface, Roundness, Unread};
use brick_compile::{compile_part, CompileOptions, Lod};
use common::{fixture_library, MemoryLibrary};

const HEADER: &str = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n";

struct Band {
    axis: [f64; 3],
    across: [[f64; 3]; 2],
    centre: [f64; 3],
    from: f64,
    to: f64,
    radii: [f64; 2],
    facets: usize,
    phase: f64,
    outward: bool,
}

impl Band {
    fn along(axis: usize, centre: [f64; 3], from: f64, to: f64, radii: [f64; 2]) -> Band {
        let unit = |k: usize| {
            let mut v = [0.0; 3];
            v[k] = 1.0;
            v
        };
        let [p, q] = match axis {
            0 => [1, 2],
            1 => [0, 2],
            _ => [0, 1],
        };
        Band {
            axis: unit(axis),
            across: [unit(p), unit(q)],
            centre,
            from,
            to,
            radii,
            facets: 16,
            phase: 0.0,
            outward: true,
        }
    }

    fn point(&self, t: f64, radius: f64, angle: f64) -> [f64; 3] {
        let (c, s) = (angle.cos(), angle.sin());
        [0, 1, 2].map(|k| {
            self.centre[k]
                + self.axis[k] * t
                + radius * (c * self.across[0][k] + s * self.across[1][k])
        })
    }

    fn quads(&self) -> String {
        let mut out = String::new();
        for k in 0..self.facets {
            let a = self.phase + TAU * k as f64 / self.facets as f64;
            let b = self.phase + TAU * (k + 1) as f64 / self.facets as f64;
            let mut quad = [
                self.point(self.from, self.radii[0], a),
                self.point(self.from, self.radii[0], b),
                self.point(self.to, self.radii[1], b),
                self.point(self.to, self.radii[1], a),
            ];
            let normal = cross(sub(quad[1], quad[0]), sub(quad[2], quad[0]));
            let middle = self.point((self.from + self.to) / 2.0, 0.0, 0.0);
            let radial = sub(quad[0], middle);
            if (dot(normal, radial) > 0.0) != self.outward {
                quad.reverse();
            }
            out.push('4');
            out.push_str(" 16");
            for p in quad {
                for v in p {
                    out.push_str(&format!(" {v:.6}"));
                }
            }
            out.push('\n');
        }
        out
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn stud(facets: usize) -> String {
    let side = Band {
        facets,
        ..Band::along(1, [0.0; 3], -4.0, 0.0, [6.0, 6.0])
    };
    format!("0 Stud\n{HEADER}{}", side.quads())
}

fn custom_wheel() -> String {
    let tread = Band::along(0, [0.0, -12.0, 0.0], -4.0, 6.0, [20.0, 20.0]);
    let flange = Band::along(0, [0.0, -12.0, 0.0], 6.0, 8.0, [20.0, 24.0]);
    let bore = Band {
        outward: false,
        ..Band::along(0, [0.0, -12.0, 0.0], -4.0, 8.0, [4.0, 4.0])
    };
    let post = Band::along(1, [0.0, 0.0, 60.0], -24.0, 0.0, [8.0, 8.0]);
    let octagon = Band {
        facets: 8,
        ..Band::along(2, [60.0, 0.0, 0.0], 0.0, 10.0, [10.0, 10.0])
    };
    let turned = Band {
        phase: TAU / 32.0,
        ..Band::along(1, [-60.0, 0.0, 0.0], -8.0, 0.0, [10.0, 10.0])
    };
    let diagonal = std::f64::consts::FRAC_1_SQRT_2;
    let tilted = Band {
        axis: [diagonal, diagonal, 0.0],
        across: [[diagonal, -diagonal, 0.0], [0.0, 0.0, 1.0]],
        ..Band::along(0, [0.0, 60.0, 60.0], 0.0, 10.0, [10.0, 10.0])
    };
    let bands = [tread, flange, bore, post, octagon, turned, tilted];
    let body: String = bands.iter().map(Band::quads).collect();
    format!("0 Custom wheel drawn from plain quads\n{HEADER}{body}")
}

fn library(standard_stud_facets: usize, coarse_stud_facets: usize) -> MemoryLibrary {
    MemoryLibrary(
        [
            ("parts/custom-wheel.dat", custom_wheel()),
            ("p/stud.dat", stud(standard_stud_facets)),
            ("p/8/stud.dat", stud(coarse_stud_facets)),
        ]
        .into_iter()
        .map(|(path, text)| (path.to_string(), text))
        .collect(),
    )
}

fn options<L: brick_compile::Library>(library: &L, lod: Lod) -> CompileOptions {
    let stud_primitives = vec!["stud.dat".to_string(), "stud2.dat".to_string()];
    CompileOptions {
        lod,
        roundness: Roundness::measured(library, &stud_primitives),
        stud_primitives,
        unofficial_allowlist: Vec::new(),
    }
}

fn sixteenths(ldu: f64) -> i32 {
    (ldu * 16.0) as i32
}

#[test]
fn a_custom_part_drawn_from_plain_quads_yields_its_outward_bands_on_every_axis() {
    let library = library(16, 8);
    let compiled = compile_part(
        &library,
        "custom-wheel.dat",
        &options(&library, Lod::Standard),
    )
    .expect("compiles");
    let rolling = compiled
        .rolling
        .as_ref()
        .expect("roundness is measured from the studs");
    let surface = |axis, at: [f64; 2], from: f64, to: f64, radii: [f64; 2]| RollingSurface {
        axis,
        at: at.map(sixteenths),
        from: sixteenths(from),
        to: sixteenths(to),
        radii: radii.map(sixteenths),
    };
    assert_eq!(
        rolling.surfaces,
        vec![
            surface(0, [12.0, 0.0], -4.0, 6.0, [20.0, 20.0]),
            surface(0, [12.0, 0.0], 6.0, 8.0, [20.0, 24.0]),
            surface(1, [0.0, -60.0], 0.0, 24.0, [8.0, 8.0]),
        ]
    );
    let reasons: Vec<(Unread, Option<usize>, Option<[i32; 2]>)> = rolling
        .unread
        .iter()
        .map(|band| (band.reason, band.axis, band.at))
        .collect();
    assert_eq!(
        reasons,
        vec![
            (Unread::Unoriented, None, None),
            (Unread::Radius, Some(1), Some([sixteenths(-60.0), 0])),
            (Unread::Faceted, Some(2), Some([sixteenths(60.0), 0])),
        ]
    );
    assert_eq!(
        compiled.extras()["rolling"]["surfaces"][0]["source"],
        "measured"
    );
}

#[test]
fn the_roundness_threshold_follows_the_stud_geometry_it_is_measured_from() {
    let library = library(8, 8);
    let compiled = compile_part(
        &library,
        "custom-wheel.dat",
        &options(&library, Lod::Standard),
    )
    .expect("compiles");
    let rolling = compiled
        .rolling
        .expect("roundness is measured from the studs");
    assert!(rolling
        .surfaces
        .iter()
        .any(|s| s.axis == 2 && s.at == [sixteenths(60.0), 0]));
    assert!(rolling.unread.iter().all(|u| u.reason != Unread::Faceted));
}

#[test]
fn the_official_train_wheel_reads_its_whole_outward_profile_at_every_lod() {
    let library = fixture_library();
    let standard = compile_part(&library, "2879.dat", &options(&library, Lod::Standard))
        .expect("compiles")
        .rolling
        .expect("roundness is measured from the studs");
    let profile: Vec<(i32, i32, [i32; 2])> = standard
        .surfaces
        .iter()
        .filter(|s| s.axis == 2 && s.at == [0, 0])
        .map(|s| (s.from, s.to, s.radii))
        .collect();
    let ldu = |from: f64, to: f64, r0: f64, r1: f64| {
        (sixteenths(from), sixteenths(to), [r0, r1].map(sixteenths))
    };
    assert_eq!(
        profile,
        vec![
            ldu(-8.0, -6.0, 29.0, 29.0),
            ldu(-8.0, -5.0, 6.25, 6.25),
            ldu(-6.0, -3.5, 29.0, 21.0),
            ldu(-3.5, 2.0, 21.0, 20.5),
            ldu(-1.0, 2.0, 6.25, 6.25),
        ]
    );
    let low = compile_part(&library, "2879.dat", &options(&library, Lod::Low))
        .expect("compiles")
        .rolling;
    assert_eq!(low, Some(standard));
}
