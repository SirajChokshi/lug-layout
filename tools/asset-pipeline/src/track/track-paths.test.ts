import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseExactDecimal } from "@brr/math";
import type { ExactVec3 } from "../ldraw/exact-walk.ts";
import { LdrawLibrary } from "../ldraw/library.ts";
import { flatPolygons, railHeadsAtEnd } from "./rail-heads.ts";
import { fitRoutePath } from "./track-paths.ts";

const root = mkdtempSync(join(tmpdir(), "track-paths-"));
mkdirSync(join(root, "parts"), { recursive: true });
mkdirSync(join(root, "p"), { recursive: true });

function writeRail(name: string, nearHeadCentreX: number, nearHeadHalfLength: number): void {
  writeFileSync(
    join(root, "parts", `${name}.dat`),
    [
      `0 Custom rail whose near head stops short of the far end`,
      `0 Name: ${name}.dat`,
      "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
      `1 16 ${nearHeadCentreX} -16 -50 ${nearHeadHalfLength} 0 0 0 1 0 0 0 3 head.dat`,
      "1 16 4 -16 50 5 0 0 0 1 0 0 0 3 head.dat",
    ].join("\r\n"),
  );
}

writeRail("custom-rail-four-fifths", 3, 4);
writeRail("custom-rail-three-fifths", 2, 3);
writeFileSync(
  join(root, "p", "head.dat"),
  ["0 Head top", "4 16 -1 0 -1 1 0 -1 1 0 1 -1 0 1"].join("\n"),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("route fitting", () => {
  const library = new LdrawLibrary([root]);
  const start = { x: 0, z: 0, heading: 0 };
  const finish = { x: 8, z: 0, heading: 0 };
  const halfSpacing = 50;
  const endSleeper = [
    ["-30", "-8", "-80"],
    ["-10", "-8", "-80"],
    ["-10", "-8", "80"],
    ["-30", "-8", "80"],
  ].map(([x = "", y = "", z = ""]): ExactVec3 => [
    parseExactDecimal(x),
    parseExactDecimal(y),
    parseExactDecimal(z),
  ]);

  function fit(part: string) {
    const heads = railHeadsAtEnd(flatPolygons(library, part), {
      origin: { x: -20, z: 0 },
      along: 0,
      endSleeper,
    });
    if (heads === null) throw new Error(`${part} has no rail pair`);
    return fitRoutePath(heads, (point) => point, start, finish, halfSpacing, part);
  }

  it("keep a family whose worse rail is on rail heads for exactly four of five samples", () => {
    const path = fit("custom-rail-four-fifths");
    expect(path.family).toBe("straight");
    expect(path.railCoverage).toEqual([
      { numerator: "4", denominator: "5" },
      { numerator: "1", denominator: "1" },
    ]);
  });

  it("refuse a family whose worse rail is on rail heads for three of five samples", () => {
    expect(() => fit("custom-rail-three-fifths")).toThrow(
      "custom-rail-three-fifths: no path family keeps both rails on rail heads (straight 0.600)",
    );
  });
});
