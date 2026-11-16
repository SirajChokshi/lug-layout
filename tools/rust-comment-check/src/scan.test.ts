import { describe, expect, it } from "vitest";
import { findRustComments } from "./scan.ts";

describe("findRustComments", () => {
  it.each([
    ["line comment", "let x = 1; // note\n", [{ line: 1, column: 12 }]],
    ["doc comment", "/// docs\nfn f() {}\n", [{ line: 1, column: 1 }]],
    ["inner doc comment", "//! crate docs\n", [{ line: 1, column: 1 }]],
    ["nested block comment", "/* a /* b */ c */ fn f() {}\n", [{ line: 1, column: 1 }]],
    ["comment after a lifetime", "fn f<'a>(x: &'a str) {} // c\n", [{ line: 1, column: 25 }]],
  ])("reports a %s", (_, source, expected) => {
    expect(findRustComments(source)).toEqual(expected);
  });

  it.each([
    ["a URL in a string", 'let u = "https://example.com";\n'],
    ["comment markers in a raw string", 'let s = r#"/* not "a" comment */"#;\n'],
    ["an escaped quote before slashes", 'let s = "\\" // still a string";\n'],
    ["a quote char literal", 'let q = \'"\'; let s = "//";\n'],
    ["division", "let half = a / 2 / b;\n"],
  ])("ignores %s", (_, source) => {
    expect(findRustComments(source)).toEqual([]);
  });
});
