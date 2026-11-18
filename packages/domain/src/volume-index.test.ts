import { describe, expect, it } from "vitest";
import { VolumeIndex, firstOverlap, type CellVolumes, type OverlapHit } from "./volume-index.ts";

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
  index.add(1, -1, -1, -4, 0);
  index.add(2, -1, -1, 0, 24);
  index.add(3, -1, -1, 80, 96);
  return index;
}

describe("VolumeIndex", () => {
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

  it("removes exactly one owner's span, only once, and indexes a span added after it", () => {
    const index = stack();
    index.remove(3, -1, -1, 80, 96);
    expect(firstOverlap(volumes([[-1, -1, 24, 81]]), index, keepAll, hit())).toBe(false);
    const kept = hit();
    expect(firstOverlap(volumes([[-1, -1, 20, 30]]), index, keepAll, kept)).toBe(true);
    expect(kept.owner).toBe(2);
    index.add(4, -1, -1, 40, 48);
    const added = hit();
    expect(firstOverlap(volumes([[-1, -1, 44, 45]]), index, keepAll, added)).toBe(true);
    expect(added.owner).toBe(4);
    expect(() => index.remove(3, -1, -1, 80, 96)).toThrow(RangeError);
  });

  it("refuses an empty or fractional span", () => {
    const index = stack();
    expect(() => index.add(4, 0, 0, 8, 8)).toThrow(RangeError);
    expect(() => index.add(4, 0, 0, 0, 1.5)).toThrow(RangeError);
  });
});
