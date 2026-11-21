mod common;

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use brick_compile::compile::{stud_primitives_from_table, CompiledPart};
use brick_compile::identify::sixteenths;
use brick_compile::top_surface::{TopCell, TopSurface};
use brick_compile::{compile_part, CompileOptions, Library};
use common::{fixture_library, restored_library, MemoryLibrary};

fn repository_json(path: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path);
    serde_json::from_slice(&fs::read(&path).expect("the repository file is readable"))
        .expect("the repository file is JSON")
}

fn compiled<L: Library>(library: &L, part: &str) -> CompiledPart {
    let table = repository_json("tools/asset-pipeline/primitive-connectors.json");
    let options = CompileOptions {
        stud_primitives: stud_primitives_from_table(&table).expect("the table lists studs"),
        ..CompileOptions::default()
    };
    compile_part(library, part, &options).expect("the part compiles")
}

fn surface_of(part: &CompiledPart) -> &TopSurface {
    part.top_surface
        .as_ref()
        .expect("the part has a whole-stud plan")
}

fn studded_at_top(part: &CompiledPart) -> Vec<bool> {
    let surface = surface_of(part);
    let mut studded = vec![false; surface.cells.len()];
    let cell_size = 20 * 16;
    for stud in &part.studs {
        let m = stud.matrix.m;
        let upright = m[1] == 0.0 && m[9] == 0.0 && m[5] > 0.0;
        let (Some(x), Some(base), Some(z)) =
            (sixteenths(m[3]), sixteenths(m[7]), sixteenths(m[11]))
        else {
            continue;
        };
        let dx = x - surface.origin[0] - cell_size / 2;
        let dz = z - surface.origin[1] - cell_size / 2;
        if !upright || base != surface.top || dx % cell_size != 0 || dz % cell_size != 0 {
            continue;
        }
        let column = usize::try_from(dx / cell_size).expect("the stud is on the part");
        let row = usize::try_from(dz / cell_size).expect("the stud is on the part");
        studded[row * surface.columns + column] = true;
    }
    studded
}

fn road_cells(part: &CompiledPart) -> Vec<bool> {
    let studded = studded_at_top(part);
    surface_of(part)
        .cells
        .iter()
        .zip(studded)
        .map(|(cell, studded)| match cell {
            TopCell::Flat => !studded,
            TopCell::Pocket => true,
            TopCell::Open | TopCell::Undecided => false,
        })
        .collect()
}

fn measured_map<'a>(
    facts: &'a serde_json::Value,
    key: &str,
    part: &str,
    map: &str,
) -> Vec<&'a str> {
    facts[key]
        .as_array()
        .expect("the facts list the parts")
        .iter()
        .find(|entry| entry["part"] == part)
        .unwrap_or_else(|| panic!("{part} is measured under {key}"))[map]
        .as_array()
        .expect("the entry has a map")
        .iter()
        .map(|row| row.as_str().expect("map rows are text"))
        .collect()
}

fn in_ldraw_rows(surface: &TopSurface, cells: &[bool]) -> Vec<String> {
    (0..surface.rows)
        .rev()
        .map(|row| {
            (0..surface.columns)
                .map(|column| {
                    if cells[row * surface.columns + column] {
                        'r'
                    } else {
                        '-'
                    }
                })
                .collect()
        })
        .collect()
}

fn mapped(map: &[&str], is: char) -> Vec<String> {
    map.iter()
        .map(|row| {
            row.chars()
                .map(|c| if c == is { 'r' } else { '-' })
                .collect()
        })
        .collect()
}

#[test]
fn the_baked_road_cells_of_each_classic_road_baseplate_are_its_measured_studless_cells() {
    let facts = repository_json("docs/verified-facts/geometry.json");
    let audit = restored_library("ldraw-audit");
    for part in [
        "44336", "44341", "44342", "44343", "2358", "610", "606", "30225b",
    ] {
        let baked = compiled(&audit, &format!("{part}.dat"));
        let road = in_ldraw_rows(surface_of(&baked), &road_cells(&baked));
        let measured = mapped(&measured_map(&facts, "roadStudZones", part, "map"), '.');
        assert_eq!(road, measured, "{part}");
    }
}

#[test]
fn the_baked_pockets_of_each_recessed_road_plate_are_its_measured_recessed_studs() {
    let facts = repository_json("docs/verified-facts/geometry.json");
    let audit = restored_library("ldraw-audit");
    for part in ["69958", "71772", "71772p01"] {
        let baked = compiled(&audit, &format!("{part}.dat"));
        let surface = surface_of(&baked);
        let pockets: Vec<bool> = surface
            .cells
            .iter()
            .map(|c| *c == TopCell::Pocket)
            .collect();
        let flat: Vec<bool> = surface.cells.iter().map(|c| *c == TopCell::Flat).collect();
        let studs = measured_map(&facts, "recessedRoadPlates", part, "studMap");
        assert_eq!(
            in_ldraw_rows(surface, &pockets),
            mapped(&studs, 'o'),
            "{part}"
        );
        assert_eq!(in_ldraw_rows(surface, &flat), mapped(&studs, '.'), "{part}");
    }
}

fn pinned_library() -> MemoryLibrary {
    let MemoryLibrary(mut files) = fixture_library();
    files.extend(restored_library("ldraw-audit").0);
    MemoryLibrary(files)
}

