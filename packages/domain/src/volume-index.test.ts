import { describe, expect, it } from "vitest";
import {
  NO_VOLUME_TOP,
  VolumeIndex,
  cellChunkKey,
  firstOverlap,
  type CellVolumes,
} from "./volume-index.ts";

const keepAll = (): boolean => false;
const ignoreBaseplate = (owner: number): boolean => owner === 1;

function volumes(list: ReadonlyArray<readonly [number, number, number, number]>): CellVolumes {
  return {
    count: list.length,
    cellX: Int32Array.from(list.map(([x]) => x)),
    cellZ: Int32Array.from(list.map(([, z]) => z)),
    bottomLdu: Int32Array.from(list.map(([, , b]) => b)),
    topLdu: Int32Array.from(list.map(([, , , t]) => t)),
  };
}

describe("VolumeIndex", () => {
  const index = new VolumeIndex();
  index.add(1, -1, -1, -4, 0);
  index.add(2, -1, -1, 0, 24);
  index.add(3, -1, -1, 80, 96);

  it("keeps every span in a cell and reports the highest top and its owner, on both sides of zero", () => {
    const hit = { owner: 0, bottomLdu: 0, topLdu: 0 };
    expect(index.topAt(-1, -1)).toBe(96);
    expect(index.topOwnerAt(-1, -1, hit)).toBe(true);
    expect(hit).toEqual({ owner: 3, bottomLdu: 80, topLdu: 96 });
    expect(index.topAt(0, 0)).toBe(NO_VOLUME_TOP);
    expect(index.topOwnerAt(0, 0, hit)).toBe(false);
  });

  it.each([
    ["a span resting on the stack's top", [[-1, -1, 96, 104]], null],
    ["a span in the free gap under an overhang", [[-1, -1, 24, 80]], null],
    ["a span reaching into the overhang", [[-1, -1, 24, 81]], 3],
    ["a baseplate slab under a placed model", [[-1, -1, -4, 0]], 1],
  ] as const)("%s", (_name, list, owner) => {
    expect(firstOverlap(volumes(list), index, keepAll)?.owner ?? null).toBe(owner);
  });

  it("skips ignored owners and forgets only the cleared chunk", () => {
    expect(firstOverlap(volumes([[-1, -1, -4, 0]]), index, ignoreBaseplate)).toBeNull();
    const other = new VolumeIndex();
    other.add(1, 31, 0, 0, 8);
    other.add(1, 32, 0, 0, 8);
    other.clearChunk(cellChunkKey(31, 0));
    expect(other.topAt(31, 0)).toBe(NO_VOLUME_TOP);
    expect(other.topAt(32, 0)).toBe(8);
  });

  it("refuses an empty or fractional span", () => {
    expect(() => index.add(4, 0, 0, 8, 8)).toThrow(RangeError);
    expect(() => index.add(4, 0, 0, 0, 1.5)).toThrow(RangeError);
  });
});
