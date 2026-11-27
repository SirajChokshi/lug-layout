use std::collections::HashMap;

use brick_compile::{compile_part, CompileOptions, Library};
use serde_json::{json, Value};

struct MemoryLibrary(HashMap<String, String>);

impl Library for MemoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }
}

const CA: &str = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";

fn library(files: &[(&str, &str)]) -> MemoryLibrary {
    MemoryLibrary(
        files
            .iter()
            .map(|(path, body)| (path.to_string(), format!("0 {path}\n{CA}\n{body}\n")))
            .collect(),
    )
}

fn extents_of(library: &MemoryLibrary, options: &CompileOptions) -> Value {
    let compiled = compile_part(library, "part.dat", options).expect("compiles");
    compiled.extras()["extents"].clone()
}

fn rational(numerator: &str, denominator: &str) -> Value {
    json!({ "numerator": numerator, "denominator": denominator })
}

#[test]
fn extents_follow_decimal_subfile_transforms_exactly_in_the_y_up_frame() {
    let library = library(&[
        ("parts/s/leaf.dat", "3 16 1 0 0 0 2.5 0 0 0 -3"),
        (
            "parts/s/mid.dat",
            "1 16 0.1 0 0 0.1 0 0 0 0.3 0 0 0 1 s\\leaf.dat",
        ),
        (
            "parts/part.dat",
            "1 16 0 -0.7 0 1 0 0 0 1 0 0 0 1 s\\mid.dat\n1 16 5 0 0 0.6 0 -0.8 0 1 0 0.8 0 0.6 s\\leaf.dat",
        ),
    ]);
    assert_eq!(
        extents_of(&library, &CompileOptions::default()),
        json!({
            "min": [rational("1", "10"), rational("-5", "2"), rational("-4", "5")],
            "max": [rational("37", "5"), rational("7", "10"), rational("3", "1")],
        })
    );
}

#[test]
fn extents_pick_the_exact_extreme_where_doubles_order_two_vertices_the_other_way() {
    let library = library(&[
        ("parts/s/tip.dat", "3 16 0.2 0 0 0 0.5 0 0 0 0.5"),
        ("parts/s/far.dat", "3 16 -0.2 0 0 0 0.5 0 0 0 0.5"),
        (
            "parts/part.dat",
            "3 16 0.30000000000000001 0 0 0 1 0 0 0 1\n\
             3 16 -0.30000000000000001 0 0 0 1 0 0 0 1\n\
             1 16 0.1 0 0 1 0 0 0 1 0 0 0 1 s\\tip.dat\n\
             1 16 -0.1 0 0 1 0 0 0 1 0 0 0 1 s\\far.dat",
        ),
    ]);
    let extents = extents_of(&library, &CompileOptions::default());
    assert_eq!(
        extents["max"][0],
        rational("30000000000000001", "100000000000000000")
    );
    assert_eq!(
        extents["min"][0],
        rational("-30000000000000001", "100000000000000000")
    );
}

#[test]
fn extents_count_stud_primitives_that_rendering_extracts() {
    let library = library(&[
        ("p/stud.dat", "4 16 6 -4 6 -6 -4 6 -6 -4 -6 6 -4 -6"),
        (
            "parts/part.dat",
            "4 16 10 0 10 -10 0 10 -10 8 10 10 8 10\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat",
        ),
    ]);
    let options = CompileOptions {
        stud_primitives: vec!["stud.dat".into()],
        ..CompileOptions::default()
    };
    let extents = extents_of(&library, &options);
    assert_eq!(extents["max"][1], rational("4", "1"));
    assert_eq!(extents["min"][1], rational("-8", "1"));
}

#[test]
fn a_part_with_no_geometry_has_no_extents() {
    let library = library(&[("parts/part.dat", "0 nothing drawn")]);
    assert_eq!(
        extents_of(&library, &CompileOptions::default()),
        Value::Null
    );
}
