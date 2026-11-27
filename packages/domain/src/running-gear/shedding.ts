import { compareExactRational } from "@brr/math";
import { AXIS_FREE, AXIS_POS_Y, axisDimension, axisSign } from "../connect/connector-table.ts";
import { MODEL_ROOT } from "../connect/submodel-frames.ts";
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
import type { WrittenPoses } from "./written-pose.ts";

export interface SheddingPoses {
  readonly identified: ExactBoxes;
  readonly written: WrittenPoses;
  readonly boxes: Float64Array;
}

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

function decided(poses: SheddingPoses, standing: number, rider: number, sheds: boolean): Pair {
  return sheds && floatMayReach(poses.boxes, standing, rider) ? "sheds" : "clear";
}

function writtenPair(poses: SheddingPoses, standing: number, rider: number, shared: number): Pair {
  const up = poses.written.up(shared);
  if (up === null) return "unidentified";
  const frame = up === AXIS_FREE ? MODEL_ROOT : shared;
  const a = poses.written.box(standing, frame);
  const b = poses.written.box(rider, frame);
  if (!a || !b) return "unidentified";
  return decided(poses, standing, rider, inPath(a, b, up === AXIS_FREE ? AXIS_POS_Y : up));
}

function pair(poses: SheddingPoses, standing: number, rider: number): Pair {
  const { identified } = poses;
  if (!identified.hasExtents(standing) || !identified.hasExtents(rider)) return "unidentified";
  const frame = identified.sharedFrame(standing, rider);
  const up = identified.up(standing, frame);
  const a = identified.box(standing, frame);
  const b = identified.box(rider, frame);
  if (up === AXIS_FREE || !a || !b) return writtenPair(poses, standing, rider, frame);
  return decided(poses, standing, rider, inPath(a, b, up));
}

export function shedding(
  poses: SheddingPoses,
  riding: ReadonlyArray<number>,
  standing: ReadonlyArray<number>,
): SheddingFailure | null {
  const shed: number[] = [];
  const unidentified: number[] = [];
  for (const left of standing) {
    let unplaced = false;
    let sheds = false;
    for (const rider of riding) {
      const outcome = pair(poses, left, rider);
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
