import { expect, it } from "vitest";
import type { ChunkInstances } from "../scene-backend.ts";
import {
  groupRunEnd,
  isNotUpright,
  isVoxelized,
  linearColorsOf,
  matricesOf,
  pageOf,
  regionPage,
  regroupedPage,
  usesAnyShape,
  type InstancePage,
  type InstanceRuns,
  type RegionPage,
} from "./instance-page.ts";

const LINEAR = Float32Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9);
const COLOR_ALPHA_SLOT = Uint8Array.of(0, 1, 0);
const SWAPPED_COLOR_ALPHA_SLOT = Uint8Array.of(1, 0, 0);
const UPRIGHT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TILTED = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];

interface Instance {
  readonly shape: number;
  readonly colorIndex: number;
  readonly voxelized: number;
  readonly matrix: ReadonlyArray<number>;
}

function at(base: ReadonlyArray<number>, x: number, y: number, z: number): number[] {
  return base.map((value, i) => (i === 3 ? x : i === 7 ? y : i === 11 ? z : value));
}

const PARTS: ReadonlyArray<Instance> = [
  { shape: 2, colorIndex: 0, voxelized: 0, matrix: at(UPRIGHT, 10, 0, 20) },
  { shape: 1, colorIndex: 1, voxelized: 1, matrix: at(TILTED, 30, 8, 40) },
  { shape: 2, colorIndex: 2, voxelized: 1, matrix: at(UPRIGHT, 50, 16, 60) },
  { shape: 1, colorIndex: 1, voxelized: 0, matrix: at(UPRIGHT, 70, 24, 80) },
  { shape: 2, colorIndex: 0, voxelized: 0, matrix: at(TILTED, 90, 32, 100) },
];
const STUDS: ReadonlyArray<Instance> = [
  { shape: 3, colorIndex: 1, voxelized: 0, matrix: at(UPRIGHT, 1, 2, 3) },
  { shape: 0, colorIndex: 0, voxelized: 0, matrix: at(UPRIGHT, 4, 5, 6) },
  { shape: 3, colorIndex: 2, voxelized: 0, matrix: at(TILTED, 7, 8, 9) },
];

function chunkAt(
  originX: number,
  originZ: number,
  parts: ReadonlyArray<Instance>,
  studs: ReadonlyArray<Instance>,
): ChunkInstances {
  return {
    originX,
    originZ,
    count: parts.length,
    partIndex: Uint16Array.from(parts.map((p) => p.shape)),
    colorIndex: Uint16Array.from(parts.map((p) => p.colorIndex)),
    voxelized: Uint8Array.from(parts.map((p) => p.voxelized)),
    matrices: Float32Array.from(parts.flatMap((p) => p.matrix)),
    studs: {
      count: studs.length,
      primitiveIndex: Uint8Array.from(studs.map((s) => s.shape)),
      colorIndex: Uint16Array.from(studs.map((s) => s.colorIndex)),
      matrices: Float32Array.from(studs.flatMap((s) => s.matrix)),
    },
  };
}

function chunk(): ChunkInstances {
  return chunkAt(640, -1280, PARTS, STUDS);
}

function expectedRow(kind: string, instance: Instance): string {
  const c = instance.colorIndex * 3;
  const rgb = Array.from(LINEAR.subarray(c, c + 3));
  return [
    kind,
    instance.shape,
    instance.colorIndex,
    instance.voxelized,
    ...instance.matrix,
    ...rgb,
  ].join(" ");
}

function pageRow(page: InstancePage, i: number): string {
  const m = page.matrices.subarray(i * 16, i * 16 + 16);
  const rowMajor = [0, 1, 2].flatMap((row) => [0, 1, 2, 3].map((column) => m[column * 4 + row]));
  const isPart = i < page.partCount;
  return [
    isPart ? "part" : "stud",
    page.shape[i],
    page.colorIndex[i],
    isPart ? page.voxelized[i] : 0,
    ...rowMajor,
    ...page.linearColors.subarray(i * 3, i * 3 + 3),
  ].join(" ");
}

function pageRows(page: InstancePage): string[] {
  return Array.from({ length: page.instanceCount }, (_, i) => pageRow(page, i)).toSorted();
}

function runTable(runs: InstanceRuns): number[][] {
  return Array.from({ length: runs.shape.length }, (_, r) => [
    runs.shape[r] ?? 0,
    runs.alphaSlot[r] ?? 0,
    runs.start[r] ?? 0,
    runs.end[r] ?? 0,
  ]);
}

