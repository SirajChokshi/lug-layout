import { isLatticePose, isRot90, type Pose16 } from "@brr/math";
import { ConsistLayout, type ConsistHandle, type ConsistPose } from "./rail/consist-layout.ts";
import type { PlacementHandle, World } from "./world.ts";

const QUARTER_TURNS = 4;

export type EditKind =
  | "place"
  | "rotate"
  | "move"
  | "remove"
  | "road"
  | "lay-track"
  | "throw-switch";
export type HistoryStep = "do" | "undo" | "redo";

export interface TrackPieceAt {
  readonly index: number;
  readonly piece: number;
  readonly pose: Pose16;
  readonly yPlates: number;
}

export interface TrackChange {
  readonly lift: ReadonlyArray<TrackPieceAt>;
  readonly lay: ReadonlyArray<TrackPieceAt>;
}

export const NO_TRACK_CHANGE: TrackChange = { lift: [], lay: [] };

export type EditSummary =
  | { readonly kind: "place" | "rotate" | "move" | "remove" }
  | { readonly kind: "throw-switch"; readonly switchAt: number }
  | { readonly kind: "road"; readonly placements: number }
  | { readonly kind: "lay-track"; readonly pieces: number };

export interface PlacementPose {
  readonly refId: number;
  readonly colorId: number;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface PlacementRef {
  readonly handle: PlacementHandle | null;
}

export interface PlacementRequest {
  readonly placement: PlacementRef | null;
  readonly to: PlacementPose | null;
}

export interface AppliedChange {
  readonly placement: PlacementRef;
  readonly from: PlacementPose | null;
  readonly to: PlacementPose | null;
  readonly removed: PlacementHandle | null;
  readonly added: PlacementHandle | null;
}

export interface ConsistRef {
  readonly handle: ConsistHandle | null;
}

export interface AppliedConsistChange {
  readonly consist: ConsistRef;
  readonly from: ConsistPose | null;
  readonly to: ConsistPose | null;
  readonly removed: ConsistHandle | null;
  readonly added: ConsistHandle | null;
}

export interface AppliedEdit {
  readonly kind: EditKind;
  readonly step: HistoryStep;
  readonly changes: ReadonlyArray<AppliedChange>;
  readonly consists: ReadonlyArray<AppliedConsistChange>;
  readonly track: TrackChange;
}

class Ref implements PlacementRef {
  handle: PlacementHandle | null = null;

  constructor(readonly history: EditHistory) {}
}

class TrainRef implements ConsistRef {
  handle: ConsistHandle | null = null;

  constructor(readonly history: EditHistory) {}
}

interface Change {
  readonly ref: Ref;
  readonly before: PlacementPose | null;
  readonly after: PlacementPose | null;
}

interface ConsistChange {
  readonly ref: TrainRef;
  readonly before: ConsistPose | null;
  readonly after: ConsistPose | null;
}

interface Edit {
  readonly kind: EditKind;
  readonly changes: ReadonlyArray<Change>;
  readonly consists: ReadonlyArray<ConsistChange>;
  readonly track: TrackChange;
}

function poseOf(handle: PlacementHandle): PlacementPose {
  return {
    refId: handle.refId,
    colorId: handle.colorId,
    x: handle.x,
    z: handle.z,
    yPlates: handle.yPlates,
    rot: handle.rot,
  };
}

function checkPose(pose: PlacementPose): void {
  if (!isLatticePose(pose.x, pose.z, pose.yPlates)) {
    throw new RangeError(
      `placement (${pose.x}, ${pose.yPlates}, ${pose.z}) is not an integer pose within int32 x/z and int16 yPlates`,
    );
  }
  if (!isRot90(pose.rot)) throw new Error(`rotation ${pose.rot} is not a quarter turn 0-3`);
}

function checkTrackPieces(pieces: ReadonlyArray<TrackPieceAt>, role: keyof TrackChange): void {
  let previous = -1;
  for (const { index, piece, yPlates } of pieces) {
    if (!Number.isInteger(index) || index <= previous) {
      throw new RangeError(`track ${role} indices must be ascending non-negative integers`);
    }
    if (!Number.isInteger(piece) || piece < 0) {
      throw new RangeError(`track piece ${piece} is not a catalog index`);
    }
    if (!isLatticePose(0, 0, yPlates)) {
      throw new RangeError(`track height ${yPlates} plates is not an int16`);
    }
    previous = index;
  }
}

function summary(edit: Edit): EditSummary {
  switch (edit.kind) {
    case "place":
    case "rotate":
    case "move":
    case "remove":
      return { kind: edit.kind };
    case "throw-switch":
      return { kind: edit.kind, switchAt: edit.track.lay[0]?.index ?? 0 };
    case "road":
      return { kind: edit.kind, placements: edit.changes.length };
    case "lay-track":
      return { kind: edit.kind, pieces: edit.track.lay.length };
    default: {
      const unhandled: never = edit.kind;
      throw new Error(`unhandled edit ${String(unhandled)}`);
    }
  }
}

export class EditHistory {
  private readonly done: Edit[] = [];
  private readonly undone: Edit[] = [];

  constructor(
    private readonly world: World,
    private readonly trains: ConsistLayout = new ConsistLayout(),
  ) {}

  get undoDepth(): number {
    return this.done.length;
  }

  get redoDepth(): number {
    return this.undone.length;
  }

  nextUndo(): EditSummary | null {
    const edit = this.done.at(-1);
    return edit ? summary(edit) : null;
  }

