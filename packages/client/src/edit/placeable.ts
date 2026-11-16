import type { ModelLattice, PartAsset, PartModel, Vec3Tuple } from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, type StudInstances } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { withStuds } from "../scene/stud-stream.ts";
import type { ColorTable, ModelCredit } from "../scene/viewer-scene.ts";

export type PlaceableKind = "baseplate" | "model";

export interface LocalBox {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

export interface Placeable {
  readonly id: string;
  readonly label: string;
  readonly kind: PlaceableKind;
  readonly worldColor: number;
  readonly parts: ChunkPartInstances;
  readonly studs: StudInstances;
  readonly box: LocalBox;
  readonly partBoxes: Float32Array;
  readonly frameShift: Vec3Tuple;
  readonly credit: ModelCredit | null;
}

const HALF_STUD_LDU = STUD_LDU / 2;
export const BOX_FLOATS = 6;

function instanceBoxes(
  instances: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
): Float32Array {
  const boxes = new Float32Array(instances.count * BOX_FLOATS);
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (!part) continue;
    const m = instances.matrices;
    const o = i * INSTANCE_MATRIX_FLOATS;
    const b = i * BOX_FLOATS;
    for (let axis = 0; axis < 3; axis++) {
      let lo = m[o + axis * 4 + 3] ?? 0;
      let hi = lo;
      for (let k = 0; k < 3; k++) {
        const coefficient = m[o + axis * 4 + k] ?? 0;
        const a = coefficient * (part.boundsMin[k] ?? 0);
        const c = coefficient * (part.boundsMax[k] ?? 0);
        lo += Math.min(a, c);
        hi += Math.max(a, c);
      }
      boxes[b + axis] = lo;
      boxes[b + 3 + axis] = hi;
    }
  }
  return boxes;
}

export function phaseShift(phase: number): number {
  return HALF_STUD_LDU - phase;
}

export function pivotOnStudCorner(centre: number): number {
  return Math.round(centre / STUD_LDU) * STUD_LDU;
}

export function modelFrameShift(lattice: ModelLattice): Vec3Tuple {
  const shiftX = phaseShift(lattice.phaseX);
  const shiftZ = phaseShift(lattice.phaseZ);
  const centreX = (lattice.aabbMin[0] + lattice.aabbMax[0]) / 2 + shiftX;
  const centreZ = (lattice.aabbMin[2] + lattice.aabbMax[2]) / 2 + shiftZ;
  return [
    shiftX - pivotOnStudCorner(centreX),
    -lattice.aabbMin[1],
    shiftZ - pivotOnStudCorner(centreZ),
  ];
}

function shifted(matrices: Float32Array, count: number, shift: Vec3Tuple): Float32Array {
  const out = Float32Array.from(matrices);
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    out[o + 3] = (out[o + 3] ?? 0) + shift[0];
    out[o + 7] = (out[o + 7] ?? 0) + shift[1];
    out[o + 11] = (out[o + 11] ?? 0) + shift[2];
  }
  return out;
}

function shiftedBox(min: Vec3Tuple, max: Vec3Tuple, shift: Vec3Tuple): LocalBox {
  return {
    min: [min[0] + shift[0], min[1] + shift[1], min[2] + shift[2]],
    max: [max[0] + shift[0], max[1] + shift[1], max[2] + shift[2]],
  };
}

export function modelPlaceable(
  name: string,
  model: PartModel,
  credit: ModelCredit,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
): Placeable {
  const { lattice } = model;
  if (lattice === null) {
    throw new Error(`model ${name} has no stud lattice from the bake, so it cannot be placed`);
  }
  const shift = modelFrameShift(lattice);
  const colorIndex = new Uint16Array(model.instanceCount);
  for (let i = 0; i < model.instanceCount; i++) {
    colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
  }
  const local: ChunkPartInstances = {
    originX: 0,
    originZ: 0,
    count: model.instanceCount,
    partIndex: model.partIndex,
    colorIndex,
    matrices: shifted(model.matrices, model.instanceCount, shift),
  };
  return {
    id: `omr:${name}`,
    label: name,
    kind: "model",
    worldColor: 0,
    parts: local,
    studs: withStuds(local, parts, colors, undefined).studs,
    box: shiftedBox(lattice.aabbMin, lattice.aabbMax, shift),
    partBoxes: instanceBoxes(local, parts),
    frameShift: shift,
    credit,
  };
}

const IDENTITY_MATRIX = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

export function baseplatePlaceable(
  part: PartAsset,
  partIndex: number,
  ldrawColor: number,
  parts: ReadonlyArray<PartAsset>,
  colors: ColorTable,
): Placeable {
  const local: ChunkPartInstances = {
    originX: 0,
    originZ: 0,
    count: 1,
    partIndex: Uint16Array.of(partIndex),
    colorIndex: Uint16Array.of(colors.indexOfCode(ldrawColor)),
    matrices: IDENTITY_MATRIX,
  };
  const noShift: Vec3Tuple = [0, 0, 0];
  return {
    id: part.id,
    label: `${part.id.replace("ldraw:", "")} baseplate 32×32`,
    kind: "baseplate",
    worldColor: ldrawColor,
    parts: local,
    studs: withStuds(local, parts, colors, undefined).studs,
    box: shiftedBox(part.boundsMin, part.boundsMax, noShift),
    partBoxes: instanceBoxes(local, parts),
    frameShift: noShift,
    credit: null,
  };
}
