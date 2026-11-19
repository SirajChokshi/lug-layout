import { CHUNK_STUDS } from "@brr/math";
import { describe, expect, it } from "vitest";
import { VolumeIndex, firstOverlap, type CellVolumes, type OverlapHit } from "./volume-index.ts";

const keepAll = (): boolean => false;
const ignoreSlab = (owner: number): boolean => owner === 1;
const onlyOwner5 = (owner: number): boolean => owner !== 5;
const LOWEST_LDU = -0x8000_0000;
const HIGHEST_LDU = 0x7fff_ffff;

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
    index.remove(3, volumes([[-1, -1, 80, 96]]));
    expect(firstOverlap(volumes([[-1, -1, 24, 81]]), index, keepAll, hit())).toBe(false);
    const kept = hit();
    expect(firstOverlap(volumes([[-1, -1, 20, 30]]), index, keepAll, kept)).toBe(true);
    expect(kept.owner).toBe(2);
    index.add(4, volumes([[-1, -1, 40, 48]]));
    const added = hit();
    expect(firstOverlap(volumes([[-1, -1, 44, 45]]), index, keepAll, added)).toBe(true);
    expect(added.owner).toBe(4);
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
    for (let c = 0; c < across.count; c++) {
      const x = across.cellX[c] ?? 0;
      const z = across.cellZ[c] ?? 0;
      const bottom = across.bottomLdu[c] ?? 0;
      const top = across.topLdu[c] ?? 0;
      expect([
        firstOverlap(volumes([[x, z, bottom - 1, bottom]]), index, onlyOwner5, hit()),
        firstOverlap(volumes([[x, z, bottom, bottom + 1]]), index, onlyOwner5, hit()),
        firstOverlap(volumes([[x, z, top - 1, top]]), index, onlyOwner5, hit()),
        firstOverlap(volumes([[x, z, top, top + 1]]), index, onlyOwner5, hit()),
      ]).toEqual([false, true, true, false]);
    }
    index.remove(5, across);
    const kept = hit();
    expect(firstOverlap(volumes([[-1, -1, 95, 96]]), index, keepAll, kept)).toBe(true);
    expect(kept.owner).toBe(3);
    expect(
      firstOverlap(
        volumes([
          [-1, -1, 96, HIGHEST_LDU],
          [0, 0, LOWEST_LDU, HIGHEST_LDU],
          [CHUNK_STUDS, -CHUNK_STUDS - 1, LOWEST_LDU, HIGHEST_LDU],
        ]),
        index,
        keepAll,
        hit(),
      ),
    ).toBe(false);
  });

  it("takes an empty span as occupying nothing, and refuses a fractional one", () => {
    const index = stack();
    index.add(4, volumes([[0, 0, 8, 8]]));
    expect(firstOverlap(volumes([[0, 0, 0, 16]]), index, keepAll, hit())).toBe(false);
    const fractional = { count: 1, cellX: [0], cellZ: [0], bottomLdu: [0], topLdu: [1.5] };
    expect(() => index.add(4, fractional)).toThrow(RangeError);
  });
});
