import type { PartAsset, PartModel } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { VehicleSpec } from "@brr/sim";

const WHEELSET_PARTS: ReadonlySet<string> = new Set(["ldraw:2878c01"]);

export interface ModelVehicle {
  readonly spec: VehicleSpec;
  readonly matrices: Float32Array;
  readonly wheelsets: number;
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

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function vehicleFromModel(model: PartModel, parts: ReadonlyArray<PartAsset>): ModelVehicle {
  const body = emptyBox();
  const wheels = emptyBox();
  const axleX: number[] = [];
  const axleZ: number[] = [];
  for (let i = 0; i < model.instanceCount; i++) {
    const part = parts[model.partIndex[i] ?? 0];
    if (!part) continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    includeInstance(body, part, model.matrices, o);
    if (!WHEELSET_PARTS.has(part.id)) continue;
    const axle = emptyBox();
    includeInstance(axle, part, model.matrices, o);
    includeInstance(wheels, part, model.matrices, o);
    axleX.push((axle.minX + axle.maxX) / 2);
    axleZ.push((axle.minZ + axle.maxZ) / 2);
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
  const matrices = Float32Array.from(model.matrices);
  for (let i = 0; i < model.instanceCount; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    matrices[o + 3] = (model.matrices[o + 3] ?? 0) - pivotX;
    matrices[o + 7] = (model.matrices[o + 7] ?? 0) - wheels.minY;
    matrices[o + 11] = (model.matrices[o + 11] ?? 0) - pivotZ;
  }
  return {
    spec: {
      lengthLdu: body.maxX - body.minX,
      frontBogieLdu: body.maxX - frontX,
      rearBogieLdu: body.maxX - rearX,
    },
    matrices,
    wheelsets: axleX.length,
  };
}