#[test]
fn a_printed_road_baseplate_has_the_same_top_surface_as_the_plain_one() {
    let library = pinned_library();
    let printed_variants: [(&str, &[&str]); 11] = [
        ("44336", &["44336p01", "44336p02", "44336p03", "44336p04"]),
        ("44341", &["44341p01", "44341p02"]),
        ("44342", &["44342p01", "44342p02"]),
        ("44343", &["44343p01", "44343p02", "44343p03"]),
        ("2358", &["2358p02"]),
        ("2359", &["2359p02", "2359p03"]),
        ("51595", &["51595p01", "51595p02", "51595p03"]),
        ("608", &["608p02"]),
        ("611", &["611p01"]),
        ("612", &["612p01"]),
        ("613", &["613p01"]),
    ];
    for (plain, printed) in printed_variants {
        let plain_surface = compiled(&library, &format!("{plain}.dat")).top_surface;
        for printed in printed {
            assert_eq!(
                compiled(&library, &format!("{printed}.dat")).top_surface,
                plain_surface,
                "{printed}"
            );
        }
    }
}

#[test]
fn a_slope_is_flat_only_on_its_studded_top() {
    let slope = compiled(&fixture_library(), "3040b.dat");
    assert_eq!(surface_of(&slope).rows_text(), ["f", "."]);
    assert_eq!(road_cells(&slope), [false, false]);
}

#[test]
fn studs_on_a_lower_step_behind_a_curve_or_under_a_slope_are_no_pockets() {
    let library = fixture_library();
    for part in [
        "6081.dat",
        "6091.dat",
        "99206.dat",
        "30274.dat",
        "3660a.dat",
        "3665a.dat",
        "4287a.dat",
    ] {
        let baked = compiled(&library, part);
        assert!(
            !surface_of(&baked).cells.contains(&TopCell::Pocket),
            "{part}: {:?}",
            surface_of(&baked).rows_text()
        );
    }
}

#[test]
fn a_plate_whose_clip_reaches_past_its_studs_has_no_whole_stud_plan() {
    assert_eq!(compiled(&fixture_library(), "63868.dat").top_surface, None);
}

fn custom_library(parts: &[(&str, &str)]) -> MemoryLibrary {
    let MemoryLibrary(mut files) = fixture_library();
    let custom: HashMap<String, String> = parts
        .iter()
        .map(|(name, source)| (format!("parts/{name}"), (*source).to_string()))
        .collect();
    files.extend(custom);
    MemoryLibrary(files)
}

const HEADER: &str = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n";

#[test]
fn custom_parts_from_official_primitives_read_flat_tops_pockets_and_round_tops() {
    let tile = format!("0 Custom tile 2 x 2\n{HEADER}1 16 0 0 0 20 0 0 0 -8 0 0 0 20 box5.dat\n");
    let ring = "1 16 0 -16 -20 30 0 0 0 1 0 0 0 10 rect.dat\n\
                1 16 0 -16 20 30 0 0 0 1 0 0 0 10 rect.dat\n\
                1 16 -20 -16 0 10 0 0 0 1 0 0 0 10 rect.dat\n";
    let well = "1 16 0 -8 0 10 0 0 0 1 0 0 0 10 rect.dat\n\
                1 16 0 -8 0 1 0 0 0 1 0 0 0 1 stud.dat\n\
                1 16 0 0 0 30 0 0 0 -8 0 0 0 30 box5.dat\n";
    let walled = format!(
        "0 Custom plate with a recessed stud\n{HEADER}{ring}{well}1 16 20 -16 0 10 0 0 0 1 0 0 0 10 rect.dat\n"
    );
    let ramped = format!(
        "0 Custom plate with a ramp beside a stud\n{HEADER}{ring}{well}4 16 10 -8 -10 30 -16 -10 30 -16 10 10 -8 10\n"
    );
    let round = format!(
        "0 Custom round tile 2 x 2\n{HEADER}1 16 0 -8 0 20 0 0 0 1 0 0 0 20 4-4disc.dat\n\
         1 16 0 -8 0 20 0 0 0 8 0 0 0 20 4-4cyli.dat\n"
    );
    let library = custom_library(&[
        ("custom-tile.dat", &tile),
        ("custom-walled.dat", &walled),
        ("custom-ramped.dat", &ramped),
        ("custom-round.dat", &round),
    ]);
    let rows = |part: &str| surface_of(&compiled(&library, part)).rows_text();
    assert_eq!(rows("custom-tile.dat"), ["ff", "ff"]);
    assert_eq!(rows("custom-walled.dat"), ["fff", "fpf", "fff"]);
    assert_eq!(rows("custom-ramped.dat"), ["fff", "f..", "fff"]);
    assert_eq!(rows("custom-round.dat"), ["..", ".."]);
}

#[test]
fn a_custom_print_whose_rings_are_rounded_apart_reads_as_flat_as_the_plain_plate() {
    let body = "1 16 30 0 30 30 0 0 0 8 0 0 0 30 box5.dat\n";
    let plain =
        format!("0 Custom plate 3 x 3\n{HEADER}{body}1 16 30 0 30 30 0 0 0 1 0 0 0 30 rect.dat\n");
    let printed = format!(
        "0 Custom plate 3 x 3 with a printed ring\n{HEADER}{body}\
         1 16 0 0 0 56 0 0 0 1 0 0 0 56 48\\1-4disc.dat\n\
         1 15 0 0 0 4 0 0 0 1 0 0 0 4 48\\1-4ring14.dat\n\
         1 16 0 0 0 60 0 0 0 1 0 0 0 60 48\\1-4ndis.dat\n"
    );
    let library = custom_library(&[
        ("custom-plate.dat", &plain),
        ("custom-printed-plate.dat", &printed),
    ]);
    let rows = |part: &str| surface_of(&compiled(&library, part)).rows_text();
    assert_eq!(rows("custom-plate.dat"), ["fff"; 3]);
    assert_eq!(rows("custom-printed-plate.dat"), rows("custom-plate.dat"));
}
