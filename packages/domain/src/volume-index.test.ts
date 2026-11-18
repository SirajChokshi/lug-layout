import { CHUNK_STUDS } from "@brr/math";
import { describe, expect, it } from "vitest";
import {
  NO_VOLUME_TOP,
  VolumeIndex,
  firstOverlap,
  type CellVolumes,
  type OverlapHit,
} from "./volume-index.ts";

const keepAll = (): boolean => false;
const ignoreSlab = (owner: number): boolean => owner === 1;

function volumes(list: ReadonlyArray<readonly [number, number, number, number]>): CellVolumes {
  return {
    count: list.length,
    cellX: Int32Array.from(list.map(([x]) => x)),
    cellZ: Int32Array.from(list.map(([, z]) => z)),
    bottomLdu: Int32Array.from(list.map(([, , b]) => b)),
    topLdu: Int32Array.from(list.map(([, , , t]) => t)),
  };
}

function hit(): OverlapHit {
  return {
    owner: 0,
    bottomLdu: 0,
    topLdu: 0,
    cellX: 0,
    cellZ: 0,
    candidateBottomLdu: 0,
    candidateTopLdu: 0,
  };
}

function stack(): VolumeIndex {
  const index = new VolumeIndex();
  index.add(1, volumes([[-1, -1, -4, 0]]));
  index.add(2, volumes([[-1, -1, 0, 24]]));
  index.add(3, volumes([[-1, -1, 80, 96]]));
  return index;
}

describe("VolumeIndex", () => {
  it("keeps every span in a cell and reports the highest top, on both sides of zero", () => {
    const index = stack();
    expect(index.topAt(-1, -1)).toBe(96);
    expect(index.topAt(0, 0)).toBe(NO_VOLUME_TOP);
  });

  it.each([
    ["a span resting on the stack's top", [[-1, -1, 96, 104]], null],
    ["a span in the free gap under an overhang", [[-1, -1, 24, 80]], null],
    ["a span reaching into the overhang", [[-1, -1, 24, 81]], 3],
    ["a slab under a placed model", [[-1, -1, -4, 0]], 1],
  ] as const)("%s", (_name, list, owner) => {
    const out = hit();
    const found = firstOverlap(volumes(list), stack(), keepAll, out);
    expect(found ? out.owner : null).toBe(owner);
  });

  it("names the cell and both spans of the first overlap, and skips ignored owners", () => {
    const out = hit();
    expect(firstOverlap(volumes([[-1, -1, 20, 30]]), stack(), keepAll, out)).toBe(true);
    expect(out).toEqual({
      owner: 2,
      bottomLdu: 0,
      topLdu: 24,
      cellX: -1,
      cellZ: -1,
      candidateBottomLdu: 20,
      candidateTopLdu: 30,
    });
    expect(firstOverlap(volumes([[-1, -1, -4, 0]]), stack(), ignoreSlab, hit())).toBe(false);
  });

  it("removes exactly one owner's span and reuses its record", () => {
    const index = stack();
    index.remove(3, volumes([[-1, -1, 80, 96]]));
    expect(index.topAt(-1, -1)).toBe(24);
    expect(firstOverlap(volumes([[-1, -1, 24, 81]]), index, keepAll, hit())).toBe(false);
    index.add(4, volumes([[-1, -1, 40, 48]]));
    expect(index.topAt(-1, -1)).toBe(48);
    expect(() => index.remove(3, volumes([[-1, -1, 80, 96]]))).toThrow(RangeError);
  });

  it("indexes one owner's cells across chunks together, and removes them all", () => {
    const index = stack();
    const across = volumes([
      [-1, -1, 96, 104],
      [0, 0, 0, 8],
      [CHUNK_STUDS, -CHUNK_STUDS - 1, 8, 16],
    ]);
    index.add(5, across);
    expect([
      index.topAt(-1, -1),
      index.topAt(0, 0),
      index.topAt(CHUNK_STUDS, -CHUNK_STUDS - 1),
    ]).toEqual([104, 8, 16]);
    index.remove(5, across);
    expect([
      index.topAt(-1, -1),
      index.topAt(0, 0),
      index.topAt(CHUNK_STUDS, -CHUNK_STUDS - 1),
    ]).toEqual([96, NO_VOLUME_TOP, NO_VOLUME_TOP]);
  });

  it("takes an empty span as occupying nothing, and refuses a fractional one", () => {
    const index = stack();
    index.add(4, volumes([[0, 0, 8, 8]]));
    expect(index.topAt(0, 0)).toBe(NO_VOLUME_TOP);
    const fractional = { count: 1, cellX: [0], cellZ: [0], bottomLdu: [0], topLdu: [1.5] };
    expect(() => index.add(4, fractional)).toThrow(RangeError);
  });
});
