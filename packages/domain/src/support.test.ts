import { describe, expect, it } from "vitest";
import { SupportGrid, trackSupport, upperSupport, type BaseCells } from "./support.ts";
import { VolumeIndex } from "./volume-index.ts";

function cells(list: ReadonlyArray<readonly [number, number, 0 | 1]>): BaseCells {
  return {
    count: list.length,
    cellX: Int32Array.from(list.map(([x]) => x)),
    cellZ: Int32Array.from(list.map(([, z]) => z)),
    flat: Uint8Array.from(list.map(([, , flat]) => flat)),
  };
}

const BASEPLATE_OWNER = 1;
const TRACK_OWNER = 9;
const keepAll = (): boolean => false;
const ignoreTrack = (owner: number): boolean => owner === TRACK_OWNER;
const TABLE_LDU = -4;

function baseplate(
  support: SupportGrid,
  volumes: VolumeIndex,
  x0: number,
  z0: number,
  size: number,
): void {
  for (let z = z0; z < z0 + size; z++) {
    for (let x = x0; x < x0 + size; x++) {
      support.markBaseplate(x, z);
      support.raiseStud(x, z, 0);
      volumes.add(BASEPLATE_OWNER, x, z, TABLE_LDU, 0);
    }
  }
}

describe("upperSupport", () => {
  const volumes = new VolumeIndex();
  const support = new SupportGrid();
  baseplate(support, volumes, 0, 0, 4);
  volumes.add(2, 10, 0, 0, 24);

  it.each([
    ["an anti-stud over a baseplate stud", [[1, 1, 0]], 0, "studs"],
    ["a solid bottom over baseplate studs", [[1, 1, 1]], 0, "flat-on-studs"],
    [
      "a footprint half on the baseplate, half over the table",
      [
        [3, 0, 0],
        [4, 0, 0],
      ],
      0,
      "studs",
    ],
    [
      "a footprint entirely over the bare table",
      [
        [20, 20, 0],
        [21, 20, 0],
      ],
      0,
      "on-table",
    ],
    ["a footprint on a stud-free top at its height", [[10, 0, 0]], 3, "flat"],
    ["a footprint floating above the baseplate studs", [[1, 1, 0]], 1, "no-studs-engaged"],
    ["a model with no base at all", [], 0, "no-base"],
  ] as const)("%s", (_name, list, yPlates, kind) => {
    expect(upperSupport(cells(list), yPlates, volumes, support, keepAll).kind).toBe(kind);
  });

  it("never counts a track top as a flat top to rest on", () => {
    const railed = new VolumeIndex();
    railed.add(TRACK_OWNER, 30, 0, 0, 24);
    const onRails = cells([[30, 0, 0]]);
    expect(upperSupport(onRails, 3, railed, support, keepAll).kind).toBe("flat");
    expect(upperSupport(onRails, 3, railed, support, ignoreTrack).kind).toBe("no-studs-engaged");
  });
});

describe("trackSupport", () => {
  it("lists exactly the cells with no baseplate under them, never a covered non-baseplate cell", () => {
    const support = new SupportGrid();
    const volumes = new VolumeIndex();
    baseplate(support, volumes, -2, -2, 2);
    volumes.add(2, 1, -1, 0, 8);
    const run = cells([
      [-1, -1, 0],
      [0, -1, 0],
      [1, -1, 0],
    ]);
    const verdict = trackSupport(run, support);
    expect(verdict.kind).toBe("off-baseplate");
    if (verdict.kind !== "off-baseplate") return;
    expect([...verdict.missing.cellX]).toEqual([0, 1]);
    expect(trackSupport(cells([[-1, -2, 0]]), support).kind).toBe("on-baseplate");
  });
});
