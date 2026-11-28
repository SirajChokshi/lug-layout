import { isLatticePose, isRot90, type Pose16 } from "@brr/math";
import type { ContributorRecordV2 } from "@brr/schema/world";
import type { NoteChange } from "./notes/note-state.ts";
import type { EventRecordV2 } from "@brr/schema/world";
import type { LayerAction, LayerChange } from "./layers/layer-table.ts";
import type { PlanState } from "./plan/plan-region.ts";
import { ConsistLayout, type ConsistHandle, type ConsistPose } from "./rail/consist-layout.ts";
import { INT8_MAX, INT8_MIN } from "./track/track-layout.ts";
import { isLayerId, isOwnerId, type PlacementHandle, type World } from "./world.ts";

const QUARTER_TURNS = 4;

export type EditKind =
  | "place"
  | "fill"
  | "rotate"
  | "move"
  | "remove"
  | "road"
  | "lay-track"
  | "throw-switch"
  | "plan"
  | "note"
  | "open-plan"
  | "event"
  | "layer"
  | "move-to-layer"
  | "contributor"
  | "assign-owner";
export type HistoryStep = "do" | "undo" | "redo";

export interface TrackPieceAt {
  readonly index: number;
  readonly piece: number;
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly rise: number;
  readonly layer: number;
  readonly owner: number;
}

export interface LayerLocks {
  isLocked(layer: number): boolean;
}

const NOTHING_LOCKED: LayerLocks = { isLocked: () => false };

export interface TrackChange {
  readonly lift: ReadonlyArray<TrackPieceAt>;
  readonly lay: ReadonlyArray<TrackPieceAt>;
}

export const NO_TRACK_CHANGE: TrackChange = { lift: [], lay: [] };

export interface PlanChange {
  readonly before: PlanState;
  readonly after: PlanState;
}

export interface EventChange {
  readonly before: EventRecordV2 | null;
  readonly after: EventRecordV2 | null;
}

export type Roster = ReadonlyArray<ContributorRecordV2>;
export type RosterAction = "add" | "rename" | "recolour" | "remove";

export interface RosterChange {
  readonly action: RosterAction;
  readonly contributor: number;
  readonly before: Roster;
  readonly after: Roster;
}

export type EditSummary =
  | { readonly kind: "place" | "rotate" | "move" | "remove" | "plan" | "note" | "event" }
  | { readonly kind: "throw-switch"; readonly switchAt: number }
  | { readonly kind: "road" | "fill"; readonly placements: number }
  | { readonly kind: "lay-track"; readonly pieces: number }
  | { readonly kind: "open-plan"; readonly placements: number; readonly pieces: number }
  | { readonly kind: "layer"; readonly action: LayerAction; readonly name: string }
  | { readonly kind: "move-to-layer"; readonly members: number; readonly layer: number }
  | { readonly kind: "contributor"; readonly action: RosterAction; readonly name: string }
  | { readonly kind: "assign-owner"; readonly members: number; readonly owner: number };

