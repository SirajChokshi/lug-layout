mod common;

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use brick_compile::affine::Affine;
use brick_compile::bake::ModelBaker;
use brick_compile::colors::{parse_ldconfig, translucent_codes};
use brick_compile::compile::stud_primitives_from_table;
use brick_compile::glyph::{Glyph, GlyphBaker, GlyphInstance, StudMeshes};
use brick_compile::model::bake_model;
use brick_compile::{compile_part, CompileOptions, Library};
use common::{fixture_library, MemoryLibrary};

const FULL: u8 = 16;
const SAMPLES_PER_PIXEL_SIDE: i64 = 4;
const PIXELS_PER_STUD: i64 = 8;
const MAIN_COLOUR: u32 = 16;
const RED: u32 = 4;
const YELLOW: u32 = 14;
const TRANS_CLEAR: u32 = 47;

fn repository_file(path: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path),
    )
    .expect("the repository file is readable")
}

fn stud_primitives() -> Vec<String> {
    let table: serde_json::Value = serde_json::from_slice(&repository_file(
        "tools/asset-pipeline/primitive-connectors.json",
    ))
    .expect("the primitive table is JSON");
    stud_primitives_from_table(&table).expect("the table lists studs")
}

fn translucent() -> HashSet<u32> {
    let ldconfig =
        String::from_utf8(repository_file(".cache/ldraw/LDConfig.ldr")).expect("LDConfig is UTF-8");
    translucent_codes(&parse_ldconfig(&ldconfig))
}

fn table_depth() -> f64 {
    let geometry: serde_json::Value =
        serde_json::from_slice(&repository_file("docs/verified-facts/geometry.json"))
            .expect("the verified geometry is JSON");
    geometry["tablePlane"]["depthBelowTopLdu"]
        .as_f64()
        .expect("the table plane has a depth")
}

fn pixel(glyph: &Glyph, column: u32, row: u32) -> (u8, u32) {
    let at = (column + glyph.width * row) as usize;
    (
        glyph.coverage[at],
        glyph.colors[glyph.color_index[at] as usize],
    )
}

fn covered_samples(glyph: &Glyph) -> u64 {
    glyph.coverage.iter().map(|&count| u64::from(count)).sum()
}

struct Glyphs<L: Library> {
    library: L,
    studs: StudMeshes,
    translucent: HashSet<u32>,
    options: CompileOptions,
}

impl<L: Library> Glyphs<L> {
    fn new(library: L) -> Self {
        let options = CompileOptions {
            stud_primitives: stud_primitives(),
            ..CompileOptions::default()
        };
        let studs = StudMeshes::compile(&library, &options.stud_primitives, &[])
            .expect("the stud primitives compile");
        Glyphs {
            library,
            studs,
            translucent: translucent(),
            options,
        }
    }

    fn placed(&self, part: &str, matrix: &Affine, color: u32) -> Glyph {
        let compiled = compile_part(&self.library, part, &self.options).expect("the part compiles");
        GlyphBaker::new(&self.studs, &self.translucent)
            .model(&[GlyphInstance {
                mesh: &compiled.mesh,
                studs: &compiled.studs,
                color,
                matrix,
            }])
            .expect("the glyph bakes")
    }

    fn part(&self, part: &str) -> Glyph {
        let compiled = compile_part(&self.library, part, &self.options).expect("the part compiles");
        GlyphBaker::new(&self.studs, &self.translucent)
            .part(&compiled.mesh, &compiled.studs)
            .expect("the glyph bakes")
    }

    fn model(&self, source: &str) -> Glyph {
        let model = bake_model(source).expect("the model reads");
        let mut baker = ModelBaker::new(
            &self.library,
            self.options.stud_primitives.clone(),
            Vec::new(),
            self.translucent.clone(),
            table_depth(),
        )
        .expect("the baker starts");
        baker
            .glyph(&model.instances)
            .expect("the model glyph bakes")
    }
}

fn starts_along_x(vertices: &[[u16; 2]], at: usize) -> bool {
    vertices[at][1] == vertices[(at + 1) % vertices.len()][1]
}

