import { exactRational, exactRationalEquals } from "@brr/math";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { flatPolygons, onRailHead, railHeadsAtEnd, railSection } from "./rail-heads.ts";

const INWARD_LDU = 20;
const root = mkdtempSync(join(tmpdir(), "rail-heads-"));
mkdirSync(join(root, "parts"), { recursive: true });
mkdirSync(join(root, "p"), { recursive: true });
writeFileSync(
  join(root, "parts", "custom-rail.dat"),
  [
    "0 Custom rail with heads scaled by decimal literals",
    "0 Name: custom-rail.dat",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 16 0 -16 50 20 0 0 0 1 0 0 0 3.1 head.dat",
    "1 16 0 -16 -50 20 0 0 0 1 0 0 0 3.1 head.dat",
    "4 16 -20 8 -80 20 8 -80 20 8 80 -20 8 80",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "p", "head.dat"),
  ["0 Head top", "4 16 -1 0 -1 1 0 -1 1 0 1 -1 0 1"].join("\n"),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rail heads", () => {
  const library = new LdrawLibrary([root]);
  const end = { x: -20, z: 0 };
  const heads = railHeadsAtEnd(flatPolygons(library, "custom-rail"), end, 0);

  it("find the rail centres exactly where the scan line crosses the heads", () => {
    if (heads === null) throw new Error("the custom rail has no rail pair");
    const section = railSection(heads, end, 0, INWARD_LDU);
    if (section === null) throw new Error("the scan line finds no rail pair");
    expect(exactRationalEquals(section.halfSpacingLdu, exactRational(50n, 1n))).toBe(true);
    expect(exactRationalEquals(section.centreOffsetLdu, exactRational(0n, 1n))).toBe(true);
  });

  it("decide against the exact head, not its nearest Float64", () => {
    if (heads === null) throw new Error("the custom rail has no rail pair");
    const nearestBelowTheEdge = 46.9;
    const nextDoubleUp = 46.900000000000006;
    expect(onRailHead(heads, { x: 0, z: nearestBelowTheEdge })).toBe(false);
    expect(onRailHead(heads, { x: 0, z: nextDoubleUp })).toBe(true);
  });
});
