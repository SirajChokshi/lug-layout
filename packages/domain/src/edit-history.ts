import { isLatticePose, isRot90 } from "@brr/math";
import type { PlacementHandle, World } from "./world.ts";

const QUARTER_TURNS = 4;

export type EditKind = "place" | "rotate" | "remove";
export type HistoryStep = "do" | "undo" | "redo";

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

export interface PendingChange {
  readonly placement: PlacementRef;
  readonly from: PlacementPose | null;
  readonly to: PlacementPose | null;
}

export interface AppliedChange {
  readonly placement: PlacementRef;
  readonly from: PlacementPose | null;
  readonly to: PlacementPose | null;
  readonly removed: PlacementHandle | null;
  readonly added: PlacementHandle | null;
}

export interface AppliedEdit {
  readonly kind: EditKind;
  readonly step: HistoryStep;
  readonly changes: ReadonlyArray<AppliedChange>;
}

class Ref implements PlacementRef {
  handle: PlacementHandle | null = null;

  constructor(readonly history: EditHistory) {}
}

interface Change {
  readonly ref: Ref;
  readonly before: PlacementPose | null;
  readonly after: PlacementPose | null;
}

interface Edit {
  readonly kind: EditKind;
  readonly changes: ReadonlyArray<Change>;
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

export class EditHistory {
  private readonly done: Edit[] = [];
  private readonly undone: Edit[] = [];

  constructor(private readonly world: World) {}

  get undoDepth(): number {
    return this.done.length;
  }

  get redoDepth(): number {
    return this.undone.length;
  }

  nextUndo(): EditKind | null {
    return this.done.at(-1)?.kind ?? null;
  }

  nextRedo(): EditKind | null {
    return this.undone.at(-1)?.kind ?? null;
  }

  adopt(handle: PlacementHandle): PlacementRef {
    if (!handle.live) throw new Error("only a placement in the world can be adopted");
    const ref = new Ref(this);
    ref.handle = handle;
    return ref;
  }

  peekUndo(): ReadonlyArray<PendingChange> | null {
    const edit = this.done.at(-1);
    return edit
      ? edit.changes.map((c) => ({ placement: c.ref, from: c.after, to: c.before }))
      : null;
  }

  peekRedo(): ReadonlyArray<PendingChange> | null {
    const edit = this.undone.at(-1);
    return edit
      ? edit.changes.map((c) => ({ placement: c.ref, from: c.before, to: c.after }))
      : null;
  }

  place(pose: PlacementPose): AppliedEdit {
    return this.commit("place", [{ placement: null, to: pose }]);
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

  commit(kind: EditKind, requests: ReadonlyArray<PlacementRequest>): AppliedEdit {
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
    const edit: Edit = { kind, changes };
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
    return { kind: edit.kind, step, changes };
  }
}
