import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { LatticePose } from "./candidate-poses.ts";
import { AXIS_NEG_Y, AXIS_POS_Y, axisDimension, axisSign } from "./connector-table.ts";

export const QUARTER_TURNS = 4;
const STUD_CENTRE_LDU = STUD_LDU / 2;
const AXIS_CODES = 6;
const X = 0;
const Z = 2;

export function checkPose(pose: LatticePose): void {
  if (!isRot90(pose.rot)) throw new RangeError(`rotation ${pose.rot} is not a quarter turn 0-3`);
  if (!Number.isInteger(pose.x) || !Number.isInteger(pose.z) || !Number.isInteger(pose.yPlates)) {
    throw new RangeError(`pose ${pose.x}, ${pose.z}, ${pose.yPlates} is not on integer LDU`);
  }
}

export function turnCos(rot: number): number {
  return isRot90(rot) ? rot90Cos(rot) : 1;
}

export function turnSin(rot: number): number {
  return isRot90(rot) ? rot90Sin(rot) : 0;
}

export function phaseOf(ldu: number): number {
  return ((ldu % STUD_LDU) + STUD_LDU) % STUD_LDU;
}

export function verticalSign(axis: number): number {
  if (axis === AXIS_POS_Y) return 1;
  return axis === AXIS_NEG_Y ? -1 : 0;
}

export function isStudCentre(x: number, z: number): boolean {
  return (x - STUD_CENTRE_LDU) % STUD_LDU === 0 && (z - STUD_CENTRE_LDU) % STUD_LDU === 0;
}

export function isLatticeStud(axis: number, x: number, z: number): boolean {
  return verticalSign(axis) !== 0 && isStudCentre(x, z);
}

function turnedAxis(code: number, rot: number): number {
  const turn = rot % QUARTER_TURNS;
  if (!isRot90(turn)) throw new RangeError(`rotation ${rot} is not a quarter turn 0-3`);
  const dimension = axisDimension(code);
  if (dimension !== X && dimension !== Z) return code;
  const sign = axisSign(code);
  const x = dimension === X ? sign : 0;
  const z = dimension === Z ? sign : 0;
  const tx = rot90Cos(turn) * x + rot90Sin(turn) * z;
  const tz = -rot90Sin(turn) * x + rot90Cos(turn) * z;
  if (tx !== 0) return X * 2 + (tx < 0 ? 1 : 0);
  return Z * 2 + (tz < 0 ? 1 : 0);
}

const TURNED_AXES = Int8Array.from({ length: QUARTER_TURNS * AXIS_CODES }, (_, i) =>
  turnedAxis(i % AXIS_CODES, Math.floor(i / AXIS_CODES)),
);

export function rotatedAxis(code: number, rot: number): number {
  return TURNED_AXES[rot * AXIS_CODES + code] ?? code;
}
