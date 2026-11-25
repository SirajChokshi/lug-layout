import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { walkPart, type PlacedPolygon } from "../ldraw/walk.ts";
import { outlineAreaLdu2, planOutline } from "./plan-outline.ts";

const MICRO = 1_000_000;
const TONGUE_TIP_LDU = 169;
const SLEEPER_END_LDU = 80;
const NOTCH_LDU = 60;

const pinnedLibrary = new LdrawLibrary([
  fileURLToPath(new URL("../../../../.cache/ldraw", import.meta.url)),
]);

function pinnedOutline(part: string) {
  const polygons: PlacedPolygon[] = [];
  walkPart(pinnedLibrary, `${part}.dat`, { polygon: (polygon) => void polygons.push(polygon) });
  return planOutline(polygons);
}

function flatQuad(minX: number, minZ: number, maxX: number, maxZ: number, y = 0): PlacedPolygon {
  return {
    color: 16,
    vertices: [
      [minX, y, minZ],
      [maxX, y, minZ],
      [maxX, y, maxZ],
      [minX, y, maxZ],
    ],
  };
}

function wall(x: number, minZ: number, maxZ: number): PlacedPolygon {
  return {
    color: 16,
    vertices: [
      [x, 0, minZ],
      [x, 0, maxZ],
      [x, -24, maxZ],
      [x, -24, minZ],
    ],
  };
}

describe("planOutline", () => {
  it("unions overlapping faces into one exact boundary, not their hull, moving no vertex", () => {
    const { rings, roundedLdu } = planOutline([
      flatQuad(0, 0, 20, 20),
      flatQuad(10, 10, 30, 30, -8),
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(8);
    expect(outlineAreaLdu2(rings)).toBe(700);
    expect(roundedLdu).toBe(0);
  });

  it("keeps a see-through gap as a hole and drops faces that stand edge-on to the plan", () => {
    const frame = [
      flatQuad(0, 0, 60, 20),
      flatQuad(0, 40, 60, 60),
      flatQuad(0, 20, 20, 40),
      flatQuad(40, 20, 60, 40),
      wall(30, 20, 40),
    ];
    const { rings } = planOutline(frame);
    expect(rings.map((ring) => ring.length)).toEqual([4, 4]);
    expect(outlineAreaLdu2(rings)).toBe(60 * 60 - 20 * 20);
  });

  it("joins faces that only share an edge into a single ring", () => {
    const { rings } = planOutline([flatQuad(0, 0, 20, 20), flatQuad(20, 0, 40, 20)]);
    expect(rings).toEqual([
      expect.arrayContaining([
        [0, 0],
        [40 * MICRO, 0],
        [40 * MICRO, -20 * MICRO],
        [0, -20 * MICRO],
      ]),
    ]);
  });
});

describe("planOutline of the pinned library's parts", () => {
  it("draws 74746 as its sleeper comb with its holes, not a hull", () => {
    const [comb, ...holes] = pinnedOutline("74746").rings;
    const xs = comb?.map(([x]) => x) ?? [];
    const zs = comb?.map(([, z]) => z) ?? [];
    expect({
      x: [Math.min(...xs), Math.max(...xs)],
      z: [Math.min(...zs), Math.max(...zs)],
      notches: [-NOTCH_LDU * MICRO, NOTCH_LDU * MICRO].every((z) => zs.includes(z)),
      holes: holes.length > 0,
    }).toEqual({
      x: [-TONGUE_TIP_LDU * MICRO, TONGUE_TIP_LDU * MICRO],
      z: [-SLEEPER_END_LDU * MICRO, SLEEPER_END_LDU * MICRO],
      notches: true,
      holes: true,
    });
  });

  it("rounds no vertex of the ramp parts 4515 and 3297", () => {
    expect([pinnedOutline("4515").roundedLdu, pinnedOutline("3297").roundedLdu]).toEqual([0, 0]);
  });
});
