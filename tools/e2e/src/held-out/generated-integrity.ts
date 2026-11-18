import type { ImportResult } from "@brr/import";
import type { Bundle } from "./bundle.ts";

const MATRIX_FLOATS = 12;
const AXES = 3;
const BOX_FLOATS = 6;

function instanceBoxes(result: ImportResult, bundle: Bundle): Float64Array {
  const boxes = new Float64Array(result.instanceCount * BOX_FLOATS);
  for (let i = 0; i < result.instanceCount; i++) {
    const partId = result.partIds[result.partIndex[i] ?? 0] ?? "";
    const part = bundle.parts.get(partId);
    if (!part) throw new Error(`generated builds use bundle parts only, but ${partId} is not one`);
    const o = i * MATRIX_FLOATS;
    for (let axis = 0; axis < AXES; axis++) {
      let low = result.matrices[o + axis * 4 + 3] ?? 0;
      let high = low;
      for (let k = 0; k < AXES; k++) {
        const coefficient = result.matrices[o + axis * 4 + k] ?? 0;
        const a = coefficient * (part.bounds.min[k] ?? 0);
        const b = coefficient * (part.bounds.max[k] ?? 0);
        low += Math.min(a, b);
        high += Math.max(a, b);
      }
      boxes[i * BOX_FLOATS + axis] = low;
      boxes[i * BOX_FLOATS + AXES + axis] = high;
    }
  }
  return boxes;
}

export function overlappingPairs(result: ImportResult, bundle: Bundle): number {
  const boxes = instanceBoxes(result, bundle);
  let pairs = 0;
  for (let i = 0; i < result.instanceCount; i++) {
    for (let j = i + 1; j < result.instanceCount; j++) {
      let overlaps = true;
      for (let axis = 0; axis < AXES && overlaps; axis++) {
        const low = Math.max(boxes[i * BOX_FLOATS + axis] ?? 0, boxes[j * BOX_FLOATS + axis] ?? 0);
        const high = Math.min(
          boxes[i * BOX_FLOATS + AXES + axis] ?? 0,
          boxes[j * BOX_FLOATS + AXES + axis] ?? 0,
        );
        overlaps = high > low;
      }
      if (overlaps) pairs++;
    }
  }
  return pairs;
}
