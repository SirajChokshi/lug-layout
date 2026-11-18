import { expect, it } from "vitest";
import type { ChunkInstances } from "../scene-backend.ts";
import {
  groupRunEnd,
  isNotUpright,
  isVoxelized,
  linearColorsOf,
  matricesOf,
  pageOf,
  regroupedPage,
  usesAnyShape,
  type InstancePage,
  type InstanceRuns,
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

function chunk(): ChunkInstances {
  return {
    originX: 640,
    originZ: -1280,
    count: PARTS.length,
    partIndex: Uint16Array.from(PARTS.map((p) => p.shape)),
    colorIndex: Uint16Array.from(PARTS.map((p) => p.colorIndex)),
    voxelized: Uint8Array.from(PARTS.map((p) => p.voxelized)),
    matrices: Float32Array.from(PARTS.flatMap((p) => p.matrix)),
    studs: {
      count: STUDS.length,
      primitiveIndex: Uint8Array.from(STUDS.map((s) => s.shape)),
      colorIndex: Uint16Array.from(STUDS.map((s) => s.colorIndex)),
      matrices: Float32Array.from(STUDS.flatMap((s) => s.matrix)),
    },
  };
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