function partRunTable(runs: InstanceRuns): Array<Array<number | boolean>> {
  return runTable(runs).map(([shape = 0, slot = 0, start = 0, end = 0], r) => [
    shape,
    slot,
    isNotUpright(runs.instanceClass[r] ?? 0),
    isVoxelized(runs.instanceClass[r] ?? 0),
    start,
    end,
  ]);
}

function translationsIn(page: InstancePage, runs: InstanceRuns): number[][] {
  return runTable(runs).map(([, , start = 0, end = 0]) =>
    Array.from({ length: end - start }, (_, n) => page.matrices[(start + n) * 16 + 12] ?? 0),
  );
}

it("keeps every instance with its transform and linear colour, and keeps them when regrouped", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT);
  const expected = [
    ...PARTS.map((p) => expectedRow("part", p)),
    ...STUDS.map((s) => expectedRow("stud", s)),
  ].toSorted();

  expect([page.originX, page.originZ, page.partCount]).toEqual([640, -1280, PARTS.length]);
  expect(pageRows(page)).toEqual(expected);
  expect(pageRows(regroupedPage(page, LINEAR, COLOR_ALPHA_SLOT))).toEqual(expected);
});

it("draws parts in runs of one part, alpha slot and instance class, and studs in runs of one primitive and alpha slot", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT);

  expect(partRunTable(page.partRuns)).toEqual([
    [1, 1, false, false, 0, 1],
    [1, 1, true, true, 1, 2],
    [2, 0, false, false, 2, 3],
    [2, 0, true, false, 3, 4],
    [2, 0, false, true, 4, 5],
  ]);
  expect(translationsIn(page, page.partRuns)).toEqual([[70], [30], [10], [90], [50]]);
  expect(runTable(page.studRuns)).toEqual([
    [0, 0, 5, 6],
    [3, 0, 6, 7],
    [3, 1, 7, 8],
  ]);
  expect(translationsIn(page, page.studRuns)).toEqual([[4], [7], [1]]);
  expect([groupRunEnd(page.partRuns, 0), groupRunEnd(page.partRuns, 2)]).toEqual([2, 5]);
  expect(Array.from(page.studRuns.instanceClass, (c) => isNotUpright(c) || isVoxelized(c))).toEqual(
    [false, false, false],
  );
  expect([
    usesAnyShape(page.partRuns, new Set([2, 9])),
    usesAnyShape(page.partRuns, new Set([0, 3])),
  ]).toEqual([true, false]);
});

it("moves instances to their new runs when the palette gives their colours other alpha slots", () => {
  const page = regroupedPage(
    pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT),
    LINEAR,
    SWAPPED_COLOR_ALPHA_SLOT,
  );

  expect(pageRows(page)).toEqual(
    [
      ...PARTS.map((p) => expectedRow("part", p)),
      ...STUDS.map((s) => expectedRow("stud", s)),
    ].toSorted(),
  );
  expect(partRunTable(page.partRuns)).toEqual([
    [1, 0, false, false, 0, 1],
    [1, 0, true, true, 1, 2],
    [2, 0, false, true, 2, 3],
    [2, 1, false, false, 3, 4],
    [2, 1, true, false, 4, 5],
  ]);
  expect(translationsIn(page, page.partRuns)).toEqual([[70], [30], [50], [10], [90]]);
  expect([
    groupRunEnd(page.partRuns, 0),
    groupRunEnd(page.partRuns, 2),
    groupRunEnd(page.partRuns, 3),
  ]).toEqual([2, 3, 5]);
  expect(runTable(page.studRuns)).toEqual([
    [0, 1, 5, 6],
    [3, 0, 6, 8],
  ]);
  expect(translationsIn(page, page.studRuns)).toEqual([[4], [7, 1]]);
});

it("hands meshes views of the page rather than copies", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT);
  const matrices = matricesOf(page, 2, 5);
  const colors = linearColorsOf(page, 2, 5);

  expect([matrices.buffer, colors.buffer]).toEqual([
    page.matrices.buffer,
    page.linearColors.buffer,
  ]);
  expect([matrices.byteOffset, matrices.length]).toEqual([2 * 16 * 4, 3 * 16]);
  expect([colors.byteOffset, colors.length]).toEqual([2 * 3 * 4, 3 * 3]);
});

const REGION_X = 1280;
const REGION_Z = -2560;
const NO_CHANGES: ReadonlyMap<number, ChunkInstances | null> = new Map();

function movedBy(instance: Instance, dx: number, dz: number): Instance {
  const [x = 0, y = 0, z = 0] = [instance.matrix[3], instance.matrix[7], instance.matrix[11]];
  return { ...instance, matrix: at(instance.matrix, x + dx, y, z + dz) };
}

