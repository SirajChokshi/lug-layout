import { CHUNK_STUDS, SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import {
  FootprintGrid,
  NO_PART_INSTANCE,
  VolumeIndex,
  firstOverlap,
  type CellParts,
  type CellVolumes,
  type OverlapHit,
  type PairExcuse,
  type VolumeHit,
} from "./volume-index.ts";

type Cell = readonly [number, number, number, number];
type Span = readonly [number, number, number];
type CellBox = readonly [number, number, number, number];
type Part = readonly [instance: number, box: CellBox, bottomLdu: number, topLdu: number];

const CELL = STUD_LDU * SIXTEENTHS_PER_LDU;
const HALF = CELL / 2;
const WHOLE_CELL: CellBox = [0, 0, CELL, CELL];
const WEST_HALF: CellBox = [0, 0, HALF, CELL];
const EAST_HALF: CellBox = [HALF, 0, CELL, CELL];

const keepAll = (): boolean => false;
const ignoreSlab = (owner: number): boolean => owner === 1;
const LOWEST_LDU = -0x8000_0000;
const HIGHEST_LDU = 0x7fff_ffff;

function cellParts(byCell: ReadonlyArray<ReadonlyArray<Part>>): CellParts {
  const all = byCell.flat();
  const start = [0];
  for (const parts of byCell) start.push((start.at(-1) ?? 0) + parts.length);
  return {
    start,
    instance: all.map(([instance]) => instance),
    cellBox: all.flatMap(([, box]) => box),
    heightBox: all.flatMap(([, , b, t]) => [b * SIXTEENTHS_PER_LDU, t * SIXTEENTHS_PER_LDU]),
  };
}

function partVolumes(
  cells: ReadonlyArray<readonly [cellX: number, cellZ: number, parts: ReadonlyArray<Part>]>,
  turn = 0,
): CellVolumes {
  const spans = cells.map(([, , parts]) => [
    Math.min(...parts.map(([, , b]) => b)),
    Math.max(...parts.map(([, , , t]) => t)),
  ]);
  return {
    count: cells.length,
    cellX: cells.map(([x]) => x),
    cellZ: cells.map(([, z]) => z),
    bottomLdu: spans.map(([b = 0]) => b),
    topLdu: spans.map(([, t = 0]) => t),
    partsAt: cells.map((_, c) => c),
    parts: cellParts(cells.map(([, , parts]) => parts)),
    turn,
    sixteenthsUp: 0,
  };
}

function volumes(list: ReadonlyArray<Cell>): CellVolumes {
  return partVolumes(list.map(([x, z, b, t], c) => [x, z, [[c, WHOLE_CELL, b, t]]]));
}

function place(index: VolumeIndex, owner: number, list: ReadonlyArray<Cell>): number {
  return placeVolumes(index, owner, volumes(list));
}

function placeVolumes(index: VolumeIndex, owner: number, world: CellVolumes): number {
  const xs = Array.from(world.cellX);
  const zs = Array.from(world.cellZ);
  const x0 = Math.min(...xs);
  const z0 = Math.min(...zs);
  const width = Math.max(...xs) - x0 + 1;
  const depth = Math.max(...zs) - z0 + 1;
  return index.add(owner, FootprintGrid.of(world, x0, z0, width, depth, 0), x0, z0, 0);
}

function hit(): OverlapHit {
  return {
    owner: 0,
    instance: NO_PART_INSTANCE,
    bottomLdu: 0,
    topLdu: 0,
    cellX: 0,
    cellZ: 0,
    candidateInstance: NO_PART_INSTANCE,
    candidateBottomLdu: 0,
    candidateTopLdu: 0,
  };
}

function overlapsSpan(
  index: VolumeIndex,
  cellX: number,
  cellZ: number,
  bottom: number,
  top: number,
  ignore: (owner: number) => boolean,
  out: OverlapHit,
): boolean {
  const held = partVolumes([[cellX, cellZ, [[0, WHOLE_CELL, bottom, top]]]]);
  return index.firstOverlap(cellX, cellZ, held, 0, ignore, out);
}

function stack(): { readonly index: VolumeIndex; readonly rows: ReadonlyArray<number> } {
  const index = new VolumeIndex();
  const rows = [
    place(index, 1, [[-1, -1, -4, 0]]),
    place(index, 2, [[-1, -1, 0, 24]]),
    place(index, 3, [[-1, -1, 80, 96]]),
  ];
  return { index, rows };
}

function ownersAt(index: VolumeIndex, cellX: number, cellZ: number): ReadonlyArray<Span> {
  const seen: number[] = [];
  const spans: Span[] = [];
  const out = hit();
  while (overlapsSpan(index, cellX, cellZ, LOWEST_LDU, HIGHEST_LDU, (o) => seen.includes(o), out)) {
    seen.push(out.owner);
    spans.push([out.owner, out.bottomLdu, out.topLdu]);
  }
  return spans;
}

function edges(
  index: VolumeIndex,
  owner: number,
  [cellX, cellZ, bottom, top]: Cell,
): ReadonlyArray<boolean> {
  const others = (o: number): boolean => o !== owner;
  return [
    [bottom - 1, bottom],
    [bottom, bottom + 1],
    [top - 1, top],
    [top, top + 1],
  ].map(([b = 0, t = 0]) => overlapsSpan(index, cellX, cellZ, b, t, others, hit()));
}

const AT_BOTH_ENDS = [false, true, true, false];

function observed(index: VolumeIndex, cells: ReadonlyArray<readonly [number, number]>): string {
  return cells.map(([x, z]) => `${x},${z}:${JSON.stringify(ownersAt(index, x, z))}`).join(";");
}

describe("VolumeIndex", () => {
  it("keeps every span in a cell, newest first, exact at both ends, on both sides of zero", () => {
    const { index } = stack();
    expect(ownersAt(index, -1, -1)).toEqual([
      [3, 80, 96],
      [2, 0, 24],
      [1, -4, 0],
    ]);
    expect([
      edges(index, 3, [-1, -1, 80, 96]),
      edges(index, 2, [-1, -1, 0, 24]),
      edges(index, 1, [-1, -1, -4, 0]),
    ]).toEqual([AT_BOTH_ENDS, AT_BOTH_ENDS, AT_BOTH_ENDS]);
    expect(ownersAt(index, 0, 0)).toEqual([]);
  });

  it.each([
    ["a span resting on the stack's top", [[-1, -1, 96, 104]], null],
    ["a span in the free gap under an overhang", [[-1, -1, 24, 80]], null],
    ["a span reaching into the overhang", [[-1, -1, 24, 81]], 3],
    ["a slab under a placed model", [[-1, -1, -4, 0]], 1],
  ] as const)("%s", (_name, list, owner) => {
    const out = hit();
    const found = firstOverlap(volumes(list), stack().index, keepAll, out);
    expect(found ? out.owner : null).toBe(owner);
  });

  it("names the cell and both spans of the first overlap, and skips ignored owners", () => {
    const out = hit();
    expect(firstOverlap(volumes([[-1, -1, 20, 30]]), stack().index, keepAll, out)).toBe(true);
    expect(out).toEqual({
      owner: 2,
      instance: 0,
      bottomLdu: 0,
      topLdu: 24,
      cellX: -1,
      cellZ: -1,
      candidateInstance: 0,
      candidateBottomLdu: 20,
      candidateTopLdu: 30,
    });
    expect(firstOverlap(volumes([[-1, -1, -4, 0]]), stack().index, ignoreSlab, hit())).toBe(false);
  });

  it("removes exactly one owner's footprint, only once, and reuses its row", () => {
    const { index, rows } = stack();
    const third = rows[2] ?? -1;
    index.remove(third);
    expect(ownersAt(index, -1, -1)).toEqual([
      [2, 0, 24],
      [1, -4, 0],
    ]);
    expect(firstOverlap(volumes([[-1, -1, 24, 81]]), index, keepAll, hit())).toBe(false);
    expect(() => index.remove(third)).toThrow(RangeError);
    expect(place(index, 4, [[-1, -1, 40, 48]])).toBe(third);
    expect(ownersAt(index, -1, -1)).toEqual([
      [4, 40, 48],
      [2, 0, 24],
      [1, -4, 0],
    ]);
    expect(edges(index, 4, [-1, -1, 40, 48])).toEqual(AT_BOTH_ENDS);
  });

  it("walks the owners of a cell newest first, as an exemption filter sees them", () => {
    const index = new VolumeIndex();
    place(index, 6, [[0, 0, 0, 24]]);
    const newest = place(index, 7, [
      [0, 0, 0, 24],
      [1, 0, 0, 24],
    ]);
    expect(ownersAt(index, 0, 0)).toEqual([
      [7, 0, 24],
      [6, 0, 24],
    ]);
    index.remove(newest);
    expect(ownersAt(index, 0, 0)).toEqual([[6, 0, 24]]);
    place(index, 7, [[0, 0, 8, 16]]);
    expect(ownersAt(index, 0, 0)).toEqual([
      [7, 8, 16],
      [6, 0, 24],
    ]);
  });

  it("places one shared grid at each row's own corner and height", () => {
    const index = new VolumeIndex();
    const grid = FootprintGrid.of(volumes([[0, 0, 24, 48]]), 0, 0, 1, 1, 24);
    index.add(9, grid, 0, 0, 24);
    index.add(10, grid, 5, -3, 72);
    expect([ownersAt(index, 0, 0), ownersAt(index, 5, -3), ownersAt(index, 5, 0)]).toEqual([
      [[9, 24, 48]],
      [[10, 72, 96]],
      [],
    ]);
    expect([edges(index, 9, [0, 0, 24, 48]), edges(index, 10, [5, -3, 72, 96])]).toEqual([
      AT_BOTH_ENDS,
      AT_BOTH_ENDS,
    ]);
  });

  it("indexes one owner's cells across chunks together, and removes them all", () => {
    const { index } = stack();
    const across: ReadonlyArray<Cell> = [
      [-1, -1, 96, 104],
      [0, 0, 0, 8],
      [CHUNK_STUDS, -CHUNK_STUDS - 1, 8, 16],
    ];
    const row = place(index, 5, across);
    expect(across.map((cell) => edges(index, 5, cell))).toEqual(across.map(() => AT_BOTH_ENDS));
    expect(firstOverlap(volumes([[0, -1, LOWEST_LDU, HIGHEST_LDU]]), index, keepAll, hit())).toBe(
      false,
    );
    index.remove(row);
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

  it("leaves the index as it was after add and remove, and as it was added after re-adding", () => {
    const { index } = stack();
    const footprint: ReadonlyArray<Cell> = [
      [-1, -1, 96, 120],
      [2, -1, 0, 8],
      [5, 3, 16, 24],
    ];
    const cells = [
      [-1, -1],
      [2, -1],
      [5, 3],
      [0, 0],
    ] as const;
    const before = observed(index, cells);
    const row = place(index, 8, footprint);
    const added = observed(index, cells);
    index.remove(row);
    const removed = observed(index, cells);
    place(index, 8, footprint);
    expect({ changed: added !== before, removed, readded: observed(index, cells) }).toEqual({
      changed: true,
      removed: before,
      readded: added,
    });
  });

  it("takes an empty span as occupying nothing, and refuses a fractional one", () => {
    const { index } = stack();
    place(index, 4, [[0, 0, 8, 8]]);
    expect(ownersAt(index, 0, 0)).toEqual([]);
    const fractional = { ...volumes([[0, 0, 0, 8]]), topLdu: [1.5] };
    expect(() => FootprintGrid.of(fractional, 0, 0, 1, 1, 0)).toThrow(RangeError);
  });
});

function heldAt(box: CellBox, bottom: number, top: number, turn = 0): CellVolumes {
  return partVolumes([[0, 0, [[3, box, bottom, top]]]], turn);
}

describe("VolumeIndex part boxes", () => {
  const BRICK = 24;
  const ARCH = 7;
  const PILLAR = 8;

  function arch(index: VolumeIndex, turn = 0): void {
    placeVolumes(
      index,
      2,
      partVolumes(
        [
          [
            0,
            0,
            [
              [PILLAR, WEST_HALF, 0, BRICK],
              [ARCH, WHOLE_CELL, BRICK, 2 * BRICK],
            ],
          ],
        ],
        turn,
      ),
    );
  }

  it.each([
    ["under the arch beside its pillar", EAST_HALF, 0, BRICK, null],
    ["into the pillar under the arch", WEST_HALF, 0, BRICK, PILLAR],
    ["across the cell under the arch", WHOLE_CELL, 8, 16, PILLAR],
    ["up into the arch beside the pillar", EAST_HALF, 8, BRICK + 1, ARCH],
  ] as const)("judges a held part %s on the placed parts' own boxes", (_name, box, b, t, part) => {
    const index = new VolumeIndex();
    arch(index);
    const out = hit();
    const found = firstOverlap(heldAt(box, b, t), index, keepAll, out);
    expect(found ? [out.instance, out.candidateInstance] : null).toEqual(
      part === null ? null : [part, 3],
    );
  });

  it.each([
    ["a half turn of the placed footprint moves its pillar east", 2, 0, WEST_HALF, EAST_HALF],
    ["a half turn of the held footprint moves its part west", 0, 2, WEST_HALF, EAST_HALF],
    ["a quarter turn of both keeps them apart", 1, 1, EAST_HALF, WEST_HALF],
    ["three quarter turns of both keep them apart", 3, 3, EAST_HALF, WEST_HALF],
  ] as const)(
    "turns in-cell boxes about the cell centre: %s",
    (_name, placed, held, clear, hits) => {
      const index = new VolumeIndex();
      arch(index, placed);
      const blocks = (box: CellBox): boolean =>
        firstOverlap(heldAt(box, 0, BRICK, held), index, keepAll, hit());
      expect([blocks(clear), blocks(hits)]).toEqual([false, true]);
    },
  );

  it("finds the placed parts a held part rests on, and only where their boxes meet", () => {
    const index = new VolumeIndex();
    arch(index);
    const contactOf = (box: CellBox, bottom: number): number | null => {
      const out: VolumeHit = { owner: 0, instance: NO_PART_INSTANCE, bottomLdu: 0, topLdu: 0 };
      const held = heldAt(box, bottom, bottom + 8);
      return index.firstContactBelow(0, 0, held, 0, keepAll, out) ? out.instance : null;
    };
    expect([
      contactOf(WHOLE_CELL, 2 * BRICK),
      contactOf(EAST_HALF, BRICK),
      contactOf(WEST_HALF, BRICK),
      contactOf(WHOLE_CELL, 2 * BRICK + 8),
    ]).toEqual([ARCH, null, PILLAR, null]);
  });

  it("lets an excuse waive one placed part, and hands it the overlap of the two boxes", () => {
    const index = new VolumeIndex();
    arch(index);
    const regions: Array<readonly [number, number, ReadonlyArray<number>]> = [];
    const waivePillar: PairExcuse = {
      excuses: (_owner, held, placed, region) => {
        regions.push([held, placed, Array.from(region)]);
        return placed === PILLAR;
      },
    };
    const out = hit();
    const held = heldAt(WHOLE_CELL, 16, BRICK + 4);
    expect(index.firstUnexcusedOverlap(0, 0, held, 0, 2, waivePillar, out)).toBe(true);
    expect([out.instance, regions]).toEqual([
      ARCH,
      [
        [3, PILLAR, [0, 16, 0, HALF / SIXTEENTHS_PER_LDU, BRICK, STUD_LDU]],
        [3, ARCH, [0, BRICK, 0, STUD_LDU, BRICK + 4, STUD_LDU]],
      ],
    ]);
    expect(index.firstUnexcusedOverlap(0, 0, held, 0, 5, waivePillar, hit())).toBe(false);
  });
});
