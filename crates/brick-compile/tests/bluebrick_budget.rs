use std::path::Path;

use brick_compile::bluebrick::{read_bbb, read_bbm, BlueBrickBudget, BlueBrickError, BudgetedPart};

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-fixtures/bluebrick")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn budgeted(id: &str, count: u32) -> BudgetedPart {
    BudgetedPart {
        id: id.to_string(),
        count,
    }
}

fn budget_of(parts: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<Budget>\r\n  <Version>1</Version>\r\n  {parts}\r\n</Budget>")
}

#[test]
fn a_budget_saved_by_bluebrick_reads_every_part_and_count_as_written() {
    assert_eq!(
        read_bbb(&fixture("budget.bbb")),
        Ok(BlueBrickBudget {
            version: 1,
            parts: vec![
                budgeted("2865.8", 12),
                budgeted("3811.1", 0),
                budgeted("TS_OLDNAME_TEST", 3),
            ],
        })
    );
    assert_eq!(
        read_bbb(budget_of("<PartList />").as_bytes()),
        Ok(BlueBrickBudget {
            version: 1,
            parts: vec![],
        })
    );
}

#[test]
fn files_that_are_not_readable_budgets_are_rejected_with_the_reason() {
    let cases: [(String, &str); 9] = [
        ("<Budget><Version>1</Version>".to_string(), "notXml"),
        (
            String::from_utf8(fixture("synthetic-yard.bbm")).expect("UTF-8"),
            "notBudget",
        ),
        ("<Budget><PartList /></Budget>".to_string(), "notBudget"),
        (
            budget_of("<PartList />").replace("<Version>1</Version>", "<Version>2</Version>"),
            "newerVersion",
        ),
        (budget_of(""), "malformed"),
        (
            budget_of("<PartList><Part>4</Part></PartList>"),
            "malformed",
        ),
        (
            budget_of("<PartList><Part id=\"3811.2\">-1</Part></PartList>"),
            "malformed",
        ),
        (
            budget_of("<PartList><Part id=\"3811.2\">4.5</Part></PartList>"),
            "malformed",
        ),
        (
            budget_of(
                "<PartList><Part id=\"3811.2\">1</Part><Part id=\"3811.2\">2</Part></PartList>",
            ),
            "malformed",
        ),
    ];
    for (source, expected) in cases {
        let error = read_bbb(source.as_bytes()).expect_err(&source);
        assert_eq!(error.kind(), expected, "{source}: {error}");
    }
    assert_eq!(
        read_bbb(
            budget_of("<PartList />")
                .replace("<Version>1</Version>", "<Version>2</Version>")
                .as_bytes()
        )
        .expect_err("version 2")
        .to_string(),
        "this budget was saved by a newer BlueBrick (data version 2); this reader knows versions up to 1"
    );
    assert_eq!(
        read_bbb(
            budget_of(
                "<PartList><Part id=\"3811.2\">1</Part><Part id=\"3811.2\">2</Part></PartList>"
            )
            .as_bytes()
        ),
        Err(BlueBrickError::Malformed {
            path: "Budget/PartList/Part[2]".to_string(),
            problem: "repeats the part id \"3811.2\"".to_string(),
        })
    );
    assert_eq!(
        read_bbm(&fixture("budget.bbb"))
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Err("not a BlueBrick map: its root element is <Budget>, not <Map>".to_string())
    );
}
