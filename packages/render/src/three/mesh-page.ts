import type { ChunkTier } from "../scene-backend.ts";
import {
  groupRunEnd,
  isMirrored,
  isNotUpright,
  isVoxelized,
  type InstancePage,
} from "./instance-page.ts";

export const MESH_KIND_BODY = 0;
export const MESH_KIND_FIXED = 1;
export const MESH_KIND_STUD = 2;

export interface PartGeometryCounts {
  readonly present: Uint8Array;
  readonly bodyCount: Uint8Array;
  readonly fixedCount: Uint16Array;
}

export interface LevelGeometryCounts {
  readonly parts: PartGeometryCounts;
  readonly studs: Uint8Array;
}

export interface MeshPage {
  readonly kind: Uint8Array;
  readonly shape: Uint16Array;
  readonly alphaSlot: Uint8Array;
  readonly geometryIndex: Uint16Array;
  readonly start: Uint32Array;
  readonly nearCount: Uint32Array;
  readonly shellCount: Uint32Array;
  readonly shellFromDetailed: Uint8Array;
  readonly shellAtFar: Uint8Array;
  readonly mirrored: Uint8Array;
}

export type ShownState = "near" | "shell" | "hidden";

export function shownStateOf(
  hasNear: boolean,
  hasShell: boolean,
  shellAtFar: boolean,
  tier: ChunkTier,
): ShownState {
  switch (tier) {
    case "near":
      return hasNear ? "near" : "hidden";
    case "mid":
      return hasShell ? "shell" : "hidden";
    case "far":
      return hasShell && shellAtFar ? "shell" : "hidden";
    default: {
      const unhandled: never = tier;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function emptyMeshPage(rows: number): MeshPage {
  return {
    kind: new Uint8Array(rows),
    shape: new Uint16Array(rows),
    alphaSlot: new Uint8Array(rows),
    geometryIndex: new Uint16Array(rows),
    start: new Uint32Array(rows),
    nearCount: new Uint32Array(rows),
    shellCount: new Uint32Array(rows),
    shellFromDetailed: new Uint8Array(rows),
    shellAtFar: new Uint8Array(rows),
    mirrored: new Uint8Array(rows),
  };
}

function bodyCountOf(level: LevelGeometryCounts, part: number): number {
  return (level.parts.present[part] ?? 0) === 0 ? 0 : (level.parts.bodyCount[part] ?? 0);
}

function fixedCountOf(level: LevelGeometryCounts, part: number): number {
  return (level.parts.present[part] ?? 0) === 0 ? 0 : (level.parts.fixedCount[part] ?? 0);
}

function shellFromDetailed(instanceClass: number, part: number, far: LevelGeometryCounts): boolean {
  return isNotUpright(instanceClass) || (far.parts.present[part] ?? 0) === 0;
}

class RowWriter {
  row = 0;

  constructor(private readonly out: MeshPage | undefined) {}

  write(
    kind: number,
    shape: number,
    alphaSlot: number,
    geometryIndex: number,
    start: number,
    nearCount: number,
    shellCount: number,
    fromDetailed: boolean,
    atFar: boolean,
    mirrored: boolean,
  ): void {
    const out = this.out;
    const row = this.row++;
    if (!out) return;
    out.kind[row] = kind;
    out.shape[row] = shape;
    out.alphaSlot[row] = alphaSlot;
    out.geometryIndex[row] = geometryIndex;
    out.start[row] = start;
    out.nearCount[row] = nearCount;
    out.shellCount[row] = shellCount;
    out.shellFromDetailed[row] = shellCount > 0 && fromDetailed ? 1 : 0;
    out.shellAtFar[row] = shellCount > 0 && atFar ? 1 : 0;
    out.mirrored[row] = mirrored ? 1 : 0;
  }
}

function writePartRows(
  page: InstancePage,
  detailed: LevelGeometryCounts,
  far: LevelGeometryCounts | undefined,
  rows: RowWriter,
): void {
  const runs = page.partRuns;
  let first = 0;
  while (first < runs.shape.length) {
    const next = groupRunEnd(runs, first);
    const part = runs.shape[first] ?? 0;
    const alphaSlot = runs.alphaSlot[first] ?? 0;
    const groupStart = runs.start[first] ?? 0;
    const groupSize = (runs.end[next - 1] ?? 0) - groupStart;
    const mirrored = isMirrored(runs.instanceClass[first] ?? 0);
    const nearBodyCount = bodyCountOf(detailed, part);
    const nearFixedCount = fixedCountOf(detailed, part);
    for (let run = first; run < next; run++) {
      const instanceClass = runs.instanceClass[run] ?? 0;
      const runStart = runs.start[run] ?? 0;
      const runSize = (runs.end[run] ?? 0) - runStart;
      const fromDetailed = far !== undefined && shellFromDetailed(instanceClass, part, far);
      const shellLevel = fromDetailed ? detailed : far;
      const shellBodyCount = shellLevel ? bodyCountOf(shellLevel, part) : 0;
      const shellFixedCount = shellLevel ? fixedCountOf(shellLevel, part) : 0;
      const atFar = !isVoxelized(instanceClass);
      const pairsWithNear = run === first;
      const bodyRows = pairsWithNear ? Math.max(nearBodyCount, shellBodyCount) : shellBodyCount;
      const fixedRows = pairsWithNear ? Math.max(nearFixedCount, shellFixedCount) : shellFixedCount;
      const start = pairsWithNear ? groupStart : runStart;
      for (let b = 0; b < bodyRows; b++) {
        const near = pairsWithNear && b < nearBodyCount ? groupSize : 0;
        const shell = b < shellBodyCount ? runSize : 0;
        rows.write(
          MESH_KIND_BODY,
          part,
          alphaSlot,
          0,
          start,
          near,
          shell,
          fromDetailed,
          atFar,
          mirrored,
        );
      }
      for (let f = 0; f < fixedRows; f++) {
        const near = pairsWithNear && f < nearFixedCount ? groupSize : 0;
        const shell = f < shellFixedCount ? runSize : 0;
        rows.write(
          MESH_KIND_FIXED,
          part,
          alphaSlot,
          f,
          start,
          near,
          shell,
          fromDetailed,
          atFar,
          mirrored,
        );
      }
    }
    first = next;
  }
}

function writeStudRows(
  page: InstancePage,
  detailed: LevelGeometryCounts,
  far: LevelGeometryCounts | undefined,
  rows: RowWriter,
): void {
  const studs = page.studRuns;
  for (let run = 0; run < studs.shape.length; run++) {
    const primitive = studs.shape[run] ?? 0;
    if ((detailed.studs[primitive] ?? 0) === 0) continue;
    const start = studs.start[run] ?? 0;
    const size = (studs.end[run] ?? 0) - start;
    const shell = far && (far.studs[primitive] ?? 0) !== 0 ? size : 0;
    const alphaSlot = studs.alphaSlot[run] ?? 0;
    const mirrored = isMirrored(studs.instanceClass[run] ?? 0);
    rows.write(MESH_KIND_STUD, primitive, alphaSlot, 0, start, size, shell, false, false, mirrored);
  }
}

function writeRows(
  page: InstancePage,
  detailed: LevelGeometryCounts,
  far: LevelGeometryCounts | undefined,
  out: MeshPage | undefined,
): number {
  const rows = new RowWriter(out);
  writePartRows(page, detailed, far, rows);
  writeStudRows(page, detailed, far, rows);
  return rows.row;
}

export function meshPageOf(
  page: InstancePage,
  detailed: LevelGeometryCounts,
  far: LevelGeometryCounts | undefined,
): MeshPage {
  const result = emptyMeshPage(writeRows(page, detailed, far, undefined));
  writeRows(page, detailed, far, result);
  return result;
}
