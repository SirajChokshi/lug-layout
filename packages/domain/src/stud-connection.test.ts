import { describe, expect, it } from "vitest";
import { engagedStuds, pickSurface, type SurfaceHit } from "./stud-connection.ts";
import { SupportGrid, type BaseCells } from "./support.ts";
import { VolumeIndex } from "./volume-index.ts";

const BASEPLATE = 1;
const BUILDING = 2;
const PLATFORM = 3;
const TRACK = 9;
const TABLE_LDU = -4;
const PLATFORM_PLATES = 3;
const PLATFORM_TOP_LDU = 24;
const BUILDING_TOP_LDU = 200;
const CEILING_LDU = BUILDING_TOP_LDU;
const keepAll = (): boolean => false;
const ignoreTrack = (owner: number): boolean => owner === TRACK;

const volumes = new VolumeIndex();
const support = new SupportGrid();
for (let z = 0; z < 32; z++) {
  for (let x = 0; x < 32; x++) {
    volumes.add(BASEPLATE, x, z, TABLE_LDU, 0);
    support.raiseStud(x, z, 0);
  }
}
for (let z = 0; z < 4; z++) {
  for (let x = 4; x < 8; x++) {
    volumes.add(PLATFORM, x, z, 0, PLATFORM_TOP_LDU);
    support.raiseStud(x, z, PLATFORM_PLATES);
  }
  for (let x = 10; x < 14; x++) volumes.add(BUILDING, x, z, 0, BUILDING_TOP_LDU);
  volumes.add(TRACK, 2, z, 0, 40);
}

const CAMERA = [-1000, 1500, 30] as const;

function rayTo(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(...CAMERA, x - CAMERA[0], y - CAMERA[1], z - CAMERA[2]);
}

function pick(ray: Float64Array, ignore = ignoreTrack): SurfaceHit | null {
  const out: SurfaceHit = { cellX: 0, cellZ: 0, topLdu: 0, x: 0, z: 0 };
  return pickSurface(ray, volumes, ignore, 0, CEILING_LDU, out) ? out : null;
}

describe("pickSurface", () => {
  it.each([
    ["a raised platform's top face", 110, PLATFORM_TOP_LDU, 30, 5, 1, PLATFORM_TOP_LDU],
    ["a building's roof", 230, BUILDING_TOP_LDU, 50, 11, 2, BUILDING_TOP_LDU],
    ["bare baseplate in front of the platform", 70, 0, 30, 3, 1, 0],
    ["bare baseplate beyond the building, behind its wall", 400, 0, 30, 10, 1, BUILDING_TOP_LDU],
    ["the table past every placement", 910, 0, 30, 45, 1, 0],
  ])("returns the first stack the cursor ray meets: %s", (_, x, y, z, cellX, cellZ, top) => {
    expect(pick(rayTo(x, y, z))).toMatchObject({ cellX, cellZ, topLdu: top });
  });

  it("puts the hit on the aimed top face, not where the ray would meet the baseplate datum", () => {
    const hit = pick(rayTo(110, PLATFORM_TOP_LDU, 30));
    expect(hit?.x).toBeCloseTo(110, 9);
    expect(hit?.z).toBeCloseTo(30, 9);
  });

  it("looks through owners the filter ignores", () => {
    expect(pick(rayTo(50, 40, 30), keepAll)).toMatchObject({ cellX: 2, topLdu: 40 });
    expect(pick(rayTo(50, 40, 30))).toMatchObject({ topLdu: 0 });
  });

  it("finds nothing for a ray that doesn't descend", () => {
    expect(pick(Float64Array.of(...CAMERA, 1, 0, 0))).toBeNull();
    expect(pick(Float64Array.of(...CAMERA, 1, 0.5, 0))).toBeNull();
  });
});

function cells(list: ReadonlyArray<readonly [number, number]>): BaseCells {
  return {
    count: list.length,
    cellX: Int32Array.from(list.map(([x]) => x)),
    cellZ: Int32Array.from(list.map(([, z]) => z)),
    flat: new Uint8Array(list.length),
  };
}

describe("engagedStuds", () => {
  const base = cells([
    [3, 0],
    [4, 0],
    [5, 0],
    [8, 0],
  ]);

  it.each([
    ["on the platform's studs", PLATFORM_PLATES, [4, 5]],
    ["on the baseplate's studs", 0, [3, 8]],
    ["between stud heights", 1, []],
  ])("lists the anti-stud cells that meet a stud at that height: %s", (_, yPlates, xs) => {
    const engaged = engagedStuds(base, yPlates, volumes, support, ignoreTrack);
    expect(Array.from(engaged.cellX)).toEqual(xs);
  });
});
