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
  studBasisAndColorIndexOf,
  studBasisIndexOf,
  studColorIndexOf,
  studTranslationsOf,
  usesAnyShape,
  type InstancePage,
  type InstanceRuns,
} from "./instance-page.ts";
import { StudBasisTable } from "./stud-basis-table.ts";

const LINEAR = Float32Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9);
const COLOR_ALPHA_SLOT = Uint8Array.of(0, 1, 0);
const RENUMBERED_COLOR_ALPHA_SLOT = Uint8Array.of(1, 0, 1);
const SWAPPED_COLOR_ALPHA_SLOT = Uint8Array.of(1, 0, 0);
const PART_TRANSLATIONS_IN_CHUNK_ORDER = [[10], [90], [50], [70], [30]];
const STUD_TRANSLATIONS_IN_CHUNK_ORDER = [[1], [4], [7]];
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

function chunkOf(
  parts: ReadonlyArray<Instance>,
  studs: ReadonlyArray<Instance>,
  paletteIndexOf: (shape: number) => number = (shape) => shape,
): ChunkInstances {
  return {
    originX: 640,
    originZ: -1280,
    count: parts.length,
    partIndex: Uint16Array.from(parts.map((p) => paletteIndexOf(p.shape))),
    colorIndex: Uint16Array.from(parts.map((p) => p.colorIndex)),
    voxelized: Uint8Array.from(parts.map((p) => p.voxelized)),
    matrices: Float32Array.from(parts.flatMap((p) => p.matrix)),
    studs: {
      count: studs.length,
      primitiveIndex: Uint8Array.from(studs.map((s) => paletteIndexOf(s.shape))),
      colorIndex: Uint16Array.from(studs.map((s) => s.colorIndex)),
      matrices: Float32Array.from(studs.flatMap((s) => s.matrix)),
    },
  };
}

function chunk(): ChunkInstances {
  return chunkOf(PARTS, STUDS);
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

function studMatrix(page: InstancePage, bases: StudBasisTable, i: number): Float32Array {
  const s = i - page.partCount;
  const basis = studBasisIndexOf(page.studBasisAndColorIndex[s] ?? 0) * 12;
  const matrix = new Float32Array(16);
  matrix.set(bases.columns.subarray(basis, basis + 12));
  matrix.set(page.studTranslations.subarray(s * 3, s * 3 + 3), 12);
  matrix[15] = 1;
  return matrix;
}

function pageRow(page: InstancePage, bases: StudBasisTable, i: number): string {
  const isPart = i < page.partCount;
  const m = isPart ? page.matrices.subarray(i * 16, i * 16 + 16) : studMatrix(page, bases, i);
  const rowMajor = [0, 1, 2].flatMap((row) => [0, 1, 2, 3].map((column) => m[column * 4 + row]));
  const color = isPart
    ? (page.colorIndex[i] ?? 0)
    : studColorIndexOf(page.studBasisAndColorIndex[i - page.partCount] ?? 0);
  return [
    isPart ? "part" : "stud",
    page.shape[i],
    color,
    isPart ? page.voxelized[i] : 0,
    ...rowMajor,
    ...(isPart
      ? page.linearColors.subarray(i * 3, i * 3 + 3)
      : LINEAR.subarray(color * 3, color * 3 + 3)),
  ].join(" ");
}

function pageRows(page: InstancePage, bases: StudBasisTable): string[] {
  return Array.from({ length: page.instanceCount }, (_, i) => pageRow(page, bases, i)).toSorted();
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

function translationX(page: InstancePage, i: number): number {
  return i < page.partCount
    ? (page.matrices[i * 16 + 12] ?? 0)
    : (page.studTranslations[(i - page.partCount) * 3] ?? 0);
}

function translationsIn(page: InstancePage, runs: InstanceRuns): number[][] {
  return runTable(runs).map(([, , start = 0, end = 0]) =>
    Array.from({ length: end - start }, (_, n) => translationX(page, start + n)),
  );
}

it("keeps every instance with its transform and linear colour, and keeps them when regrouped", () => {
  const bases = new StudBasisTable();
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, bases);
  const expected = [
    ...PARTS.map((p) => expectedRow("part", p)),
    ...STUDS.map((s) => expectedRow("stud", s)),
  ].toSorted();

  expect([page.originX, page.originZ, page.partCount]).toEqual([640, -1280, PARTS.length]);
  expect(pageRows(page, bases)).toEqual(expected);
  expect(pageRows(regroupedPage(page, LINEAR, COLOR_ALPHA_SLOT), bases)).toEqual(expected);
});

it("draws parts in runs of one part, alpha slot and instance class, and studs in runs of one primitive and alpha slot", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, new StudBasisTable());

  expect(partRunTable(page.partRuns)).toEqual([
    [2, 0, false, false, 0, 1],
    [2, 0, true, false, 1, 2],
    [2, 0, false, true, 2, 3],
    [1, 1, false, false, 3, 4],
    [1, 1, true, true, 4, 5],
  ]);
  expect(translationsIn(page, page.partRuns)).toEqual(PART_TRANSLATIONS_IN_CHUNK_ORDER);
  expect(runTable(page.studRuns)).toEqual([
    [3, 1, 5, 6],
    [0, 0, 6, 7],
    [3, 0, 7, 8],
  ]);
  expect(translationsIn(page, page.studRuns)).toEqual(STUD_TRANSLATIONS_IN_CHUNK_ORDER);
  expect([groupRunEnd(page.partRuns, 0), groupRunEnd(page.partRuns, 3)]).toEqual([3, 5]);
  expect(Array.from(page.studRuns.instanceClass, (c) => isNotUpright(c) || isVoxelized(c))).toEqual(
    [false, false, false],
  );
  expect([
    usesAnyShape(page.partRuns, new Set([2, 9])),
    usesAnyShape(page.partRuns, new Set([0, 3])),
  ]).toEqual([true, false]);
});

