mod common;

use std::f64::consts::TAU;

use brick_compile::compile::stud_roundness;
use brick_compile::rolling::RollingSurface;
use brick_compile::{compile_part, CompileOptions, Library, Lod};
use common::{fixture_library, MemoryLibrary};
use serde_json::json;

const LICENSE: &str = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt\n";
const WOUND: &str = "0 BFC CERTIFY CCW\n";

type Point = [f64; 3];

struct Band {
    axis: Point,
    across: [Point; 2],
    centre: Point,
    from: f64,
    to: f64,
    radii: [f64; 2],
    facets: usize,
    drawn: usize,
    phase: f64,
    outward: bool,
    meridian_cuts: Option<[f64; 2]>,
    oblique_top: f64,
    high_shift: Point,
}

impl Band {
    fn along(axis: usize, centre: Point, from: f64, to: f64, radii: [f64; 2]) -> Band {
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
            drawn: 16,
            phase: 0.0,
            outward: true,
            meridian_cuts: None,
            oblique_top: 0.0,
            high_shift: [0.0; 3],
        }
    }

    fn angle(&self, k: usize) -> f64 {
        self.phase + TAU * k as f64 / self.facets as f64
    }

    fn point(&self, t: f64, radius: f64, angle: f64) -> Point {
        let (c, s) = (angle.cos(), angle.sin());
        [0, 1, 2].map(|k| {
            self.centre[k]
                + self.axis[k] * t
                + radius * (c * self.across[0][k] + s * self.across[1][k])
        })
    }

    fn radius_at(&self, t: f64) -> f64 {
        let along = (t - self.from) / (self.to - self.from);
        self.radii[0] + (self.radii[1] - self.radii[0]) * along
    }

    fn polygon(&self, corners: Vec<Point>) -> String {
        let mut corners = corners;
        let middle = self.point((self.from + self.to) / 2.0, 0.0, 0.0);
        let normal = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
        if (dot(normal, sub(corners[0], middle)) > 0.0) != self.outward {
            corners.reverse();
        }
        let mut line = format!("{} 16", corners.len());
        for p in corners {
            for v in p {
                line.push_str(&format!(" {v:.6}"));
            }
        }
        line + "\n"
    }

    fn lines(&self) -> String {
        let mut out = String::new();
        for k in 0..self.drawn {
            let (a, b) = (self.angle(k), self.angle(k + 1));
            let low = |angle| self.point(self.from, self.radii[0], angle);
            let high = |angle: f64| {
                let top = self.to + self.oblique_top * self.radii[1] * angle.cos();
                let p = self.point(top, self.radii[1], angle);
                [0, 1, 2].map(|k| p[k] + self.high_shift[k])
            };
            match self.meridian_cuts {
                None => out.push_str(&self.polygon(vec![low(a), low(b), high(b), high(a)])),
                Some([first, step]) => {
                    let cut = |j: usize| {
                        let t = first + step * (j % self.facets) as f64;
                        self.point(t, self.radius_at(t), self.angle(j))
                    };
                    let (here, next) = (cut(k), cut(k + 1));
                    out.push_str(&self.polygon(vec![low(a), low(b), next]));
                    out.push_str(&self.polygon(vec![low(a), next, here]));
                    out.push_str(&self.polygon(vec![here, next, high(b)]));
                    out.push_str(&self.polygon(vec![here, high(b), high(a)]));
                }
            }
        }
        out
    }
}

fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn stud(facets: usize) -> String {
    let side = Band {
        facets,
        drawn: facets,
        ..Band::along(1, [0.0; 3], -4.0, 0.0, [6.0, 6.0])
    };
    format!("0 Stud\n{LICENSE}{WOUND}{}", side.lines())
}

