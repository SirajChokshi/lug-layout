import { exactRational, exactRationalEquals, formatExactDecimal } from "@brr/math";
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
    "0 Custom rail whose rail centres fall between 1/32-LDU scan steps",
    "0 Name: custom-rail.dat",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 16 0 -16 50.015 20 0 0 0 1 0 0 0 3.115 head.dat",
    "1 16 0 -16 -50.015 20 0 0 0 1 0 0 0 3.115 head.dat",
    "4 16 -20 8 -80 20 8 -80 20 8 80 -20 8 80",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "parts", "custom-split-rail.dat"),
  [
    "0 Custom rail whose two heads sit at different measured levels",
    "0 Name: custom-split-rail.dat",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 16 0 -16.5 50 20 0 0 0 1 0 0 0 3 head.dat",
    "1 16 0 -16 -50 20 0 0 0 1 0 0 0 3 head.dat",
    "4 16 -20 8 -80 20 8 -80 20 8 80 -20 8 80",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "parts", "custom-long-rail.dat"),
  [
    "0 Custom rail whose heads are single strips with corners far from its ends",
    "0 Name: custom-long-rail.dat",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 16 0 -16 50 200 0 0 0 1 0 0 0 3 head.dat",
    "1 16 0 -16 -50 200 0 0 0 1 0 0 0 3 head.dat",
    "4 16 -200 8 -80 200 8 -80 200 8 80 -200 8 80",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "p", "head.dat"),
  ["0 Head top", "4 16 -1 0 -1 1 0 -1 1 0 1 -1 0 1"].join("\n"),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function nextFloat64Up(value: number): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
}

describe("rail heads", () => {
  const library = new LdrawLibrary([root]);
  const end = { x: -20, z: 0 };
  const heads = railHeadsAtEnd(flatPolygons(library, "custom-rail"), end, 0);

  it("find the rail centres exactly where the scan line crosses the heads", () => {
    if (heads === null) throw new Error("the custom rail has no rail pair");
    const section = railSection(heads, end, 0, INWARD_LDU);
    if (section === null) throw new Error("the scan line finds no rail pair");
    const [nearCentre, farCentre] = section.railCentresLdu;
    const halfSpacing = exactRational(10003n, 200n);
    expect(exactRationalEquals(nearCentre, exactRational(-10003n, 200n))).toBe(true);
    expect(exactRationalEquals(farCentre, exactRational(10003n, 200n))).toBe(true);
    expect(exactRationalEquals(section.railHalfSpacingLdu, halfSpacing)).toBe(true);
    expect(exactRationalEquals(section.railCentreOffsetLdu, exactRational(0n, 1n))).toBe(true);
  });

  it("decide against the exact head, not its nearest Float64", () => {
    if (heads === null) throw new Error("the custom rail has no rail pair");
    const innerEdgeNearest = 46.9;
    expect(onRailHead(heads, { x: 0, z: innerEdgeNearest })).toBe(false);
    expect(onRailHead(heads, { x: 0, z: nextFloat64Up(innerEdgeNearest) })).toBe(true);
  });

  it("read a rail pair across adjacent measured levels when no single level holds both heads", () => {
    const split = railHeadsAtEnd(flatPolygons(library, "custom-split-rail"), end, 0);
    if (split === null) throw new Error("the split rail has no rail pair");
    expect(formatExactDecimal(split.topY)).toBe("-16.5");
    const section = railSection(split, end, 0, INWARD_LDU);
    if (section === null) throw new Error("the scan line finds no rail pair");
    expect(exactRationalEquals(section.railHalfSpacingLdu, exactRational(50n, 1n))).toBe(true);
  });

  it("read the levels the scan line crosses, however far their corners are from the end", () => {
    const long = railHeadsAtEnd(flatPolygons(library, "custom-long-rail"), end, 0);
    if (long === null) throw new Error("the long rail has no rail pair");
    expect(formatExactDecimal(long.topY)).toBe("-16");
    const section = railSection(long, end, 0, INWARD_LDU);
    if (section === null) throw new Error("the scan line finds no rail pair");
    expect(exactRationalEquals(section.railHalfSpacingLdu, exactRational(50n, 1n))).toBe(true);
  });
});
