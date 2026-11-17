import { INHERIT_COLOR, type PartAsset } from "@brr/catalog";
import type { PartRole } from "@brr/schema/bundle";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type StudInstances } from "@brr/render";
import { STUD_LDU } from "@brr/math";
import type { ChunkPartInstances } from "./placements.ts";
import type { ColorTable } from "./viewer-scene.ts";

interface PartInstances {
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
}

const HALF_STUD_LDU = STUD_LDU / 2;
const Y_KEY_OFFSET = 1 << 15;
const CELL_KEY_OFFSET = 1 << 11;
const CELL_KEY_STRIDE = 1 << 12;

function cellKey(cellX: number, cellZ: number, yLdu: number): number {
  return (
    ((yLdu + Y_KEY_OFFSET) * CELL_KEY_STRIDE + (cellX + CELL_KEY_OFFSET)) * CELL_KEY_STRIDE +
    (cellZ + CELL_KEY_OFFSET)
  );
}

function studCell(coordinate: number): number {
  return Math.floor(coordinate / STUD_LDU);
}

function firstStudCellInside(min: number): number {
  return Math.floor((min - HALF_STUD_LDU) / STUD_LDU) + 1;
}

function lastStudCellInside(max: number): number {
  return Math.ceil((max - HALF_STUD_LDU) / STUD_LDU) - 1;
}

class CoveredStuds {
  private readonly bottoms = new Set<number>();

  constructor(
    parts: ReadonlyArray<PartAsset>,
    instances: PartInstances,
    coveringRoles: ReadonlySet<PartRole>,
  ) {
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? 0];
      if (!part || !coveringRoles.has(part.role)) continue;
      const o = i * INSTANCE_MATRIX_FLOATS;
      const m = instances.matrices;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (const bx of [part.boundsMin[0], part.boundsMax[0]]) {
        for (const bz of [part.boundsMin[2], part.boundsMax[2]]) {
          const x = (m[o] ?? 0) * bx + (m[o + 2] ?? 0) * bz + (m[o + 3] ?? 0);
          const z = (m[o + 8] ?? 0) * bx + (m[o + 10] ?? 0) * bz + (m[o + 11] ?? 0);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
      const bottom = Math.round((m[o + 7] ?? 0) + part.boundsMin[1]);
      const lastX = lastStudCellInside(maxX);
      const lastZ = lastStudCellInside(maxZ);
      for (let cx = firstStudCellInside(minX); cx <= lastX; cx++) {
        for (let cz = firstStudCellInside(minZ); cz <= lastZ; cz++) {
          this.bottoms.add(cellKey(cx, cz, bottom));
        }
      }
    }
  }

  covers(x: number, y: number, z: number): boolean {
    return this.bottoms.has(cellKey(studCell(x), studCell(z), Math.round(y)));
  }
}

function composeInto(
  outer: Float32Array,
  o: number,
  inner: Float32Array,
  n: number,
  target: Float32Array,
  t: number,
): void {
  for (let row = 0; row < 3; row++) {
    const a0 = outer[o + row * 4] ?? 0;
    const a1 = outer[o + row * 4 + 1] ?? 0;
    const a2 = outer[o + row * 4 + 2] ?? 0;
    const a3 = outer[o + row * 4 + 3] ?? 0;
    for (let col = 0; col < 4; col++) {
      target[t + row * 4 + col] =
        a0 * (inner[n + col] ?? 0) +
        a1 * (inner[n + 4 + col] ?? 0) +
        a2 * (inner[n + 8 + col] ?? 0) +
        (col === 3 ? a3 : 0);
    }
  }
}

export function withStuds(
  base: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
  coveringRoles: ReadonlySet<PartRole> | undefined,
): ChunkInstances {
  const covered = coveringRoles ? new CoveredStuds(parts, base, coveringRoles) : undefined;
  return { ...base, studs: studStream(parts, colors, base, covered) };
}

function studStream(
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
  instances: PartInstances,
  covered: CoveredStuds | undefined,
): StudInstances {
  let totalStuds = 0;
  for (let i = 0; i < instances.count; i++) {
    totalStuds += parts[instances.partIndex[i] ?? 0]?.studPrimitiveIndex.length ?? 0;
  }
  const primitiveIndex = new Uint8Array(totalStuds);
  const colorIndex = new Uint16Array(totalStuds);
  const matrices = new Float32Array(totalStuds * INSTANCE_MATRIX_FLOATS);
  let count = 0;
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (!part) continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
      const t = count * INSTANCE_MATRIX_FLOATS;
      composeInto(
        instances.matrices,
        o,
        part.studMatrices,
        s * INSTANCE_MATRIX_FLOATS,
        matrices,
        t,
      );
      if (covered?.covers(matrices[t + 3] ?? 0, matrices[t + 7] ?? 0, matrices[t + 11] ?? 0)) {
        continue;
      }
      const code = part.studColors[s] ?? INHERIT_COLOR;
      primitiveIndex[count] = part.studPrimitiveIndex[s] ?? 0;
      colorIndex[count] =
        code === INHERIT_COLOR ? (instances.colorIndex[i] ?? 0) : colors.indexOfCode(code);
      count++;
    }
  }
  return {
    count,
    primitiveIndex: primitiveIndex.slice(0, count),
    colorIndex: colorIndex.slice(0, count),
    matrices: matrices.slice(0, count * INSTANCE_MATRIX_FLOATS),
  };
}