  nextRedo(): EditSummary | null {
    const edit = this.undone.at(-1);
    return edit ? summary(edit) : null;
  }

  adopt(handle: PlacementHandle): PlacementRef {
    if (!handle.live) throw new Error("only a placement in the world can be adopted");
    const ref = new Ref(this);
    ref.handle = handle;
    return ref;
  }

  adoptConsist(handle: ConsistHandle): ConsistRef {
    if (!handle.live) throw new Error("only a consist on the layout can be adopted");
    const ref = new TrainRef(this);
    ref.handle = handle;
    return ref;
  }

  place(pose: PlacementPose): AppliedEdit {
    return this.commit("place", [{ placement: null, to: pose }]);
  }

  placeConsist(pose: ConsistPose): AppliedEdit {
    return this.record({
      kind: "place",
      changes: [],
      consists: [{ ref: new TrainRef(this), before: null, after: pose }],
      track: NO_TRACK_CHANGE,
    });
  }

  removeConsist(consist: ConsistRef): AppliedEdit {
    const ref = this.ownConsist(consist);
    if (!ref.handle?.live) throw new Error("consist is not on the layout");
    return this.record({
      kind: "remove",
      changes: [],
      consists: [{ ref, before: ref.handle.pose, after: null }],
      track: NO_TRACK_CHANGE,
    });
  }

  rotate(placement: PlacementRef): AppliedEdit {
    const handle = this.liveHandle(placement);
    return this.commit("rotate", [
      { placement, to: { ...poseOf(handle), rot: (handle.rot + 1) % QUARTER_TURNS } },
    ]);
  }

  remove(placement: PlacementRef): AppliedEdit {
    return this.commit("remove", [{ placement, to: null }]);
  }

  commit(
    kind: EditKind,
    requests: ReadonlyArray<PlacementRequest>,
    track: TrackChange = NO_TRACK_CHANGE,
  ): AppliedEdit {
    checkTrackPieces(track.lift, "lift");
    checkTrackPieces(track.lay, "lay");
    const seen = new Set<Ref>();
    const changes: Change[] = [];
    for (const request of requests) {
      if (request.to) checkPose(request.to);
      if (request.placement === null) {
        if (!request.to) throw new Error("a new placement needs a pose");
        changes.push({ ref: new Ref(this), before: null, after: request.to });
        continue;
      }
      const ref = this.own(request.placement);
      if (seen.has(ref)) throw new Error("an edit names the same placement twice");
      seen.add(ref);
      changes.push({ ref, before: poseOf(this.liveHandle(ref)), after: request.to });
    }
    return this.record({ kind, changes, consists: [], track });
  }

  private record(edit: Edit): AppliedEdit {
    const applied = this.apply(edit, "do");
    this.done.push(edit);
    this.undone.length = 0;
    return applied;
  }

  undo(): AppliedEdit | null {
    const edit = this.done.pop();
    if (!edit) return null;
    this.undone.push(edit);
    return this.apply(edit, "undo");
  }

  redo(): AppliedEdit | null {
    const edit = this.undone.pop();
    if (!edit) return null;
    this.done.push(edit);
    return this.apply(edit, "redo");
  }

  private own(placement: PlacementRef): Ref {
    if (!(placement instanceof Ref) || placement.history !== this) {
      throw new Error("placement belongs to another edit history");
    }
    return placement;
  }

  private ownConsist(consist: ConsistRef): TrainRef {
    if (!(consist instanceof TrainRef) || consist.history !== this) {
      throw new Error("consist belongs to another edit history");
    }
    return consist;
  }

  private liveHandle(placement: PlacementRef): PlacementHandle {
    const handle = this.own(placement).handle;
    if (!handle?.live) throw new Error("placement is not in the world");
    return handle;
  }

  private apply(edit: Edit, step: HistoryStep): AppliedEdit {
    const backwards = step === "undo";
    const removed: Array<PlacementHandle | null> = [];
    for (const change of edit.changes) {
      const from = backwards ? change.after : change.before;
      if (from === null) {
        removed.push(null);
        continue;
      }
      const handle = change.ref.handle;
      if (handle === null) throw new Error("edit history is out of step with the world");
      this.world.remove(handle);
      change.ref.handle = null;
      removed.push(handle);
    }
    const changes: AppliedChange[] = [];
    for (const [index, change] of edit.changes.entries()) {
      const from = backwards ? change.after : change.before;
      const to = backwards ? change.before : change.after;
      const added = to
        ? this.world.add(to.refId, to.colorId, to.x, to.z, to.yPlates, to.rot)
        : null;
      if (added) change.ref.handle = added;
      changes.push({ placement: change.ref, from, to, removed: removed[index] ?? null, added });
    }
    const track = backwards ? { lift: edit.track.lay, lay: edit.track.lift } : edit.track;
    return { kind: edit.kind, step, changes, consists: this.applyConsists(edit, step), track };
  }

  private applyConsists(edit: Edit, step: HistoryStep): AppliedConsistChange[] {
    const backwards = step === "undo";
    const applied: AppliedConsistChange[] = [];
    for (const change of edit.consists) {
      const from = backwards ? change.after : change.before;
      const to = backwards ? change.before : change.after;
      const removed = from === null ? null : change.ref.handle;
      if (from !== null) {
        if (removed === null) throw new Error("edit history is out of step with the layout");
        this.trains.remove(removed);
        change.ref.handle = null;
      }
      const added = to === null ? null : this.trains.add(to);
      if (added) change.ref.handle = added;
      applied.push({ consist: change.ref, from, to, removed, added });
    }
    return applied;
  }
}
