import type { PartAsset, PartModel } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { VehicleSpec } from "@brr/sim";

const WHEELSET_PARTS: ReadonlySet<string> = new Set(["ldraw:2878c01"]);

export interface ModelVehicle {
  readonly spec: VehicleSpec;
  readonly instances: Uint32Array;
  readonly matrices: Float32Array;
  readonly wheelsets: number;
  readonly excludedInstances: number;
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function emptyBox(): Box {
  return {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function includeInstance(box: Box, part: PartAsset, m: Float32Array, o: number): void {
  for (const bx of [part.boundsMin[0], part.boundsMax[0]]) {
    for (const by of [part.boundsMin[1], part.boundsMax[1]]) {
      for (const bz of [part.boundsMin[2], part.boundsMax[2]]) {
        const x = (m[o] ?? 0) * bx + (m[o + 1] ?? 0) * by + (m[o + 2] ?? 0) * bz + (m[o + 3] ?? 0);
        const y =
          (m[o + 4] ?? 0) * bx + (m[o + 5] ?? 0) * by + (m[o + 6] ?? 0) * bz + (m[o + 7] ?? 0);
        const z =
          (m[o + 8] ?? 0) * bx + (m[o + 9] ?? 0) * by + (m[o + 10] ?? 0) * bz + (m[o + 11] ?? 0);
        box.minX = Math.min(box.minX, x);
        box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y);
        box.maxY = Math.max(box.maxY, y);
        box.minZ = Math.min(box.minZ, z);
        box.maxZ = Math.max(box.maxZ, z);
      }
    }
  }
}

const TOUCH_TOLERANCE_LDU = 0.01;
const BOX_FLOATS = 6;

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function instanceBoxes(model: PartModel, parts: ReadonlyArray<PartAsset>): Float64Array {
  const boxes = new Float64Array(model.instanceCount * BOX_FLOATS);
  for (let i = 0; i < model.instanceCount; i++) {
    const part = parts[model.partIndex[i] ?? 0];
    if (!part) throw new Error(`model instance ${i} has no part`);
    const box = emptyBox();
    includeInstance(box, part, model.matrices, i * INSTANCE_MATRIX_FLOATS);
    boxes.set([box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ], i * BOX_FLOATS);
  }
  return boxes;
}

function touching(boxes: Float64Array, a: number, b: number): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const aMin = boxes[a * BOX_FLOATS + axis * 2] ?? 0;
    const aMax = boxes[a * BOX_FLOATS + axis * 2 + 1] ?? 0;
    const bMin = boxes[b * BOX_FLOATS + axis * 2] ?? 0;
    const bMax = boxes[b * BOX_FLOATS + axis * 2 + 1] ?? 0;
    if (aMin > bMax + TOUCH_TOLERANCE_LDU || bMin > aMax + TOUCH_TOLERANCE_LDU) return false;
  }
  return true;
}

function touchingGroups(boxes: Float64Array, count: number): Int32Array {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while ((parent[r] ?? r) !== r) r = parent[r] ?? r;
    return r;
  };
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      if (touching(boxes, a, b)) parent[root(a)] = root(b);
    }
  }
  return Int32Array.from({ length: count }, (_, i) => root(i));
}

export function vehicleFromModel(model: PartModel, parts: ReadonlyArray<PartAsset>): ModelVehicle {
  const boxes = instanceBoxes(model, parts);
  const groups = touchingGroups(boxes, model.instanceCount);
  const wheelGroups = new Set<number>();
  for (let i = 0; i < model.instanceCount; i++) {
    if (WHEELSET_PARTS.has(parts[model.partIndex[i] ?? 0]?.id ?? ""))
      wheelGroups.add(groups[i] ?? i);
  }
  const kept: number[] = [];
  for (let i = 0; i < model.instanceCount; i++) {
    if (wheelGroups.has(groups[i] ?? i)) kept.push(i);
  }
  const body = emptyBox();
  const wheels = emptyBox();
  const axleX: number[] = [];
  const axleZ: number[] = [];
  for (const i of kept) {
    const o = i * BOX_FLOATS;
    const minX = boxes[o] ?? 0;
    const maxX = boxes[o + 1] ?? 0;
    const minZ = boxes[o + 4] ?? 0;
    const maxZ = boxes[o + 5] ?? 0;
    body.minX = Math.min(body.minX, minX);
    body.maxX = Math.max(body.maxX, maxX);
    body.minZ = Math.min(body.minZ, minZ);
    body.maxZ = Math.max(body.maxZ, maxZ);
    if (!WHEELSET_PARTS.has(parts[model.partIndex[i] ?? 0]?.id ?? "")) continue;
    wheels.minY = Math.min(wheels.minY, boxes[o + 2] ?? 0);
    axleX.push((minX + maxX) / 2);
    axleZ.push((minZ + maxZ) / 2);
  }
  if (body.maxX - body.minX <= body.maxZ - body.minZ) {
    throw new Error("the model's long axis is not x, so it cannot run as a vehicle");
  }
  const centreX = (body.minX + body.maxX) / 2;
  const front = axleX.filter((x) => x > centreX);
  const rear = axleX.filter((x) => x < centreX);
  if (front.length === 0 || rear.length === 0) {
    throw new Error(`the model has ${axleX.length} wheelsets, not a front and a rear bogie`);
  }
  const frontX = mean(front);
  const rearX = mean(rear);
  const pivotX = (frontX + rearX) / 2;
  const pivotZ = mean(axleZ);
  const matrices = new Float32Array(kept.length * INSTANCE_MATRIX_FLOATS);
  kept.forEach((i, slot) => {
    const from = i * INSTANCE_MATRIX_FLOATS;
    const to = slot * INSTANCE_MATRIX_FLOATS;
    matrices.set(model.matrices.subarray(from, from + INSTANCE_MATRIX_FLOATS), to);
    matrices[to + 3] = (model.matrices[from + 3] ?? 0) - pivotX;
    matrices[to + 7] = (model.matrices[from + 7] ?? 0) - wheels.minY;
    matrices[to + 11] = (model.matrices[from + 11] ?? 0) - pivotZ;
  });
  return {
    spec: {
      lengthLdu: body.maxX - body.minX,
      frontBogieLdu: body.maxX - frontX,
      rearBogieLdu: body.maxX - rearX,
    },
    instances: Uint32Array.from(kept),
    matrices,
    wheelsets: axleX.length,
    excludedInstances: model.instanceCount - kept.length,
  };
}
