import type { PartModel, PartShapeAsset } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { BOX_FLOATS } from "../edit/local-box.ts";

export function instanceBoxes(
  model: PartModel,
  bundle: { readonly parts: ReadonlyArray<PartShapeAsset> },
): Float64Array {
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
