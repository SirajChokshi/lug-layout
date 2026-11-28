import { decode } from "@brr/schema/decode";
import { ZoneNoteV2, type StudPoint } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { studRect, zoneContains } from "./zone-outline.ts";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function zoneWith(outline: ReadonlyArray<StudPoint>) {
  return decode(ZoneNoteV2, {
    kind: "zone",
    index: 0,
    layer: 1,
    name: "Yard",
    color: "#88cc44",
    outline,
  });
}

describe("zone outlines", () => {
  it("draws a rectangle between any two stud points that the schema keeps, unless it has no width or depth", () => {
    const next = lcg(3);
    const stud = (): number => ((next() % 41) - 20) * 20;
    const drawn = [];
    const expected = [];
    for (let sample = 0; sample < 500; sample++) {
      const a = { x: stud(), z: stud() };
      const b = { x: stud(), z: stud() };
      const outline = studRect(a, b);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minZ = Math.min(a.z, b.z);
      const maxZ = Math.max(a.z, b.z);
      const flat = minX === maxX || minZ === maxZ;
      const probes = [
        [(a.x + b.x) / 2, (a.z + b.z) / 2],
        [minX - 1, a.z],
        [a.x, maxZ + 1],
      ] as const;
      drawn.push({
        kept: outline !== null && zoneWith(outline).ok,
        inside: probes.map(([x, z]) => outline !== null && zoneContains(outline, x, z)),
      });
      expected.push({
        kept: !flat,
        inside: probes.map(([x, z]) => !flat && x > minX && x < maxX && z > minZ && z < maxZ),
      });
    }
    expect(drawn).toEqual(expected);
  });

  it("tells the inside of a concave zone from its notch", () => {
    const ell: StudPoint[] = [
      [0, 0],
      [200, 0],
      [200, 80],
      [80, 80],
      [80, 200],
      [0, 200],
    ];

    expect([
      zoneContains(ell, 40, 40),
      zoneContains(ell, 160, 40),
      zoneContains(ell, 40, 160),
      zoneContains(ell, 160, 160),
      zoneContains(ell, 100, 100),
    ]).toEqual([true, true, true, false, false]);
  });
});
