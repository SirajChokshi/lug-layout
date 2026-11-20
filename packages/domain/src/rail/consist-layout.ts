import { isLatticePose, type Pose16 } from "@brr/math";

export interface TrackPieceKey {
  readonly piece: number;
  readonly placement: Pose16;
  readonly yPlates: number;
}

export interface ConsistAnchor {
  readonly track: TrackPieceKey;
  readonly route: number;
  readonly reversed: boolean;
  readonly offsetLdu: number;
}

export interface ConsistPose {
  readonly refId: number;
  readonly colorId: number;
  readonly anchor: ConsistAnchor;
}

export class ConsistHandle {
  live = true;

  constructor(readonly pose: ConsistPose) {}
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function consistPoseProblem(pose: ConsistPose): string | null {
  const { anchor } = pose;
  if (!isCount(pose.refId) || !isCount(pose.colorId)) return "its catalog ref is not an index";
  if (!isCount(anchor.track.piece)) return "its track piece is not a catalog index";
  if (!isLatticePose(0, 0, anchor.track.yPlates)) return "its track height is outside int16 plates";
  if (!isCount(anchor.route)) return "its route is not an index";
  if (!isCount(anchor.offsetLdu)) return "its offset along the route is not a whole LDU";
  return null;
}

export class ConsistLayout {
  private readonly held: ConsistHandle[] = [];

  get size(): number {
    return this.held.length;
  }

  consists(): ReadonlyArray<ConsistHandle> {
    return this.held;
  }

  add(pose: ConsistPose): ConsistHandle {
    const problem = consistPoseProblem(pose);
    if (problem) throw new RangeError(`a consist can't stand there: ${problem}`);
    const handle = new ConsistHandle(pose);
    this.held.push(handle);
    return handle;
  }

  remove(handle: ConsistHandle): void {
    const index = this.held.indexOf(handle);
    if (index < 0 || !handle.live) throw new Error("the consist is not in this layout");
    this.held.splice(index, 1);
    handle.live = false;
  }
}