fn custom_wheel() -> String {
    let at = |x: f64, y: f64, z: f64| [x, y, z];
    let tread = Band::along(0, at(0.0, -12.0, 0.0), -4.0, 6.0, [20.0, 20.0]);
    let flange = Band::along(0, at(0.0, -12.0, 0.0), 6.0, 8.0, [20.0, 24.0]);
    let bore = Band {
        outward: false,
        ..Band::along(0, at(0.0, -12.0, 0.0), -4.0, 8.0, [4.0, 4.0])
    };
    let post = Band::along(1, at(0.0, 0.0, 60.0), -24.0, 0.0, [8.0, 8.0]);
    let turned = Band {
        phase: TAU / 32.0,
        ..Band::along(1, at(-60.0, 0.0, 0.0), -8.0, 0.0, [10.0, 10.0])
    };
    let octagon = Band {
        facets: 8,
        drawn: 8,
        ..Band::along(2, at(60.0, 0.0, 0.0), 0.0, 10.0, [10.0, 10.0])
    };
    let off_grid_radius = Band::along(1, at(-60.0, 0.0, 60.0), -8.0, 0.0, [10.01, 10.01]);
    let off_grid_centre = Band::along(1, at(60.01, 0.0, -60.0), -8.0, 0.0, [10.0, 10.0]);
    let off_grid_end = Band::along(1, at(60.0, 0.0, 60.0), -10.003, 0.0, [10.0, 10.0]);
    let notched = Band {
        drawn: 15,
        ..Band::along(0, at(0.0, -12.0, 60.0), 20.0, 30.0, [10.0, 10.0])
    };
    let cut_on_every_meridian = Band {
        meridian_cuts: Some([41.0, 0.5]),
        ..Band::along(0, at(0.0, -40.0, -60.0), 40.0, 50.0, [8.0, 8.0])
    };
    let cut_obliquely = Band {
        oblique_top: 0.25,
        ..Band::along(0, at(0.0, -40.0, 60.0), 40.0, 50.0, [8.0, 8.0])
    };
    let cone_cut_on_every_meridian = Band {
        meridian_cuts: Some([41.0, 0.5]),
        ..Band::along(0, at(0.0, -40.0, -20.0), 40.0, 50.0, [8.0, 6.0])
    };
    let rings_a_sixteenth_apart = Band {
        high_shift: [1.0 / 16.0, 0.0, 0.0],
        ..Band::along(1, at(-100.0, 0.0, 0.0), -8.0, 0.0, [10.0, 10.0])
    };
    let read_before_an_oblique_cut = Band::along(0, at(0.0, -80.0, 0.0), 40.0, 45.0, [8.0, 8.0]);
    let oblique_cut_after_a_read_band = Band {
        oblique_top: 0.25,
        ..Band::along(0, at(0.0, -80.0, 0.0), 45.0, 50.0, [8.0, 8.0])
    };
    let diagonal = std::f64::consts::FRAC_1_SQRT_2;
    let tilted = Band {
        axis: [diagonal, diagonal, 0.0],
        across: [[diagonal, -diagonal, 0.0], [0.0, 0.0, 1.0]],
        ..Band::along(0, at(0.0, 60.0, 60.0), 0.0, 10.0, [10.0, 10.0])
    };
    let bands = [
        tread,
        flange,
        bore,
        post,
        turned,
        octagon,
        off_grid_radius,
        off_grid_centre,
        off_grid_end,
        notched,
        cut_on_every_meridian,
        cut_obliquely,
        cone_cut_on_every_meridian,
        rings_a_sixteenth_apart,
        read_before_an_oblique_cut,
        oblique_cut_after_a_read_band,
        tilted,
    ];
    let body: String = bands.iter().map(Band::lines).collect();
    format!(
        "0 Custom wheel drawn from plain quads\n{LICENSE}{WOUND}{body}1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\unwound.dat\n"
    )
}

fn unwound() -> String {
    let band = Band::along(2, [-60.0, -40.0, 0.0], 0.0, 10.0, [10.0, 10.0]);
    format!("0 ~Band without BFC winding\n{LICENSE}{}", band.lines())
}

fn library(standard_stud_facets: usize, coarse_stud_facets: usize) -> MemoryLibrary {
    MemoryLibrary(
        [
            ("parts/custom-wheel.dat", custom_wheel()),
            ("parts/s/unwound.dat", unwound()),
            ("p/stud.dat", stud(standard_stud_facets)),
            ("p/8/stud.dat", stud(coarse_stud_facets)),
        ]
        .into_iter()
        .map(|(path, text)| (path.to_string(), text))
        .collect(),
    )
}

fn options<L: Library>(library: &L, lod: Lod) -> CompileOptions {
    let stud_primitives = vec!["stud.dat".to_string(), "stud2.dat".to_string()];
    CompileOptions {
        lod,
        roundness: stud_roundness(library, &stud_primitives),
        stud_primitives,
        unofficial_allowlist: Vec::new(),
    }
}

fn sixteenths(ldu: f64) -> i32 {
    (ldu * 16.0) as i32
}

