import { describe, expect, it } from "vitest";
import type { StudioArchive } from "@brr/schema/bundle";
import { BricklinkPartsCrosswalk, mapStudioParts, type LdrawPartExists } from "./studio-mapping.ts";

const crosswalk = new BricklinkPartsCrosswalk({
  "4162pb028a": ["ldraw:4162d02"],
  "4070pb04L": ["ldraw:4070d01"],
  "92338": ["ldraw:92338-f1", "ldraw:92338-f2"],
  "3001": ["ldraw:3556", "ldraw:72841"],
  "60219": ["ldraw:60219b"],
  "7302": ["ldraw:7302a"],
  "7674": ["ldraw:7674"],
});

const officialParts = new Set(["3001.dat", "60219.dat", "4162d02.dat", "4070d01.dat", "7674.dat"]);
const exists: LdrawPartExists = { isLdrawPart: async (reference) => officialParts.has(reference) };

const MATRIX = "0 0 0 1 0 0 0 1 0 0 0 1";

function archive(lines: ReadonlyArray<string>): StudioArchive {
  return {
    status: "read",
    entry: "modelv2.ldr",
    ldraw: lines.join("\n"),
    studioVersion: "2.24.4_4",
    convertedLines: lines.length,
    unconvertedLines: [],
    bricklinkIds: { "92338c01.dat": "92338", "7674.dat": "7674" },
    customParts: ["legleftredbrown.dat"],
    customFiles: [],
  };
}

describe("mapStudioParts", () => {
  it("rewrites a reference only when Studio's name is not an LDraw part and its BrickLink id names exactly one", async () => {
    const mapping = await mapStudioParts(
      archive([
        "0 FILE wing",
        `1 15 ${MATRIX} 4162pb028a.dat`,
        `1 14 ${MATRIX} 4070pb04l.dat`,
        `1 4 ${MATRIX} 7302.dat`,
        `1 4 ${MATRIX} bl_7674.dat`,
        `1 4 ${MATRIX} 92338c01.dat`,
        `1 4 ${MATRIX} 3001.dat`,
        `1 4 ${MATRIX} 60219.dat`,
        `1 100241 ${MATRIX} legleftredbrown.dat`,
        `1 16 ${MATRIX} 4079b.dat`,
        `1 16 ${MATRIX} wing`,
      ]),
      crosswalk,
      exists,
      new Set([4, 14, 15, 16]),
    );
    expect(mapping.ldraw.split("\n").slice(1, 5)).toEqual([
      `1 15 ${MATRIX} 4162d02.dat`,
      `1 14 ${MATRIX} 4070d01.dat`,
      `1 4 ${MATRIX} 7302.dat`,
      `1 4 ${MATRIX} 7674.dat`,
    ]);
    expect(mapping.ldraw.split("\n").slice(5)).toEqual([
      `1 4 ${MATRIX} 92338c01.dat`,
      `1 4 ${MATRIX} 3001.dat`,
      `1 4 ${MATRIX} 60219.dat`,
      `1 100241 ${MATRIX} legleftredbrown.dat`,
      `1 16 ${MATRIX} 4079b.dat`,
      `1 16 ${MATRIX} wing`,
    ]);
    expect(Object.fromEntries(mapping.parts.map((p) => [p.studio, p.outcome]))).toEqual({
      "3001.dat": { kind: "kept" },
      "4079b.dat": { kind: "kept" },
      "4070pb04l.dat": { kind: "bricklinkCrosswalk", ldraw: "4070d01" },
      "4162pb028a.dat": { kind: "bricklinkCrosswalk", ldraw: "4162d02" },
      "7302.dat": { kind: "crosswalkTargetMissing", ldraw: "7302a" },
      "60219.dat": { kind: "kept" },
      "92338c01.dat": { kind: "ambiguous", candidates: ["92338-f1", "92338-f2"] },
      "bl_7674.dat": { kind: "bricklinkCrosswalk", ldraw: "7674" },
      "legleftredbrown.dat": { kind: "custom" },
    });
    expect(
      Object.fromEntries(
        mapping.parts.map((p) => [p.studio, `${p.bricklinkId} ${p.bricklinkIdSource}`]),
      ),
    ).toMatchObject({
      "bl_7674.dat": "7674 studioMetadata",
      "92338c01.dat": "92338 studioMetadata",
      "4079b.dat": "4079b fileName",
    });
    expect(mapping.unknownColors).toEqual([{ code: 100241, instances: 1 }]);
  });
});

describe("a sole BrickLink candidate", () => {
  it("is reported missing, never renamed, when it is absent from the pin, whether or not it equals Studio's name", async () => {
    const soleCandidates = new BricklinkPartsCrosswalk({
      "3005": ["ldraw:3005"],
      "6141": ["ldraw:4073"],
      "3004": ["ldraw:3004"],
    });
    const pinned: LdrawPartExists = { isLdrawPart: async (reference) => reference === "3004.dat" };
    const lines = [`1 4 ${MATRIX} 3005.dat`, `1 4 ${MATRIX} 6141.dat`, `1 4 ${MATRIX} 3004.dat`];
    const mapping = await mapStudioParts(archive(lines), soleCandidates, pinned, new Set([4]));
    expect(mapping.ldraw).toBe(lines.join("\n"));
    expect(Object.fromEntries(mapping.parts.map((p) => [p.studio, p.outcome]))).toEqual({
      "3004.dat": { kind: "kept" },
      "3005.dat": { kind: "crosswalkTargetMissing", ldraw: "3005" },
      "6141.dat": { kind: "crosswalkTargetMissing", ldraw: "4073" },
    });
  });
});