fn canonical(mut loops: Vec<Vec<[u16; 2]>>) -> Vec<Vec<[u16; 2]>> {
    for vertices in &mut loops {
        let start = (0..vertices.len())
            .filter(|&at| starts_along_x(vertices, at))
            .min_by_key(|&at| {
                let next = vertices[(at + 1) % vertices.len()];
                (vertices[at][1], vertices[at][0], next[0])
            })
            .expect("a loop has a step along x");
        vertices.rotate_left(start);
    }
    loops.sort_by_key(|vertices| (vertices[0][1], vertices[0][0], vertices[1][0]));
    loops
}

fn quarter_turned(glyph: &Glyph, shift_studs: [i32; 2]) -> Glyph {
    let (width, depth) = (glyph.depth, glyph.width);
    let mut coverage = Vec::new();
    let mut color_index = Vec::new();
    for row in 0..depth {
        for column in 0..width {
            let at = (glyph.width - 1 - row) as usize + glyph.width as usize * column as usize;
            coverage.push(glyph.coverage[at]);
            color_index.push(glyph.color_index[at]);
        }
    }
    let wide = glyph.width as i64 * SAMPLES_PER_PIXEL_SIDE;
    let outline = glyph
        .outline
        .iter()
        .map(|vertices| {
            vertices
                .iter()
                .map(|&[u, v]| [v, (wide - i64::from(u)) as u16])
                .collect()
        })
        .collect();
    let shift = shift_studs.map(|studs| studs * PIXELS_PER_STUD as i32);
    Glyph {
        origin: [
            glyph.origin[1] + shift[0],
            -(glyph.origin[0] + glyph.width as i32) + shift[1],
        ],
        width,
        depth,
        colors: glyph.colors.clone(),
        coverage,
        color_index,
        outline: canonical(outline),
    }
}

#[test]
fn a_brick_covers_exactly_its_plan_and_its_outline_is_one_rectangle() {
    let glyphs = Glyphs::new(fixture_library());
    let brick = glyphs.part("3001.dat");
    assert_eq!(brick.origin, [-16, -8]);
    assert_eq!((brick.width, brick.depth), (32, 16));
    assert_eq!(brick.colors, [MAIN_COLOUR]);
    assert!(brick.coverage.iter().all(|&count| count == FULL));
    assert_eq!(brick.outline, [vec![[0, 0], [128, 0], [128, 64], [0, 64]]]);
}

#[test]
fn a_stud_on_the_side_of_a_brick_shows_past_its_body() {
    let glyph = Glyphs::new(fixture_library()).part("87087.dat");
    assert_eq!(glyph.origin, [-4, -4]);
    assert_eq!((glyph.width, glyph.depth), (8, 10));
    assert_eq!(
        glyph.outline,
        [vec![
            [0, 0],
            [32, 0],
            [32, 32],
            [26, 32],
            [26, 38],
            [6, 38],
            [6, 32],
            [0, 32]
        ]]
    );
}

#[test]
fn a_quarter_turn_and_a_whole_stud_move_turn_and_move_the_glyph() {
    let glyphs = Glyphs::new(fixture_library());
    let turned_and_moved = Affine {
        m: [
            0.0, 0.0, 1.0, 60.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -20.0,
        ],
    };
    for part in [
        "3001.dat",
        "3040b.dat",
        "3062b.dat",
        "87087.dat",
        "53401.dat",
        "74746.dat",
        "44336p01.dat",
    ] {
        let glyph = glyphs.part(part);
        let placed = glyphs.placed(part, &turned_and_moved, MAIN_COLOUR);
        assert_eq!(placed, quarter_turned(&glyph, [3, -1]), "{part}");
    }
}

#[test]
fn a_model_glyph_is_its_parts_glyphs_whatever_order_its_lines_come_in() {
    let glyphs = Glyphs::new(fixture_library());
    assert_eq!(
        glyphs.model("1 16 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat\n"),
        glyphs.part("3811.dat")
    );
    let pile = String::from_utf8(repository_file("packages/import/test-data/custom-pile.ldr"))
        .expect("the custom pile is UTF-8");
    let (header, lines): (Vec<&str>, Vec<&str>) =
        pile.lines().partition(|line| !line.starts_with("1 "));
    let reversed: Vec<&str> = header.iter().chain(lines.iter().rev()).copied().collect();
    let glyph = glyphs.model(&pile);
    assert!(glyph.width > 0 && glyph.colors.len() > 1);
    assert_eq!(glyphs.model(&reversed.join("\n")), glyph);
}