fn surface(axis: usize, at: [f64; 2], from: f64, to: f64, radii: [f64; 2]) -> RollingSurface {
    RollingSurface {
        axis,
        at: at.map(sixteenths),
        from: sixteenths(from),
        to: sixteenths(to),
        radii: radii.map(sixteenths),
    }
}

#[test]
fn a_custom_part_drawn_from_plain_quads_reads_its_bands_and_reports_the_rest() {
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
    assert_eq!(
        rolling.surfaces,
        vec![
            surface(0, [12.0, 0.0], -4.0, 6.0, [20.0, 20.0]),
            surface(0, [12.0, 0.0], 6.0, 8.0, [20.0, 24.0]),
            surface(0, [40.0, 20.0], 40.0, 50.0, [8.0, 6.0]),
            surface(0, [40.0, 60.0], 40.0, 50.0, [8.0, 8.0]),
            surface(0, [80.0, 0.0], 40.0, 45.0, [8.0, 8.0]),
            surface(1, [-60.0, 0.0], 0.0, 8.0, [10.0, 10.0]),
            surface(1, [0.0, -60.0], 0.0, 24.0, [8.0, 8.0]),
        ]
    );
    let extras = compiled.extras();
    assert_eq!(extras["rolling"]["surfaces"][0]["source"], "measured");
    assert_eq!(
        extras["rolling"]["unread"],
        json!([
            { "reason": "unoriented" },
            { "reason": "centre", "axis": 1, "radii": [160, 160], "from": 0, "to": 128 },
            { "reason": "centre", "axis": 1, "radii": [160, 160], "from": 0, "to": 128 },
            {
                "reason": "radius",
                "axis": 1,
                "at": [-960, -960],
                "radii": [null, null],
                "from": 0,
                "to": 128
            },
            { "reason": "width", "axis": 1, "at": [960, -960], "radii": [160, 160], "from": 0 },
            {
                "reason": "faceted",
                "axis": 2,
                "at": [960, 0],
                "radii": [160, 160],
                "from": -160,
                "to": 0
            },
            {
                "reason": "partial",
                "axis": 0,
                "at": [192, -960],
                "radii": [160, 160],
                "from": 320,
                "to": 480
            },
            {
                "reason": "facing",
                "axis": 2,
                "at": [-960, 640],
                "radii": [160, 160],
                "from": -160,
                "to": 0
            },
            {
                "reason": "irregular",
                "axis": 0,
                "at": [640, -960],
                "radii": [128, null],
                "from": 640,
                "to": 832
            },
            {
                "reason": "irregular",
                "axis": 0,
                "at": [1280, 0],
                "radii": [128, null],
                "from": 720,
                "to": 832
            },
        ])
    );
}

#[test]
fn the_roundness_threshold_follows_the_stud_geometry_it_is_measured_from() {
    let library = library(8, 8);
    let rolling = compile_part(
        &library,
        "custom-wheel.dat",
        &options(&library, Lod::Standard),
    )
    .expect("compiles")
    .rolling
    .expect("roundness is measured from the studs");
    assert!(rolling
        .surfaces
        .contains(&surface(2, [60.0, 0.0], -10.0, 0.0, [10.0, 10.0])));
}

#[test]
fn the_official_train_wheel_reads_its_whole_outward_profile_at_every_lod() {
    let library = fixture_library();
    let standard = compile_part(&library, "2879.dat", &options(&library, Lod::Standard))
        .expect("compiles")
        .rolling
        .expect("roundness is measured from the studs");
    assert_eq!(
        standard.surfaces,
        vec![
            surface(2, [0.0, 0.0], -8.0, -6.0, [29.0, 29.0]),
            surface(2, [0.0, 0.0], -8.0, -5.0, [6.25, 6.25]),
            surface(2, [0.0, 0.0], -6.0, -3.5, [29.0, 21.0]),
            surface(2, [0.0, 0.0], -3.5, 2.0, [21.0, 20.5]),
            surface(2, [0.0, 0.0], -1.0, 2.0, [6.25, 6.25]),
        ]
    );
    assert_eq!(standard.unread, vec![]);
    for lod in [Lod::Low, Lod::Far] {
        let rolling = compile_part(&library, "2879.dat", &options(&library, lod))
            .expect("compiles")
            .rolling;
        assert_eq!(rolling.as_ref(), Some(&standard));
    }
}
