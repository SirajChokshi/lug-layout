import { compareExactRational } from "@brr/math";
import { AXIS_FREE, AXIS_POS_Y, axisDimension, axisSign } from "../connect/connector-table.ts";
import type { AuthoredBoxes } from "./authored-boxes.ts";
import {
  BOX_AXES,
  BOX_FLOATS,
  CANDIDATE_REACH_LDU,
  type ExactBox,
  type ExactBoxes,
} from "./exact-boxes.ts";
import { overlapsWithLength } from "./placed-instance.ts";

export interface SheddingPoses {
  readonly identified: ExactBoxes;
  readonly authored: AuthoredBoxes;
  readonly boxes: Float64Array;
}

export interface SheddingFailure {
  readonly reason: "shedsParts" | "sheddingUnidentified";
  readonly instances: ReadonlyArray<number>;
}

type Pair = "clear" | "sheds" | "undecidable";

const ROOT_PLAN_AXES = [0, 2] as const;

function sheds(outside: ExactBox, rider: ExactBox, up: number): boolean {
  const vertical = axisDimension(up);
  for (let d = 0; d < BOX_AXES; d++) {
    const across = outside[d];
    const under = rider[d];
    if (!across || !under) return false;
    if (d !== vertical && !overlapsWithLength(across, under)) return false;
  }
  const a = outside[vertical];
  const b = rider[vertical];
  if (!a || !b) return false;
  return axisSign(up) > 0
    ? compareExactRational(a.high, b.low) > 0
    : compareExactRational(a.low, b.high) < 0;
}

function planApart(boxes: Float64Array, a: number, b: number): boolean {
  return ROOT_PLAN_AXES.some((d) => {
    const low = Math.max(boxes[a * BOX_FLOATS + d] ?? 0, boxes[b * BOX_FLOATS + d] ?? 0);
    const high = Math.min(
      boxes[a * BOX_FLOATS + BOX_AXES + d] ?? 0,
      boxes[b * BOX_FLOATS + BOX_AXES + d] ?? 0,
    );
    return low - high > CANDIDATE_REACH_LDU;
  });
}

function decided(
  poses: SheddingPoses,
  outside: number,
  rider: number,
  boxes: readonly [ExactBox, ExactBox],
  up: number,
): Pair {
  if (planApart(poses.boxes, outside, rider)) return "clear";
  return sheds(boxes[0], boxes[1], up) ? "sheds" : "clear";
}

function identifiedPair(poses: SheddingPoses, outside: number, rider: number): Pair | null {
  const { identified } = poses;
  if (!identified.hasExtents(outside) || !identified.hasExtents(rider)) return null;
  const frame = identified.sharedFrame(outside, rider);
  const up = identified.up(outside, frame);
  const a = identified.box(outside, frame);
  const b = identified.box(rider, frame);
  if (up === AXIS_FREE || !a || !b) return null;
  return decided(poses, outside, rider, [a, b], up);
}

function pair(poses: SheddingPoses, outside: number, rider: number): Pair {
  const identified = identifiedPair(poses, outside, rider);
  if (identified) return identified;
  const a = poses.authored.box(outside);
  const b = poses.authored.box(rider);
  if (!a || !b) return "undecidable";
  return decided(poses, outside, rider, [a, b], AXIS_POS_Y);
}

export function shedding(
  poses: SheddingPoses,
  riding: ReadonlyArray<number>,
  outside: ReadonlyArray<number>,
): SheddingFailure | null {
  const shed: number[] = [];
  const undecidable: number[] = [];
  for (const left of outside) {
    let undecided = false;
    let shedsLeft = false;
    for (const rider of riding) {
      const outcome = pair(poses, left, rider);
      if (outcome === "sheds") {
        shedsLeft = true;
        break;
      }
      if (outcome === "undecidable") undecided = true;
    }
    if (shedsLeft) shed.push(left);
    else if (undecided) undecidable.push(left);
  }
  if (shed.length > 0) return { reason: "shedsParts", instances: shed };
  if (undecidable.length > 0) return { reason: "sheddingUnidentified", instances: undecidable };
  return null;
}
