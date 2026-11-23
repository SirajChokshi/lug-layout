import { isLatticePose, isRot90, type Pose16 } from "@brr/math";

export interface LaidPieceRef {
  readonly kind: "laid";
  readonly piece: number;
  readonly placement: Pose16;
  readonly yPlates: number;
}

export interface CarrierPose {
  readonly refId: number;
  readonly colorId: number;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface CarriedPieceRef {
  readonly kind: "carried";
  readonly carrier: CarrierPose;
  readonly piece: number;
}

export type TrackPieceRef = LaidPieceRef | CarriedPieceRef;

export interface ConsistAnchor {
  readonly track: TrackPieceRef;
  readonly route: number;
  readonly reversed: boolean;
  readonly offsetLdu: number;
}

export interface CoupledVehicle {
  readonly refId: number;
  readonly colorId: number;
  readonly reversed: boolean;
}

export interface ConsistPose {
  readonly refId: number;
  readonly colorId: number;
  readonly anchor: ConsistAnchor;
  readonly coupled: ReadonlyArray<CoupledVehicle>;
}

export class ConsistHandle {
  live = true;

  constructor(readonly pose: ConsistPose) {}
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function pieceProblem(track: TrackPieceRef): string | null {
  switch (track.kind) {
    case "laid":
      if (!isCount(track.piece)) return "its track piece is not a catalog index";
      if (!isLatticePose(0, 0, track.yPlates)) return "its track height is outside int16 plates";
      return null;
    case "carried": {
      const { carrier } = track;
      if (!isCount(track.piece)) return "its track piece is not an index into its model";
      if (!isCount(carrier.refId) || !isCount(carrier.colorId)) {
        return "the model carrying its track has no catalog ref";
      }
      if (!isLatticePose(carrier.x, carrier.z, carrier.yPlates) || !isRot90(carrier.rot)) {
        return "the model carrying its track is not at a lattice pose";
      }
      return null;
    }
    default: {
      const unhandled: never = track;
      throw new Error(`unhandled track piece ref ${String(unhandled)}`);
    }
  }
}

export function consistPoseProblem(pose: ConsistPose): string | null {
  const { anchor } = pose;
  if (!isCount(pose.refId) || !isCount(pose.colorId)) return "its catalog ref is not an index";
  if (pose.coupled.some(({ refId, colorId }) => !isCount(refId) || !isCount(colorId))) {
    return "a vehicle coupled to it has no catalog ref";
  }
  if (!isCount(anchor.route)) return "its route is not an index";
  if (!isCount(anchor.offsetLdu)) return "its offset along the route is not a whole LDU";
  return pieceProblem(anchor.track);
}

export function sameCarrier(a: CarrierPose, b: CarrierPose): boolean {
  return (
    a.refId === b.refId &&
    a.colorId === b.colorId &&
    a.x === b.x &&
    a.z === b.z &&
    a.yPlates === b.yPlates &&
    a.rot === b.rot
  );
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
