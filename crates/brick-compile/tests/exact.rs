use std::fs;
use std::path::Path;

use brick_compile::exact::{covers_circle, Bearing, Decimal, Direction, Exact};
use serde_json::Value;

fn exact(text: &str) -> Exact {
    Decimal::parse(text)
        .unwrap_or_else(|| panic!("{text} parses"))
        .exact()
}

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-fixtures/exact-decimal-vectors.json");
    serde_json::from_str(&fs::read_to_string(path).expect("the shared vectors exist"))
        .expect("the shared vectors are JSON")
}

fn cases<'v>(vectors: &'v Value, name: &str) -> &'v Vec<Value> {
    vectors[name].as_array().expect("a case list")
}

fn text<'v>(case: &'v Value, field: &str) -> &'v str {
    case[field].as_str().expect("a decimal text")
}

#[test]
fn decimals_parse_compare_and_compute_as_the_shared_vectors_say() {
    let vectors = vectors();
    for case in cases(&vectors, "parse") {
        assert_eq!(
            exact(text(case, "text")).canonical(),
            text(case, "canonical")
        );
    }
    for case in cases(&vectors, "compare") {
        let expected = case["order"].as_i64().expect("an order").cmp(&0);
        assert_eq!(
            exact(text(case, "a")).compare(&exact(text(case, "b"))),
            expected
        );
    }
    for case in cases(&vectors, "arithmetic") {
        let (a, b) = (exact(text(case, "a")), exact(text(case, "b")));
        assert_eq!(a.add(&b).canonical(), text(case, "sum"));
        assert_eq!(a.sub(&b).canonical(), text(case, "difference"));
        assert_eq!(a.mul(&b).canonical(), text(case, "product"));
    }
}

fn point(x: &str, y: &str) -> Direction {
    [exact(x), exact(y)]
}

fn circle_with_seam_at_half_turn(seam: (&str, &str)) -> bool {
    let upper = (
        Bearing::identify(point("6", "0"), 1.0),
        Bearing::identify(point("-6", "0"), 1.0),
    );
    let lower = (
        Bearing::identify(point(seam.0, seam.1), 1.0),
        Bearing::identify(point("6", "0"), 1.0),
    );
    covers_circle(&[upper, lower])
}

#[test]
fn an_arc_end_within_identification_of_a_turn_abuts_and_a_real_gap_stays_open() {
    assert!(circle_with_seam_at_half_turn(("-6", "0")));
    assert!(circle_with_seam_at_half_turn(("-5.999999997", "-0.0002")));
    assert!(!circle_with_seam_at_half_turn(("-5.99999992", "-0.001")));
}