export interface PlacementPose {
  readonly refId: number;
  readonly colorId: number;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface LayeredPose extends PlacementPose {
  readonly layer: number;
  readonly owner: number;
}

export type RecordTag = "layer" | "owner";

export interface PlacementRef {
  readonly handle: PlacementHandle | null;
}

export interface PoseChange {
  readonly before: PlacementPose | null;
  readonly after: PlacementPose | null;
}

export interface PlacementFollower {
  follow(changes: ReadonlyArray<PoseChange>): NoteChange | null;
}

const NOTHING_FOLLOWS: PlacementFollower = { follow: () => null };

export interface PlacementRequest {
  readonly placement: PlacementRef | null;
  readonly to: LayeredPose | null;
}

export interface AppliedChange {
  readonly placement: PlacementRef;
  readonly from: LayeredPose | null;
  readonly to: LayeredPose | null;
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
  readonly plan: PlanChange | null;
  readonly notes: NoteChange | null;
  readonly event: EventChange | null;
  readonly layers: LayerChange | null;
  readonly contributors: RosterChange | null;
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
  readonly before: LayeredPose | null;
  readonly after: LayeredPose | null;
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
  readonly plan: PlanChange | null;
  readonly notes: NoteChange | null;
  readonly event: EventChange | null;
  readonly layers: LayerChange | null;
  readonly contributors: RosterChange | null;
}

function poseOf(handle: PlacementHandle): LayeredPose {
  return {
    refId: handle.refId,
    colorId: handle.colorId,
    x: handle.x,
    z: handle.z,
    yPlates: handle.yPlates,
    rot: handle.rot,
    layer: handle.layer,
    owner: handle.owner,
  };
}

function checkLayer(layer: number): void {
  if (!isLayerId(layer)) throw new RangeError(`layer ${layer} is not a layer id`);
}

function checkOwner(owner: number): void {
  if (!isOwnerId(owner)) throw new RangeError(`owner ${owner} is not a contributor id`);
}

function checkPose(pose: LayeredPose): void {
  if (!isLatticePose(pose.x, pose.z, pose.yPlates)) {
    throw new RangeError(
      `placement (${pose.x}, ${pose.yPlates}, ${pose.z}) is not an integer pose within int32 x/z and int16 yPlates`,
    );
  }
  if (!isRot90(pose.rot)) throw new Error(`rotation ${pose.rot} is not a quarter turn 0-3`);
  checkLayer(pose.layer);
  checkOwner(pose.owner);
}

function checkTrackPieces(pieces: ReadonlyArray<TrackPieceAt>, role: keyof TrackChange): void {
  let previous = -1;
  for (const { index, piece, yPlates, rise, layer, owner } of pieces) {
    if (!Number.isInteger(index) || index <= previous) {
      throw new RangeError(`track ${role} indices must be ascending non-negative integers`);
    }
    if (!Number.isInteger(piece) || piece < 0) {
      throw new RangeError(`track piece ${piece} is not a catalog index`);
    }
    checkLayer(layer);
    checkOwner(owner);
    if (!isLatticePose(0, 0, yPlates)) {
      throw new RangeError(`track height ${yPlates} plates is not an int16`);
    }
    if (!Number.isInteger(rise) || rise < INT8_MIN || rise > INT8_MAX) {
      throw new RangeError(`track rise ${rise} plates is not an int8`);
    }
    if (!isLatticePose(0, 0, yPlates + rise)) {
      throw new RangeError(`track end height ${yPlates + rise} plates is not an int16`);
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
    case "plan":
    case "note":
    case "event":
      return { kind: edit.kind };
    case "throw-switch":
      return { kind: edit.kind, switchAt: edit.track.lay[0]?.index ?? 0 };
    case "road":
    case "fill":
      return { kind: edit.kind, placements: edit.changes.length };
    case "lay-track":
      return { kind: edit.kind, pieces: edit.track.lay.length };
    case "open-plan":
      return { kind: edit.kind, placements: edit.changes.length, pieces: edit.track.lay.length };
    case "layer": {
      const change = edit.layers;
      if (!change) throw new Error("a layer edit carries no layer change");
      const layer = change.after.layer(change.layer) ?? change.before.layer(change.layer);
      return { kind: edit.kind, action: change.action, name: layer?.name ?? "" };
    }
    case "move-to-layer": {
      const layer = edit.changes[0]?.after?.layer ?? edit.track.lay[0]?.layer;
      if (layer === undefined) throw new Error("a move to a layer moves nothing");
      return { kind: edit.kind, members: edit.changes.length + edit.track.lay.length, layer };
    }
    case "contributor": {
      const change = edit.contributors;
      if (!change) throw new Error("a contributor edit carries no roster change");
      const named = (row: ContributorRecordV2): boolean => row.id === change.contributor;
      const contributor = change.after.find(named) ?? change.before.find(named);
      return { kind: edit.kind, action: change.action, name: contributor?.name ?? "" };
    }
    case "assign-owner": {
      const owner = edit.changes[0]?.after?.owner ?? edit.track.lay[0]?.owner;
      if (owner === undefined) throw new Error("an assignment assigns nothing");
      return { kind: edit.kind, members: edit.changes.length + edit.track.lay.length, owner };
    }
    default: {
      const unhandled: never = edit.kind;
      throw new Error(`unhandled edit ${String(unhandled)}`);
    }
  }
}

function lockedLayerOf(
  locks: LayerLocks,
  changes: ReadonlyArray<Change>,
  track: TrackChange,
): number | null {
  for (const { before, after } of changes) {
    if (before && locks.isLocked(before.layer)) return before.layer;
    if (after && locks.isLocked(after.layer)) return after.layer;
  }
  for (const piece of track.lift) if (locks.isLocked(piece.layer)) return piece.layer;
  for (const piece of track.lay) if (locks.isLocked(piece.layer)) return piece.layer;
  return null;
}

export function layOnLayer(change: TrackChange, layer: number): TrackChange {
  if (change.lift.length > 0) throw new Error("only newly laid track is put on a layer");
  return { lift: [], lay: change.lay.map((piece) => ({ ...piece, layer })) };
}

export class EditHistory {
  private readonly done: Edit[] = [];
  private readonly undone: Edit[] = [];

  constructor(
    private readonly world: World,
    private readonly trains: ConsistLayout = new ConsistLayout(),
    private readonly follower: PlacementFollower = NOTHING_FOLLOWS,
    private readonly locks: LayerLocks = NOTHING_LOCKED,
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

  place(pose: LayeredPose): AppliedEdit {
    return this.commit("place", [{ placement: null, to: pose }]);
  }

  placeConsist(pose: ConsistPose): AppliedEdit {
    return this.record({
      kind: "place",
      changes: [],
      consists: [{ ref: new TrainRef(this), before: null, after: pose }],
      track: NO_TRACK_CHANGE,
      plan: null,
      notes: null,
      event: null,
      layers: null,
      contributors: null,
    });
  }

  replaceConsist(consist: ConsistRef, pose: ConsistPose): AppliedEdit {
    const ref = this.ownConsist(consist);
    if (!ref.handle?.live) throw new Error("consist is not on the layout");
    return this.record({
      kind: "place",
      changes: [],
      consists: [{ ref, before: ref.handle.pose, after: pose }],
      track: NO_TRACK_CHANGE,
      plan: null,
      notes: null,
      event: null,
      layers: null,
      contributors: null,
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
      plan: null,
      notes: null,
      event: null,
      layers: null,
      contributors: null,
    });
  }

  layerEdit(change: LayerChange): AppliedEdit {
    return this.record({
      kind: "layer",
      changes: [],
      consists: [],
      track: NO_TRACK_CHANGE,
      plan: null,
      notes: null,
      event: null,
      layers: change,
      contributors: null,
    });
  }

  contributorEdit(change: RosterChange): AppliedEdit {
    return this.record({
      kind: "contributor",
      changes: [],
      consists: [],
      track: NO_TRACK_CHANGE,
      plan: null,
      notes: null,
      layers: null,
      contributors: change,
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

  moveToLayer(
    placements: ReadonlyArray<PlacementRef>,
    pieces: ReadonlyArray<TrackPieceAt>,
    layer: number,
    created: LayerChange | null = null,
  ): AppliedEdit | null {
    checkLayer(layer);
    return this.retag("move-to-layer", placements, pieces, "layer", layer, created);
  }

  assignOwner(
    placements: ReadonlyArray<PlacementRef>,
    pieces: ReadonlyArray<TrackPieceAt>,
    owner: number,
  ): AppliedEdit | null {
    checkOwner(owner);
    return this.retag("assign-owner", placements, pieces, "owner", owner, null);
  }

  private retag(
    kind: EditKind,
    placements: ReadonlyArray<PlacementRef>,
    pieces: ReadonlyArray<TrackPieceAt>,
    tag: RecordTag,
    value: number,
    layers: LayerChange | null,
  ): AppliedEdit | null {
    const requests: PlacementRequest[] = [];
    for (const placement of placements) {
      const pose = poseOf(this.liveHandle(placement));
      if (pose[tag] !== value) requests.push({ placement, to: { ...pose, [tag]: value } });
    }
    const lift = pieces.filter((piece) => piece[tag] !== value);
    if (requests.length + lift.length === 0) return null;
    const lay = lift.map((piece) => ({ ...piece, [tag]: value }));
    return this.commit(kind, requests, { lift, lay }, null, layers);
  }

  commit(
    kind: EditKind,
    requests: ReadonlyArray<PlacementRequest>,
    track: TrackChange = NO_TRACK_CHANGE,
    plan: PlanChange | null = null,
    layers: LayerChange | null = null,
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
    const locked = lockedLayerOf(this.locks, changes, track);
    if (locked !== null) throw new Error(`layer ${locked} is locked, so an edit can't touch it`);
    return this.record({
      kind,
      changes,
      consists: [],
      track,
      plan,
      notes: this.follower.follow(changes),
      event: null,
      layers,
      contributors: null,
    });
  }

  annotate(notes: NoteChange): AppliedEdit {
    return this.record({
      kind: "note",
      changes: [],
      consists: [],
      track: NO_TRACK_CHANGE,
      plan: null,
      notes,
      event: null,
      layers: null,
    });
  }

  editEvent(change: EventChange): AppliedEdit {
    return this.record({
      kind: "event",
      changes: [],
      consists: [],
      track: NO_TRACK_CHANGE,
      plan: null,
      notes: null,
      event: change,
      layers: null,
      contributors: null,
    });
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
        ? this.world.add(to.refId, to.colorId, to.x, to.z, to.yPlates, to.rot, to.layer, to.owner)
        : null;
      if (added) change.ref.handle = added;
      changes.push({ placement: change.ref, from, to, removed: removed[index] ?? null, added });
    }
    const track = backwards ? { lift: edit.track.lay, lay: edit.track.lift } : edit.track;
    const plan =
      backwards && edit.plan ? { before: edit.plan.after, after: edit.plan.before } : edit.plan;
    const notes =
      backwards && edit.notes ? { before: edit.notes.after, after: edit.notes.before } : edit.notes;
    const event =
      backwards && edit.event ? { before: edit.event.after, after: edit.event.before } : edit.event;
    const layers =
      backwards && edit.layers
        ? { ...edit.layers, before: edit.layers.after, after: edit.layers.before }
        : edit.layers;
    const contributors =
      backwards && edit.contributors
        ? { ...edit.contributors, before: edit.contributors.after, after: edit.contributors.before }
        : edit.contributors;
    return {
      kind: edit.kind,
      step,
      changes,
      consists: this.applyConsists(edit, step),
      track,
      plan,
      notes,
      event,
      layers,
      contributors,
    };
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
