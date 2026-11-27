import { compareExactRational } from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import {
  BOX_AXES,
  BOX_FLOATS,
  CANDIDATE_REACH_LDU,
  MODEL_UP,
  planReach,
  type ExactBox,
  type ExactBoxes,
} from "./exact-boxes.ts";
import { overlapsWithLength } from "./placed-instance.ts";

export interface SheddingFailure {
  readonly reason: "shedsParts" | "sheddingUnidentified";
  readonly instances: ReadonlyArray<number>;
}

type Pair = "clear" | "sheds" | "unidentified";

function inPath(standing: ExactBox, rider: ExactBox, up: number): boolean {
  const vertical = axisDimension(up);
  for (let d = 0; d < BOX_AXES; d++) {
    const across = standing[d];
    const under = rider[d];
    if (!across || !under) return false;
    if (d !== vertical && !overlapsWithLength(across, under)) return false;
  }
  const a = standing[vertical];
  const b = rider[vertical];
  if (!a || !b) return false;
  return axisSign(up) > 0
    ? compareExactRational(a.high, b.low) > 0
    : compareExactRational(a.low, b.high) < 0;
}

function floatMayReach(boxes: Float64Array, standing: number, rider: number): boolean {
  const top = boxes[standing * BOX_FLOATS + BOX_AXES + MODEL_UP] ?? Number.NaN;
  const bottom = boxes[rider * BOX_FLOATS + MODEL_UP] ?? Number.NaN;
  return top + CANDIDATE_REACH_LDU > bottom && planReach(boxes, standing, rider);
}

function pair(exact: ExactBoxes, boxes: Float64Array, standing: number, rider: number): Pair {
  const frame = exact.sharedFrame(standing, rider);
  const up = exact.up(standing, frame);
  const a = exact.box(standing, frame);
  const b = exact.box(rider, frame);
  if (up === AXIS_FREE || !a || !b) return "unidentified";
  if (!floatMayReach(boxes, standing, rider)) return "clear";
  return inPath(a, b, up) ? "sheds" : "clear";
}

export function shedding(
  exact: ExactBoxes,
  boxes: Float64Array,
  riding: ReadonlyArray<number>,
  standing: ReadonlyArray<number>,
): SheddingFailure | null {
  const shed: number[] = [];
  const unidentified: number[] = [];
  for (const left of standing) {
    let unplaced = false;
    let sheds = false;
    for (const rider of riding) {
      const outcome = pair(exact, boxes, left, rider);
      if (outcome === "sheds") {
        sheds = true;
        break;
      }
      if (outcome === "unidentified") unplaced = true;
    }
    if (sheds) shed.push(left);
    else if (unplaced) unidentified.push(left);
  }
  if (shed.length > 0) return { reason: "shedsParts", instances: shed };
  if (unidentified.length > 0) return { reason: "sheddingUnidentified", instances: unidentified };
  return null;
}
