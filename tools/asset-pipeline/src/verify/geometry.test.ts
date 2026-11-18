import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { measureRails } from "./geometry.ts";

const SECTION_X = 20;
const root = mkdtempSync(join(tmpdir(), "rail-measure-"));
mkdirSync(join(root, "parts", "s"), { recursive: true });
mkdirSync(join(root, "p"), { recursive: true });
writeFileSync(
  join(root, "parts", "custom-rail.dat"),
  [
    "0 Custom rail with heads scaled by decimal literals",
    "0 Name: custom-rail.dat",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 16 0 -16 50 20 0 0 0 1 0 0 0 3.1 head.dat",
    "1 16 0 -16 -50 20 0 0 0 1 0 0 0 31 s\\head-tenth.dat",
    "4 16 -20 8 -80 20 8 -80 20 8 80 -20 8 80",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "parts", "s", "head-tenth.dat"),
  ["0 ~Rail head at a tenth", "1 16 0 0 0 1 0 0 0 1 0 0 0 0.1 head.dat"].join("\n"),
);
writeFileSync(
  join(root, "p", "head.dat"),
  [
    "0 Head top and side",
    "4 16 -1 0 -1 1 0 -1 1 0 1 -1 0 1",
    "4 16 -1 0 1 1 0 1 1 1 1 -1 1 1",
  ].join("\n"),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("measureRails", () => {
  it("composes rail heads exactly from the decimal literals of a custom part", () => {
    expect(53.1 - 46.9).toBe(6.200000000000003);
    expect(measureRails(new LdrawLibrary([root]), "custom-rail", SECTION_X)).toEqual({
      part: "custom-rail",
      sectionX: SECTION_X,
      railTopY: "-16",
      railHeads: [
        { from: "-53.1", to: "-46.9" },
        { from: "46.9", to: "53.1" },
      ],
      railCentreSpacingLdu: "100",
      innerGaugeLdu: "93.8",
      innerGaugeMm: "37.52",
      railHeadWidthLdu: "6.2",
      trackWidthLdu: "160",
      railTopAboveUndersideLdu: "24",
    });
  });
});