function expectedChunkRows(
  key: number,
  originX: number,
  originZ: number,
  parts: ReadonlyArray<Instance>,
  studs: ReadonlyArray<Instance>,
): string[] {
  const dx = originX - REGION_X;
  const dz = originZ - REGION_Z;
  return [
    ...parts.map((p) => `${key} ${expectedRow("part", movedBy(p, dx, dz))}`),
    ...studs.map((s) => `${key} ${expectedRow("stud", movedBy(s, dx, dz))}`),
  ];
}

function regionRows(page: RegionPage | null): string[] {
  if (!page) return [];
  return Array.from(
    { length: page.instanceCount },
    (_, i) => `${page.chunkKeys[page.chunkIndex[i] ?? 0]} ${pageRow(page, i)}`,
  ).toSorted();
}

function update(
  previous: RegionPage | null,
  changes: ReadonlyArray<readonly [number, ChunkInstances | null]>,
  colorAlphaSlot = COLOR_ALPHA_SLOT,
): RegionPage | null {
  return regionPage(previous, new Map(changes), REGION_X, REGION_Z, LINEAR, colorAlphaSlot);
}

const WEST = chunkAt(1280, -2560, PARTS.slice(0, 3), STUDS.slice(0, 1));
const EAST = chunkAt(1920, -1920, PARTS.slice(3), STUDS.slice(1));
const EAST_AGAIN = chunkAt(1920, -1920, PARTS.slice(1, 2), []);

it("keeps each chunk's instances at their place in the region until that chunk is replaced or removed", () => {
  const both = update(null, [
    [7, WEST],
    [9, EAST],
  ]);
  const westRows = expectedChunkRows(7, 1280, -2560, PARTS.slice(0, 3), STUDS.slice(0, 1));
  const eastRows = expectedChunkRows(9, 1920, -1920, PARTS.slice(3), STUDS.slice(1));
  const eastAgainRows = expectedChunkRows(9, 1920, -1920, PARTS.slice(1, 2), []);
  const replaced = update(both, [[9, EAST_AGAIN]]);
  const westRemoved = update(replaced, [[7, null]]);

  expect([both?.originX, both?.originZ]).toEqual([REGION_X, REGION_Z]);
  expect(regionRows(both)).toEqual([...westRows, ...eastRows].toSorted());
  expect(regionRows(replaced)).toEqual([...westRows, ...eastAgainRows].toSorted());
  expect(Array.from(westRemoved?.chunkKeys ?? [])).toEqual([9]);
  expect(regionRows(westRemoved)).toEqual(eastAgainRows.toSorted());
  expect(update(westRemoved, [[9, null]])).toBeNull();
});

it("builds the same page whatever order its chunks arrive in, including two chunks at one origin", () => {
  const PART_KEY = 4;
  const TRACK_KEY = -1 - PART_KEY;
  const parts = chunkAt(1280, -2560, PARTS.slice(0, 2), STUDS);
  const track = chunkAt(1280, -2560, PARTS.slice(2), []);
  const together = update(null, [
    [PART_KEY, parts],
    [TRACK_KEY, track],
  ]);

  expect(Array.from(together?.chunkKeys ?? [])).toEqual([TRACK_KEY, PART_KEY]);
  expect(regionRows(together)).toEqual(
    [
      ...expectedChunkRows(PART_KEY, 1280, -2560, PARTS.slice(0, 2), STUDS),
      ...expectedChunkRows(TRACK_KEY, 1280, -2560, PARTS.slice(2), []),
    ].toSorted(),
  );
  expect(update(update(null, [[PART_KEY, parts]]), [[TRACK_KEY, track]])).toEqual(together);
  expect(update(update(null, [[TRACK_KEY, track]]), [[PART_KEY, parts]])).toEqual(together);
});

it("regroups a region for a new palette as if it were built with that palette", () => {
  const changes = [
    [7, WEST],
    [9, EAST],
  ] as const;
  const regrouped = regionPage(
    update(null, changes),
    NO_CHANGES,
    REGION_X,
    REGION_Z,
    LINEAR.toReversed(),
    SWAPPED_COLOR_ALPHA_SLOT,
  );

  expect(regrouped).toEqual(
    regionPage(
      null,
      new Map(changes),
      REGION_X,
      REGION_Z,
      LINEAR.toReversed(),
      SWAPPED_COLOR_ALPHA_SLOT,
    ),
  );
});

it("refuses more chunks than a region page can index", () => {
  const empty = chunkAt(REGION_X, REGION_Z, [], []);
  const tooMany = Array.from({ length: 257 }, (_, key) => [key, empty] as const);

  expect(() => update(null, tooMany)).toThrow(RangeError);
});
