import { isRot90, rot90Cos, rot90Sin, PLATE_LDU } from "@brr/math";
import type { Vec3 } from "@brr/schema/bundle";
import type { LatticePose } from "../connect/candidate-poses.ts";

export const LDRAW_INHERITED_COLOR = 16;
export const LDRAW_LINE_END = "\r\n";

const LDRAW_AXIS_SIGN = [1, -1, -1] as const;
const ROW_FLOATS = 4;
const AXES = 3;
const LIBRARY_PART_DIRECTORY = "parts/";
const EXPONENT_FORM = /^(?<sign>-?)(?<lead>\d)(?:\.(?<rest>\d+))?e(?<exponent>[+-]\d+)$/u;

function plainDecimal(value: number): string {
  const match = EXPONENT_FORM.exec(value.toExponential())?.groups;
  if (!match) throw new Error(`${value} has no exponent form`);
  const digits = `${match["lead"] ?? ""}${match["rest"] ?? ""}`;
  const point = 1 + Number(match["exponent"]);
  const sign = match["sign"] ?? "";
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function ldrawNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`${value} can't be written in an LDraw file`);
  if (value === 0) return "0";
  const text = String(value);
  return text.includes("e") ? plainDecimal(value) : text;
}

export function latticeAffine(pose: LatticePose, shift: Readonly<Vec3>): Float64Array {
  const { rot } = pose;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const [sx, sy, sz] = shift;
  return Float64Array.of(
    cos,
    0,
    sin,
    pose.x + cos * sx + sin * sz,
    0,
    1,
    0,
    pose.yPlates * PLATE_LDU + sy,
    -sin,
    0,
    cos,
    pose.z - sin * sx + cos * sz,
  );
}

export function ldrawAffine(yUp: ArrayLike<number>): Float64Array {
  const out = new Float64Array(AXES * ROW_FLOATS);
  for (let row = 0; row < AXES; row++) {
    for (let column = 0; column < ROW_FLOATS; column++) {
      const columnSign = column < AXES ? (LDRAW_AXIS_SIGN[column] ?? 1) : 1;
      const at = row * ROW_FLOATS + column;
      out[at] = (LDRAW_AXIS_SIGN[row] ?? 1) * columnSign * (yUp[at] ?? 0) + 0;
    }
  }
  return out;
}

export function type1Line(color: number, affine: Float64Array, reference: string): string {
  const [a = 0, b = 0, c = 0, x = 0, d = 0, e = 0, f = 0, y = 0, g = 0, h = 0, i = 0, z = 0] =
    affine;
  const numbers = [x, y, z, a, b, c, d, e, f, g, h, i].map(ldrawNumber);
  return `1 ${color} ${numbers.join(" ")} ${reference}`;
}

export function libraryReference(path: string): string {
  if (!path.startsWith(LIBRARY_PART_DIRECTORY)) {
    throw new Error(`${path} is not a part of the LDraw library's ${LIBRARY_PART_DIRECTORY}`);
  }
  return path.slice(LIBRARY_PART_DIRECTORY.length).replaceAll("/", "\\");
}

export function normalizeLdrawReference(reference: string): string {
  return reference.trim().split(/\s+/u).join(" ").replaceAll("\\", "/").toLowerCase();
}

export function ldrawLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function commentLines(text: string): string[] {
  return ldrawLines(text).map((line) => (line.trim() === "" ? "0 //" : `0 // ${line.trim()}`));
}
