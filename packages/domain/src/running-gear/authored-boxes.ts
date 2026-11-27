import {
  addExactRational,
  compareExactRational,
  exactRational,
  exactRationalFromDecimal,
  multiplyExactRational,
  parseExactDecimal,
  type ExactRational,
} from "@brr/math";
import type { PartInstances } from "../connect/submodel-frames.ts";
import type { AuthoredPoses } from "./authored-poses.ts";
import type { ExactBox } from "./exact-boxes.ts";
import type { Interval } from "./placed-instance.ts";
import type { PartExtents } from "./part-extents.ts";

const POSE_ENTRIES = 12;
const AXES = 3;
const ROW = 4;
const TRANSLATION = 3;
const CORNERS = 8;
const ZERO = exactRational(0n, 1n);

function exactEntry(text: string): ExactRational | null {
  try {
    return exactRationalFromDecimal(parseExactDecimal(text));
  } catch {
    return null;
  }
}

function exactPose(texts: ReadonlyArray<string> | null | undefined): ExactRational[] | null {
  if (!texts || texts.length !== POSE_ENTRIES) return null;
  const entries: ExactRational[] = [];
  for (const text of texts) {
    const entry = exactEntry(text);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

function mappedBound(
  pose: ReadonlyArray<ExactRational>,
  extents: PartExtents,
  row: number,
): Interval {
  let low: ExactRational | null = null;
  let high: ExactRational | null = null;
  for (let corner = 0; corner < CORNERS; corner++) {
    let value = pose[row * ROW + TRANSLATION] ?? ZERO;
    for (let k = 0; k < AXES; k++) {
      const local = (corner >> k) & 1 ? extents.max[k] : extents.min[k];
      value = addExactRational(
        value,
        multiplyExactRational(pose[row * ROW + k] ?? ZERO, local ?? ZERO),
      );
    }
    if (low === null || compareExactRational(value, low) < 0) low = value;
    if (high === null || compareExactRational(value, high) > 0) high = value;
  }
  return { low: low ?? ZERO, high: high ?? ZERO };
}

export class AuthoredBoxes {
  private readonly boxes = new Map<number, ExactBox | null>();
  private readonly exactPoses = new Map<number, ReadonlyArray<ExactRational> | null>();

  constructor(
    private readonly instances: PartInstances,
    private readonly extents: ReadonlyArray<PartExtents | null>,
    private readonly poses: AuthoredPoses | null,
  ) {}

  pose(instance: number): ReadonlyArray<ExactRational> | null {
    const known = this.exactPoses.get(instance);
    if (known !== undefined) return known;
    const pose = exactPose(this.poses?.[instance]);
    this.exactPoses.set(instance, pose);
    return pose;
  }

  box(instance: number): ExactBox | null {
    const known = this.boxes.get(instance);
    if (known !== undefined) return known;
    const part = this.extents[this.instances.partIndex[instance] ?? -1];
    const pose = this.pose(instance);
    const box = part && pose ? [0, 1, 2].map((row) => mappedBound(pose, part, row)) : null;
    this.boxes.set(instance, box);
    return box;
  }
}