it("page groups follow chunk instance order whatever palette indices its parts have", () => {
  const swapped = new Map([
    [0, 3],
    [1, 2],
    [2, 1],
    [3, 0],
  ]);
  const page = pageOf(
    chunkOf(PARTS, STUDS, (shape) => swapped.get(shape) ?? shape),
    LINEAR,
    COLOR_ALPHA_SLOT,
    new StudBasisTable(),
  );
  const regrouped = regroupedPage(page, LINEAR, COLOR_ALPHA_SLOT);

  for (const built of [page, regrouped]) {
    expect(translationsIn(built, built.partRuns)).toEqual(PART_TRANSLATIONS_IN_CHUNK_ORDER);
    expect(translationsIn(built, built.studRuns)).toEqual(STUD_TRANSLATIONS_IN_CHUNK_ORDER);
  }
});

it("a regrouped page under a slot renumbering has the group order of a fresh page", () => {
  const regrouped = regroupedPage(
    pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, new StudBasisTable()),
    LINEAR,
    RENUMBERED_COLOR_ALPHA_SLOT,
  );
  const fresh = pageOf(chunk(), LINEAR, RENUMBERED_COLOR_ALPHA_SLOT, new StudBasisTable());

  for (const page of [regrouped, fresh]) {
    expect(partRunTable(page.partRuns)).toEqual([
      [2, 1, false, false, 0, 1],
      [2, 1, true, false, 1, 2],
      [2, 1, false, true, 2, 3],
      [1, 0, false, false, 3, 4],
      [1, 0, true, true, 4, 5],
    ]);
    expect(translationsIn(page, page.partRuns)).toEqual(PART_TRANSLATIONS_IN_CHUNK_ORDER);
    expect(runTable(page.studRuns)).toEqual([
      [3, 0, 5, 6],
      [0, 1, 6, 7],
      [3, 1, 7, 8],
    ]);
    expect(translationsIn(page, page.studRuns)).toEqual(STUD_TRANSLATIONS_IN_CHUNK_ORDER);
  }
});

it("refuses to regroup when the colour-to-slot map changes which colours share a slot", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, new StudBasisTable());

  expect(() => regroupedPage(page, LINEAR, SWAPPED_COLOR_ALPHA_SLOT)).toThrow(
    "a page can only be regrouped when the same colours still share each alpha slot",
  );
});

