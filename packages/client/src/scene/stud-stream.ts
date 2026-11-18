import { INHERIT_COLOR, type ModelStudCover, type PartShapeAsset } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS, type ChunkInstances, type StudInstances } from "@brr/render";
import type { ChunkPartInstances } from "./placements.ts";
import type { ColorTable } from "./viewer-scene.ts";

interface PartInstances {
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly matrices: Float32Array;
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
  parts: ReadonlyArray<PartShapeAsset>,
  colors: ColorTable,
  bakedCover?: ModelStudCover,
): ChunkInstances {
  return { ...base, studs: studStream(parts, colors, base, bakedCover) };
}

const BITS_PER_WORD = 32;

export function bakedVisible(cover: ModelStudCover | undefined, stud: number): boolean {
  if (!cover) return true;
  return (((cover.visibleBits[stud >>> 5] ?? 0) >>> (stud & (BITS_PER_WORD - 1))) & 1) === 1;
}

function studStream(
  parts: ReadonlyArray<PartShapeAsset>,
  colors: ColorTable,
  instances: PartInstances,
  bakedCover: ModelStudCover | undefined,
): StudInstances {
  let totalStuds = 0;
  for (let i = 0; i < instances.count; i++) {
    totalStuds += parts[instances.partIndex[i] ?? 0]?.studPrimitiveIndex.length ?? 0;
  }
  if (bakedCover && bakedCover.studs !== totalStuds) {
    throw new Error(
      `the bake's stud cover lists ${bakedCover.studs} studs but the model's parts have ${totalStuds}`,
    );
  }
  let stud = 0;
  const primitiveIndex = new Uint8Array(totalStuds);
  const colorIndex = new Uint16Array(totalStuds);
  const matrices = new Float32Array(totalStuds * INSTANCE_MATRIX_FLOATS);
  let count = 0;
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (!part) continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (let s = 0; s < part.studPrimitiveIndex.length; s++, stud++) {
      if (!bakedVisible(bakedCover, stud)) continue;
      const t = count * INSTANCE_MATRIX_FLOATS;
      composeInto(
        instances.matrices,
        o,
        part.studMatrices,
        s * INSTANCE_MATRIX_FLOATS,
        matrices,
        t,
      );
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