#[test]
fn the_highest_opaque_face_colours_a_pixel_and_clear_parts_show_what_lies_beneath() {
    let glyphs = Glyphs::new(fixture_library());
    let glyph = glyphs.model(
        "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat\n\
         1 14 -30 -8 10 1 0 0 0 1 0 0 0 1 3024.dat\n\
         1 47 40 -8 0 1 0 0 0 1 0 0 0 1 3020.dat\n",
    );
    assert_eq!(glyph.origin, [-16, -8]);
    assert_eq!((glyph.width, glyph.depth), (48, 16));
    for row in 0..glyph.depth {
        for column in 0..glyph.width {
            let expected = match (column, row) {
                (0..8, 0..8) => YELLOW,
                (0..32, _) => RED,
                _ => TRANS_CLEAR,
            };
            assert_eq!(
                pixel(&glyph, column, row),
                (FULL, expected),
                "pixel {column}, {row}"
            );
        }
    }
}

fn with_custom_part(name: &str, text: &str) -> MemoryLibrary {
    let MemoryLibrary(mut files) = fixture_library();
    files.insert(name.to_string(), text.to_string());
    MemoryLibrary(files)
}

#[test]
fn a_custom_part_from_the_users_file_shows_its_own_faces_sample_by_sample() {
    let library = with_custom_part(
        "my-slab.dat",
        "0 My slab and wedge\n\
         0 Name: my-slab.dat\n\
         0 Author: Brick Railroad tests\n\
         4 16 0 0 0 50 0 0 50 0 15 0 0 15\n\
         3 16 0 0 20 20 0 20 0 0 40\n",
    );
    let glyph = Glyphs::new(library).part("my-slab.dat");
    let slab_samples = 80 * 24;
    let wedge_samples = (1..=32).sum::<u64>();
    assert_eq!(covered_samples(&glyph), slab_samples + wedge_samples);
    assert_eq!(glyph.origin, [0, -16]);
    assert_eq!((glyph.width, glyph.depth), (20, 16));
    for row in 10..16 {
        for column in 0..20 {
            assert_eq!(pixel(&glyph, column, row), (FULL, MAIN_COLOUR));
        }
    }
    assert_eq!(glyph.outline.len(), 2);
    assert_eq!(glyph.outline[1], [[0, 40], [80, 40], [80, 64], [0, 64]]);
}

#[test]
fn squares_that_touch_only_at_a_corner_keep_separate_outlines() {
    let library = with_custom_part(
        "my-checker.dat",
        "0 My checker\n\
         0 Name: my-checker.dat\n\
         0 Author: Brick Railroad tests\n\
         4 16 0 0 0 20 0 0 20 0 20 0 0 20\n\
         4 16 20 0 20 40 0 20 40 0 40 20 0 40\n",
    );
    let glyph = Glyphs::new(library).part("my-checker.dat");
    assert_eq!(glyph.origin, [0, -16]);
    assert_eq!(
        glyph.outline,
        [
            vec![[32, 0], [64, 0], [64, 32], [32, 32]],
            vec![[0, 32], [32, 32], [32, 64], [0, 64]]
        ]
    );
}

#[test]
fn a_part_whose_faces_are_all_seen_edge_on_from_above_has_an_empty_glyph() {
    let library = with_custom_part(
        "my-fence.dat",
        "0 My fence\n\
         0 Name: my-fence.dat\n\
         0 Author: Brick Railroad tests\n\
         1 16 0 0 0 10 0 0 0 24 0 0 0 10 4-4cyli.dat\n\
         4 16 -30 0 0 30 0 0 30 -24 0 -30 -24 0\n",
    );
    assert_eq!(Glyphs::new(library).part("my-fence.dat"), Glyph::empty());
}