const QUARTER_TURN_ROWS = [0, 0, 1, 50, 0, 1, 0, 8, -1, 0, 0, 70];
const LDRAW_EIGHTH_TURN = 707 / 1000;
const EXACT_STUDS: ReadonlyArray<{ readonly stud: Instance; readonly expected: number[] }> = [
  {
    stud: { shape: 0, colorIndex: 0, voxelized: 0, matrix: [1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 30] },
    expected: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 30, 1],
  },
  {
    stud: { shape: 0, colorIndex: 1, voxelized: 0, matrix: QUARTER_TURN_ROWS },
    expected: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 50, 8, 70, 1],
  },
  {
    stud: {
      shape: 1,
      colorIndex: 2,
      voxelized: 0,
      matrix: [
        LDRAW_EIGHTH_TURN,
        0,
        LDRAW_EIGHTH_TURN,
        90,
        0,
        1,
        0,
        16,
        -LDRAW_EIGHTH_TURN,
        0,
        LDRAW_EIGHTH_TURN,
        110,
      ],
    },
    expected: [
      LDRAW_EIGHTH_TURN,
      0,
      -LDRAW_EIGHTH_TURN,
      0,
      0,
      1,
      0,
      0,
      LDRAW_EIGHTH_TURN,
      0,
      LDRAW_EIGHTH_TURN,
      0,
      90,
      16,
      110,
      1,
    ],
  },
  {
    stud: {
      shape: 0,
      colorIndex: 0,
      voxelized: 0,
      matrix: [0.9998, 0, 0, 130, 0, 0.5, 0, 24, 0, 0, 0.9998, 150],
    },
    expected: [0.9998, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.9998, 0, 130, 24, 150, 1],
  },
  {
    stud: {
      shape: 0,
      colorIndex: 1,
      voxelized: 0,
      matrix: [1, -0, 0, 170, 0, 1, 0, 32, 0, 0, 1, 190],
    },
    expected: [1, 0, 0, 0, -0, 1, 0, 0, 0, 0, 1, 0, 170, 32, 190, 1],
  },
  {
    stud: {
      shape: 1,
      colorIndex: 2,
      voxelized: 0,
      matrix: [1, 0, 0, 210.0710678, 0, 1, 0, 40, 0, 0, 1, 230.01],
    },
    expected: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 210.0710678, 40, 230.01, 1],
  },
  {
    stud: { shape: 1, colorIndex: 0, voxelized: 0, matrix: at(QUARTER_TURN_ROWS, 250, 48, 270) },
    expected: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 250, 48, 270, 1],
  },
];
const DISTINCT_EXACT_BASES = 5;

function bits(matrix: ArrayLike<number>): string {
  return Array.from(new Uint32Array(Float32Array.from(matrix).buffer)).join(",");
}

function studBits(page: InstancePage, bases: StudBasisTable): string[] {
  return Array.from({ length: page.instanceCount - page.partCount }, (_, s) => {
    const i = page.partCount + s;
    const color = studColorIndexOf(page.studBasisAndColorIndex[s] ?? 0);
    return `${page.shape[i]} ${color} ${bits(studMatrix(page, bases, i))}`;
  }).toSorted();
}

it("keeps each stud's exact transform bit for bit, through regrouping, with shared bases stored once", () => {
  const bases = new StudBasisTable();
  const page = pageOf(
    chunkOf(
      PARTS,
      EXACT_STUDS.map(({ stud }) => stud),
    ),
    LINEAR,
    COLOR_ALPHA_SLOT,
    bases,
  );
  const expected = EXACT_STUDS.map(
    ({ stud, expected: matrix }) => `${stud.shape} ${stud.colorIndex} ${bits(matrix)}`,
  ).toSorted();
  const basisIndices = new Set(Array.from(page.studBasisAndColorIndex, studBasisIndexOf));

  expect(studBits(page, bases)).toEqual(expected);
  expect(studBits(regroupedPage(page, LINEAR, RENUMBERED_COLOR_ALPHA_SLOT), bases)).toEqual(
    expected,
  );
  expect([basisIndices.size, bases.count]).toEqual([DISTINCT_EXACT_BASES, DISTINCT_EXACT_BASES]);
});

it("hands meshes views of the page rather than copies", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, new StudBasisTable());
  const matrices = matricesOf(page, 2, 5);
  const colors = linearColorsOf(page, 2, 5);
  const translations = studTranslationsOf(page, 6, 8);
  const basisAndColorIndex = studBasisAndColorIndexOf(page, 6, 8);

  expect([matrices.buffer, colors.buffer, translations.buffer, basisAndColorIndex.buffer]).toEqual([
    page.matrices.buffer,
    page.linearColors.buffer,
    page.studTranslations.buffer,
    page.studBasisAndColorIndex.buffer,
  ]);
  expect([matrices.byteOffset, matrices.length]).toEqual([2 * 16 * 4, 3 * 16]);
  expect([colors.byteOffset, colors.length]).toEqual([2 * 3 * 4, 3 * 3]);
  expect([translations.byteOffset, translations.length]).toEqual([1 * 3 * 4, 2 * 3]);
  expect([basisAndColorIndex.byteOffset, basisAndColorIndex.length]).toEqual([1 * 4, 2]);
});
