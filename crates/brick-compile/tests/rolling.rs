mod common;

use std::f64::consts::TAU;

use brick_compile::compile::rolling_mode_from_studs;
use brick_compile::rolling::RollingSurface;
use brick_compile::trig::{cos, sin};
use brick_compile::{compile_part, CompileOptions, Library, Lod, TechnicPrimitives};
use common::{fixture_library, MemoryLibrary};
use serde_json::{json, Value};

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
    high_wobble: f64,
    missing: &'static [usize],
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
            high_wobble: 0.0,
            missing: &[],
        }
    }

    fn angle(&self, k: usize) -> f64 {
        self.phase + TAU * k as f64 / self.facets as f64
    }

    fn point(&self, t: f64, radius: f64, angle: f64) -> Point {
        let (c, s) = (cos(angle), sin(angle));
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

    fn alternately_cut_lines(&self, first: f64, step: f64) -> String {
        let low = |j: usize| self.point(self.from, self.radii[0], self.angle(j));
        let high = |j: usize| self.point(self.to, self.radii[1], self.angle(j));
        let cut = |j: usize| {
            let t = first + step * ((j % self.facets) / 2) as f64;
            self.point(t, self.radius_at(t), self.angle(j))
        };
        let mut out = String::new();
        for k in 0..self.facets {
            let (left, right) = (k, k + 1);
            let triangles = if left % 2 == 0 {
                [
                    vec![low(left), low(right), high(right)],
                    vec![low(left), high(right), cut(left)],
                    vec![cut(left), high(right), high(left)],
                ]
            } else {
                [
                    vec![low(left), low(right), high(left)],
                    vec![low(right), cut(right), high(left)],
                    vec![cut(right), high(right), high(left)],
                ]
            };
            for corners in triangles {
                out.push_str(&self.polygon(corners));
            }
        }
        out
    }

    fn lines(&self) -> String {
        let mut out = String::new();
        for k in (0..self.drawn).filter(|k| !self.missing.contains(k)) {
            let (a, b) = (self.angle(k), self.angle(k + 1));
            let low = |angle| self.point(self.from, self.radii[0], angle);
            let high = |index: usize| {
                let angle = self.angle(index);
                let top = self.to + self.oblique_top * self.radii[1] * cos(angle);
                let wobble = if index % 2 == 1 {
                    self.high_wobble
                } else {
                    0.0
                };
                let p = self.point(top, self.radii[1] + wobble, angle);
                [0, 1, 2].map(|k| p[k] + self.high_shift[k])
            };
            match self.meridian_cuts {
                None => out.push_str(&self.polygon(vec![low(a), low(b), high(k + 1), high(k)])),
                Some([first, step]) => {
                    let cut = |j: usize| {
                        let t = first + step * (j % self.facets) as f64;
                        self.point(t, self.radius_at(t), self.angle(j))
                    };
                    let (here, next) = (cut(k), cut(k + 1));
                    out.push_str(&self.polygon(vec![low(a), low(b), next]));
                    out.push_str(&self.polygon(vec![low(a), next, here]));
                    out.push_str(&self.polygon(vec![here, next, high(k + 1)]));
                    out.push_str(&self.polygon(vec![here, high(k + 1), high(k)]));
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
    let off_grid_cone_end = Band::along(1, at(-100.0, 0.0, 60.0), -10.003, 0.0, [10.0, 12.0]);
    let split_by_prints = Band {
        missing: &[2, 3, 4, 5, 10, 11, 12, 13],
        ..Band::along(1, at(140.0, 0.0, 0.0), -8.0, 0.0, [10.0, 10.0])
    };
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
        ..Band::along(1, at(-100.0, 0.0, 0.0), -8.0, 0.0, [12.0, 12.0])
    };
    let off_grid_ring = 0.001;
    let cut_up_to_an_off_grid_ring = Band {
        meridian_cuts: Some([40.25, 0.25]),
        high_shift: [0.0, off_grid_ring, 0.0],
        ..Band::along(0, at(0.0, -120.0, 0.0), 40.0, 45.0, [8.0, 8.0])
    };
    let cut_obliquely_beyond_it = Band {
        oblique_top: 0.25,
        ..Band::along(
            0,
            at(0.0, -120.0 + off_grid_ring, 0.0),
            45.0,
            50.0,
            [8.0, 8.0],
        )
    };
    let round_below_a_wobbly_ring = Band {
        high_wobble: 0.5,
        ..Band::along(1, at(100.0, 0.0, 0.0), -8.0, 0.0, [10.0, 10.0])
    };
    let rings_a_stud_apart = Band {
        high_shift: [1.0, 0.0, 0.0],
        ..Band::along(1, at(100.0, 0.0, 40.0), -8.0, 0.0, [10.0, 10.0])
    };
    let notched_below_a_wobbly_ring = Band {
        drawn: 15,
        high_wobble: 0.5,
        ..Band::along(2, at(-100.0, 0.0, 0.0), 0.0, 10.0, [10.0, 10.0])
    };
    let notched_and_cut_on_every_meridian = Band {
        drawn: 15,
        meridian_cuts: Some([81.0, 0.5]),
        ..Band::along(0, at(0.0, -200.0, 0.0), 80.0, 90.0, [8.0, 8.0])
    };
    let notched_before_an_oblique_cut = Band {
        drawn: 15,
        ..Band::along(0, at(0.0, -240.0, 0.0), 100.0, 105.0, [8.0, 8.0])
    };
    let oblique_cut_after_a_notched_band = Band {
        oblique_top: 0.25,
        ..Band::along(0, at(0.0, -240.0, 0.0), 105.0, 110.0, [8.0, 8.0])
    };
    let two_arcs = Band {
        missing: &[7, 15],
        ..Band::along(0, at(0.0, -280.0, 0.0), 120.0, 125.0, [8.0, 8.0])
    };
    let oblique_cut_above_one_arc = Band {
        drawn: 7,
        oblique_top: 0.25,
        ..Band::along(0, at(0.0, -280.0, 0.0), 125.0, 130.0, [8.0, 8.0])
    };
    let alternate_meridians_cut = Band::along(0, at(0.0, -160.0, 0.0), 60.0, 70.0, [8.0, 8.0]);
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
        off_grid_cone_end,
        split_by_prints,
        notched,
        cut_on_every_meridian,
        cut_obliquely,
        cone_cut_on_every_meridian,
        rings_a_sixteenth_apart,
        cut_up_to_an_off_grid_ring,
        cut_obliquely_beyond_it,
        round_below_a_wobbly_ring,
        rings_a_stud_apart,
        notched_below_a_wobbly_ring,
        notched_and_cut_on_every_meridian,
        notched_before_an_oblique_cut,
        oblique_cut_after_a_notched_band,
        two_arcs,
        oblique_cut_above_one_arc,
        read_before_an_oblique_cut,
        oblique_cut_after_a_read_band,
        tilted,
    ];
    let body: String = bands
        .iter()
        .map(Band::lines)
        .chain([alternate_meridians_cut.alternately_cut_lines(61.0, 1.0)])
        .collect();
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
        rolling_mode: rolling_mode_from_studs(library, &stud_primitives),
        stud_primitives,
        unofficial_allowlist: Vec::new(),
        technic: TechnicPrimitives::default(),
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
            surface(0, [160.0, 0.0], 60.0, 70.0, [8.0, 8.0]),
            surface(1, [-60.0, 0.0], 0.0, 8.0, [10.0, 10.0]),
            surface(1, [0.0, -60.0], 0.0, 24.0, [8.0, 8.0]),
            surface(1, [60.0, -60.0], 0.0, 10.0, [10.0, 10.0]),
        ]
    );
    let extras = compiled.extras();
    assert_eq!(extras["rolling"]["surfaces"][0]["source"], "measured");
    let unread = compiled.rolling_diagnostics();
    let served: Vec<Value> = unread
        .iter()
        .map(|row| {
            let mut entry = json!({ "reason": row["reason"] });
            if let Some(axis) = row.get("axis") {
                entry["axis"] = axis.clone();
            }
            entry
        })
        .collect();
    assert_eq!(extras["rolling"]["unread"], Value::Array(served));
    for row in &unread {
        assert!(
            exact(&row["raw"]["from"]) <= exact(&row["raw"]["to"]),
            "{row}"
        );
    }
    let width = unread
        .iter()
        .find(|row| row["reason"] == "width")
        .expect("the cone's row");
    assert_eq!(exact(&width["raw"]["to"]).to_bits(), 10.003_f64.to_bits());
    let without_raw: Vec<Value> = unread
        .iter()
        .map(|row| {
            let mut row = row.clone();
            row.as_object_mut()
                .expect("a row is an object")
                .remove("raw");
            row
        })
        .collect();
    assert_eq!(
        Value::Array(without_raw),
        json!([
            { "reason": "unoriented" },
            { "reason": "centre", "axis": 1, "radii": [160, 160], "from": 0, "to": 128 },
            { "reason": "centre", "axis": 1, "radii": [192, 192], "from": 0, "to": 128 },
            {
                "reason": "radius",
                "axis": 1,
                "at": [-960, -960],
                "radii": [null, null],
                "from": 0,
                "to": 128
            },
            { "reason": "width", "axis": 1, "at": [-1600, -960], "radii": [192, 160], "from": 0 },
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
                "reason": "partial",
                "axis": 0,
                "at": [4480, 0],
                "radii": [128, 128],
                "from": 1920,
                "to": 2000
            },
            {
                "reason": "partial",
                "axis": 2,
                "at": [-1600, 0],
                "radii": [null, 160],
                "from": -160,
                "to": 0
            },
            {
                "reason": "facing",
                "axis": 2,
                "at": [-960, 640],
                "radii": [160, 160],
                "from": -160,
                "to": 0
            },
            { "reason": "irregular", "axis": 0, "radii": [128, null], "from": 640, "to": 832 },
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
            {
                "reason": "irregular",
                "axis": 0,
                "at": [3200, 0],
                "radii": [128, 128],
                "from": 1280,
                "to": 1440
            },
            {
                "reason": "irregular",
                "axis": 0,
                "at": [3840, 0],
                "radii": [128, null],
                "from": 1600,
                "to": 1792
            },
            {
                "reason": "irregular",
                "axis": 0,
                "at": [4480, 0],
                "radii": [128, null],
                "from": 1920,
                "to": 2112
            },
            { "reason": "irregular", "axis": 1, "radii": [160, 160], "from": 0, "to": 128 },
            {
                "reason": "irregular",
                "axis": 1,
                "at": [1600, 0],
                "radii": [null, 160],
                "from": 0,
                "to": 128
            },
            {
                "reason": "arcs",
                "axis": 1,
                "at": [2240, 0],
                "radii": [160, 160],
                "from": 0,
                "to": 128
            },
        ])
    );
}

fn exact(text: &Value) -> f64 {
    let numerator: i64 = text["numerator"]
        .as_str()
        .expect("numerator")
        .parse()
        .expect("integer");
    let denominator: f64 = text["denominator"]
        .as_str()
        .expect("denominator")
        .parse()
        .expect("integer");
    assert!(numerator.unsigned_abs() < 1 << 53, "{text}");
    assert_eq!(
        denominator.to_bits() & ((1 << 52) - 1),
        0,
        "the denominator is a power of two: {text}"
    );
    assert!(denominator == 1.0 || numerator % 2 != 0, "reduced: {text}");
    numerator as f64 / denominator
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
