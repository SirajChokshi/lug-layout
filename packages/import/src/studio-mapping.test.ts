import { describe, expect, it } from "vitest";
import type { StudioArchive } from "./brick-compiler.ts";
import { mapStudioParts, type BricklinkToLdraw, type LdrawPartExists } from "./studio-mapping.ts";

const crosswalk: BricklinkToLdraw = {
  ldrawCandidates: (id) =>
    ({
      "4162pb028a": ["4162d02"],
      "92338": ["92338-f1", "92338-f2"],
      "3001": ["3001", "3001old"],
      "60219": ["60219b"],
    })[id] ?? [],
};

const officialParts = new Set(["3001.dat", "60219.dat", "4162d02.dat"]);
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
    bricklinkIds: { "92338c01.dat": "92338" },
    customParts: ["legleftredbrown.dat"],
  };
}

describe("mapStudioParts", () => {
  it("rewrites a reference only when Studio's name is not an LDraw part and its BrickLink id names exactly one", async () => {
    const mapping = await mapStudioParts(
      archive([
        "0 FILE wing",
        "0 FILE __flexiblesubmodel_rope copy 9",
        `1 16 ${MATRIX} __flexiblesubmodel_rope copy 9`,
        `1 15 ${MATRIX} 4162pb028a.dat`,
        `1 4 ${MATRIX} 92338c01.dat`,
        `1 4 ${MATRIX} 3001.dat`,
        `1 4 ${MATRIX} 60219.dat`,
        `1 100241 ${MATRIX} legleftredbrown.dat`,
        `1 16 ${MATRIX} 4079b.dat`,
        `1 16 ${MATRIX} wing`,
      ]),
      crosswalk,
      exists,
      new Set([4, 15, 16]),
    );
    expect(mapping.ldraw.split("\n")[3]).toBe(`1 15 ${MATRIX} 4162d02.dat`);
    expect(mapping.ldraw.split("\n").slice(4)).toEqual([
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
      "4162pb028a.dat": { kind: "bricklinkCrosswalk", ldraw: "4162d02" },
      "60219.dat": { kind: "kept" },
      "92338c01.dat": { kind: "ambiguous", candidates: ["92338-f1", "92338-f2"] },
      "legleftredbrown.dat": { kind: "custom" },
    });
    expect(mapping.unknownColors).toEqual([{ code: 100241, instances: 1 }]);
    expect(mapping.flexibleSections).toEqual([
      { name: "__flexiblesubmodel_rope copy 9", instances: 1 },
    ]);
  });
});
