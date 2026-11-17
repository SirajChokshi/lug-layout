import type { PartBundle, PartModel } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { BOX_FLOATS } from "../edit/local-box.ts";

export interface PlanBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export function instanceBoxes(model: PartModel, bundle: PartBundle): Float64Array {
  const out = new Float64Array(model.instanceCount * BOX_FLOATS);
  const m = model.matrices;
  for (let i = 0; i < model.instanceCount; i++) {
    const part = bundle.parts[model.partIndex[i] ?? 0];
    const o = i * INSTANCE_MATRIX_FLOATS;
    const b = i * BOX_FLOATS;
    for (let axis = 0; axis < 3; axis++) {
      out[b + axis] = Number.POSITIVE_INFINITY;
      out[b + 3 + axis] = Number.NEGATIVE_INFINITY;
    }
    if (!part) continue;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? part.boundsMax[0] : part.boundsMin[0];
      const y = corner & 2 ? part.boundsMax[1] : part.boundsMin[1];
      const z = corner & 4 ? part.boundsMax[2] : part.boundsMin[2];
      for (let axis = 0; axis < 3; axis++) {
        const r = o + axis * 4;
        const value = (m[r] ?? 0) * x + (m[r + 1] ?? 0) * y + (m[r + 2] ?? 0) * z + (m[r + 3] ?? 0);
        out[b + axis] = Math.min(out[b + axis] ?? 0, value);
        out[b + 3 + axis] = Math.max(out[b + 3 + axis] ?? 0, value);
      }
    }
  }
  return out;
}

export function planBox(boxes: Float64Array, instance: number): PlanBox | null {
  const o = instance * BOX_FLOATS;
  if (o + BOX_FLOATS > boxes.length) return null;
  const box = {
    minX: boxes[o] ?? Number.POSITIVE_INFINITY,
    maxX: boxes[o + 3] ?? Number.NEGATIVE_INFINITY,
    minZ: boxes[o + 2] ?? Number.POSITIVE_INFINITY,
    maxZ: boxes[o + 5] ?? Number.NEGATIVE_INFINITY,
  };
  return box.minX <= box.maxX && box.minZ <= box.maxZ ? box : null;
}

export function unionBox(boxes: ReadonlyArray<PlanBox>): PlanBox | null {
  if (boxes.length === 0) return null;
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    minZ: Math.min(...boxes.map((b) => b.minZ)),
    maxZ: Math.max(...boxes.map((b) => b.maxZ)),
  };
}

export function distanceOutside(box: PlanBox, x: number, z: number): number {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dz = Math.max(box.minZ - z, 0, z - box.maxZ);
  return Math.hypot(dx, dz);
}
