use std::fs;
use std::path::Path;

use brick_compile::connect::{FaceSection, Mate, SnapShape};
use serde_json::Value;

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-fixtures/snap-mating-vectors.json");
    serde_json::from_str(&fs::read_to_string(path).expect("the shared vectors exist"))
        .expect("the shared vectors are JSON")
}

fn number(value: &Value) -> f64 {
    value.as_f64().expect("a number")
}

fn shape(value: &Value) -> SnapShape {
    let sections: Vec<FaceSection> = value["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .map(|section| FaceSection {
            code: u8::try_from(section[0].as_u64().expect("a section code")).expect("a byte"),
            size: number(&section[1]),
            length: number(&section[2]),
        })
        .collect();
    SnapShape::new(
        u8::try_from(value["caps"].as_u64().expect("caps")).expect("a byte"),
        value["slide"].as_bool().expect("slide"),
        value["group"].as_str(),
        &sections,
    )
    .expect("the vector's shape reads")
}

fn ranges(value: &Value) -> Vec<[i32; 2]> {
    value
        .as_array()
        .expect("engaged ranges")
        .iter()
        .map(|range| {
            [0, 1].map(|end| {
                i32::try_from(range[end].as_i64().expect("an offset")).expect("in range")
            })
        })
        .collect()
}

#[test]
fn the_bake_engages_every_shared_pair_over_exactly_the_offsets_e6_engages_it() {
    let vectors = vectors();
    let pairs = vectors["pairs"].as_array().expect("pairs");
    for pair in pairs {
        let (male, female) = (shape(&pair["male"]), shape(&pair["female"]));
        assert_eq!(
            Mate::new(&male, &female).offsets().ranges(),
            ranges(&pair["engaged"]).as_slice(),
            "{}",
            pair["name"]
        );
    }
}
