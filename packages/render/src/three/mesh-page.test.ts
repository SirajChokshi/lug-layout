import { expect, it } from "vitest";
import type { ChunkInstances, ChunkTier } from "../scene-backend.ts";
import { pageOf } from "./instance-page.ts";
import {
  MESH_KIND_BODY,
  MESH_KIND_FIXED,
  MESH_KIND_STUD,
  meshPageOf,
  shownStateOf,
  type LevelGeometryCounts,
  type MeshPage,
} from "./mesh-page.ts";
import { StudBasisTable } from "./stud-basis-table.ts";

const LINEAR = Float32Array.of(0.5, 0.5, 0.5);
const COLOR_ALPHA_SLOT = Uint8Array.of(0);
const UPRIGHT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TILTED = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];

interface Placed {
  readonly part: number;
  readonly voxelized: number;
  readonly matrix: ReadonlyArray<number>;
}

const PARTS: ReadonlyArray<Placed> = [
  { part: 0, voxelized: 0, matrix: UPRIGHT },
  { part: 1, voxelized: 1, matrix: UPRIGHT },
  { part: 2, voxelized: 0, matrix: TILTED },
  { part: 3, voxelized: 0, matrix: UPRIGHT },
  { part: 4, voxelized: 0, matrix: UPRIGHT },
  { part: 4, voxelized: 0, matrix: TILTED },
  { part: 4, voxelized: 1, matrix: UPRIGHT },
  { part: 5, voxelized: 0, matrix: UPRIGHT },
];
const STUD_PRIMITIVES = [0, 1];

function chunk(): ChunkInstances {
  return {
    originX: 0,
    originZ: 0,
    count: PARTS.length,
    partIndex: Uint16Array.from(PARTS.map((p) => p.part)),
    colorIndex: new Uint16Array(PARTS.length),
    voxelized: Uint8Array.from(PARTS.map((p) => p.voxelized)),
    matrices: Float32Array.from(PARTS.flatMap((p) => p.matrix)),
    studs: {
      count: STUD_PRIMITIVES.length,
      primitiveIndex: Uint8Array.from(STUD_PRIMITIVES),
      colorIndex: new Uint16Array(STUD_PRIMITIVES.length),
      matrices: Float32Array.from(STUD_PRIMITIVES.flatMap(() => UPRIGHT)),
    },
  };
}

function level(
  present: ReadonlyArray<number>,
  bodyCount: ReadonlyArray<number>,
  fixedCount: ReadonlyArray<number>,
  studs: ReadonlyArray<number>,
): LevelGeometryCounts {
  return {
    parts: {
      present: Uint8Array.from(present),
      bodyCount: Uint8Array.from(bodyCount),
      fixedCount: Uint16Array.from(fixedCount),
    },
    studs: Uint8Array.from(studs),
  };
}

const DETAILED = level([1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1], [0, 0, 1, 0, 1, 2], [1, 1]);
const FAR = level([1, 1, 1, 0, 1, 1], [1, 1, 1, 0, 1, 0], [0, 0, 0, 0, 2, 1], [1]);

const B = MESH_KIND_BODY;
const F = MESH_KIND_FIXED;
const S = MESH_KIND_STUD;

function rowsOf(meshes: MeshPage): number[][] {
  return Array.from(meshes.kind, (kind, row) => [
    kind,
    meshes.shape[row] ?? 0,
    meshes.alphaSlot[row] ?? 0,
    meshes.geometryIndex[row] ?? 0,
    meshes.start[row] ?? 0,
    meshes.nearCount[row] ?? 0,
    meshes.shellCount[row] ?? 0,
    meshes.shellFromDetailed[row] ?? 0,
    meshes.shellAtFar[row] ?? 0,
  ]);
}

it("pairs each group's near geometry with its first run's shell, and gives later runs shell-only rows", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, new StudBasisTable());

  expect(rowsOf(meshPageOf(page, DETAILED, FAR))).toEqual([
    [B, 0, 0, 0, 0, 1, 1, 0, 1],
    [B, 1, 0, 0, 1, 1, 1, 0, 0],
    [B, 2, 0, 0, 2, 1, 1, 1, 1],
    [F, 2, 0, 0, 2, 1, 1, 1, 1],
    [B, 3, 0, 0, 3, 1, 1, 1, 1],
    [B, 4, 0, 0, 4, 3, 1, 0, 1],
    [F, 4, 0, 0, 4, 3, 1, 0, 1],
    [F, 4, 0, 1, 4, 0, 1, 0, 1],
    [B, 4, 0, 0, 5, 0, 1, 1, 1],
    [F, 4, 0, 0, 5, 0, 1, 1, 1],
    [B, 4, 0, 0, 6, 0, 1, 0, 0],
    [F, 4, 0, 0, 6, 0, 1, 0, 0],
    [F, 4, 0, 1, 6, 0, 1, 0, 0],
    [B, 5, 0, 0, 7, 1, 0, 0, 0],
    [F, 5, 0, 0, 7, 1, 1, 0, 1],
    [F, 5, 0, 1, 7, 1, 0, 0, 0],
    [S, 0, 0, 0, 8, 1, 1, 0, 0],
    [S, 1, 0, 0, 9, 1, 0, 0, 0],
  ]);
});

it("gives a page without a far level one near row per group and geometry, and no shells", () => {
  const page = pageOf(chunk(), LINEAR, COLOR_ALPHA_SLOT, new StudBasisTable());

  expect(rowsOf(meshPageOf(page, DETAILED, undefined))).toEqual([
    [B, 0, 0, 0, 0, 1, 0, 0, 0],
    [B, 1, 0, 0, 1, 1, 0, 0, 0],
    [B, 2, 0, 0, 2, 1, 0, 0, 0],
    [F, 2, 0, 0, 2, 1, 0, 0, 0],
    [B, 3, 0, 0, 3, 1, 0, 0, 0],
    [B, 4, 0, 0, 4, 3, 0, 0, 0],
    [F, 4, 0, 0, 4, 3, 0, 0, 0],
    [B, 5, 0, 0, 7, 1, 0, 0, 0],
    [F, 5, 0, 0, 7, 1, 0, 0, 0],
    [F, 5, 0, 1, 7, 1, 0, 0, 0],
    [S, 0, 0, 0, 8, 1, 0, 0, 0],
    [S, 1, 0, 0, 9, 1, 0, 0, 0],
  ]);
});

it("shows the near state at near, the shell at mid, and only shells drawn at far at far", () => {
  const tiers: ReadonlyArray<ChunkTier> = ["near", "mid", "far"];
  const rows = [
    [true, true, true],
    [true, true, false],
    [true, false, false],
    [false, true, true],
    [false, true, false],
  ] as const;

  expect(
    rows.map(([hasNear, hasShell, shellAtFar]) =>
      tiers.map((tier) => shownStateOf(hasNear, hasShell, shellAtFar, tier)),
    ),
  ).toEqual([
    ["near", "shell", "shell"],
    ["near", "shell", "hidden"],
    ["near", "hidden", "hidden"],
    ["hidden", "shell", "shell"],
    ["hidden", "shell", "hidden"],
  ]);
});
