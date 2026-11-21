import type { PartModel, PartShapeAsset, PartVehicle, StudPrimitiveAsset } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { BOX_FLOATS } from "../edit/local-box.ts";

const POSITION_FLOATS = 3;
const MATRIX_ROW_FLOATS = 4;
const BOX_CORNERS = 8;
const TOP = 4;
const NO_STUD_BOXES: ReadonlyArray<Float64Array> = [];

export interface PlanBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function emptyBox(out: Float64Array, at: number): void {
  out.fill(Number.POSITIVE_INFINITY, at, at + 3);
  out.fill(Number.NEGATIVE_INFINITY, at + 3, at + BOX_FLOATS);
}

function growByCorners(
  out: Float64Array,
  at: number,
  local: ArrayLike<number>,
  m: ArrayLike<number>,
  o: number,
): void {
  for (let corner = 0; corner < BOX_CORNERS; corner++) {
    const x = corner & 1 ? (local[3] ?? 0) : (local[0] ?? 0);
    const y = corner & 2 ? (local[4] ?? 0) : (local[1] ?? 0);
    const z = corner & 4 ? (local[5] ?? 0) : (local[2] ?? 0);
    for (let axis = 0; axis < 3; axis++) {
      const r = o + axis * MATRIX_ROW_FLOATS;
      const value = (m[r] ?? 0) * x + (m[r + 1] ?? 0) * y + (m[r + 2] ?? 0) * z + (m[r + 3] ?? 0);
      out[at + axis] = Math.min(out[at + axis] ?? 0, value);
      out[at + 3 + axis] = Math.max(out[at + 3 + axis] ?? 0, value);
    }
  }
}

const IDENTITY_ROWS = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

function partBox(part: PartShapeAsset, studBoxes: ReadonlyArray<Float64Array>): Float64Array {
  const box = new Float64Array(BOX_FLOATS);
  emptyBox(box, 0);
  growByCorners(box, 0, Float64Array.of(...part.boundsMin, ...part.boundsMax), IDENTITY_ROWS, 0);
  for (let stud = 0; stud < part.studPrimitiveIndex.length; stud++) {
    const primitive = studBoxes[part.studPrimitiveIndex[stud] ?? 0];
    if (primitive)
      growByCorners(box, 0, primitive, part.studMatrices, stud * INSTANCE_MATRIX_FLOATS);
  }
  return box;
}

export function studPrimitiveBoxes(
  primitives: ReadonlyArray<StudPrimitiveAsset>,
): ReadonlyArray<Float64Array> {
  return primitives.map(({ mesh }) => {
    const box = new Float64Array(BOX_FLOATS);
    emptyBox(box, 0);
    const { positions } = mesh;
    for (let i = 0; i < positions.length; i += POSITION_FLOATS) {
      for (let axis = 0; axis < POSITION_FLOATS; axis++) {
        const value = positions[i + axis] ?? 0;
        box[axis] = Math.min(box[axis] ?? 0, value);
        box[3 + axis] = Math.max(box[3 + axis] ?? 0, value);
      }
    }
    return box;
  });
}

export function instanceBoxes(
  model: Omit<PartModel, "studCover">,
  bundle: { readonly parts: ReadonlyArray<PartShapeAsset> },
  studBoxes: ReadonlyArray<Float64Array> = NO_STUD_BOXES,
): Float64Array {
  const out = new Float64Array(model.instanceCount * BOX_FLOATS);
  const local = new Map<number, Float64Array>();
  for (let i = 0; i < model.instanceCount; i++) {
    const partIndex = model.partIndex[i] ?? 0;
    const part = bundle.parts[partIndex];
    const b = i * BOX_FLOATS;
    emptyBox(out, b);
    if (!part) continue;
    let box = local.get(partIndex);
    if (!box) {
      box = partBox(part, studBoxes);
      local.set(partIndex, box);
    }
    growByCorners(out, b, box, model.matrices, i * INSTANCE_MATRIX_FLOATS);
  }
  return out;
}

export function vehicleTop(boxes: Float64Array, vehicle: PartVehicle): number {
  let top = Number.NEGATIVE_INFINITY;
  const reach = (instance: number): void => {
    top = Math.max(top, boxes[instance * BOX_FLOATS + TOP] ?? Number.NEGATIVE_INFINITY);
  };
  vehicle.body.forEach(reach);
  for (const bogie of vehicle.bogies) bogie.instances.forEach(reach);
  return top;
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
