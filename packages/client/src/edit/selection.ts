import type { ConsistHandle, TrackChange, TrackPieceAt } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import type { WorldBox } from "@brr/render";
import { latticeCentre, unionBox, type LatticePoint } from "./group-transform.ts";
import type { PlacedModel } from "./placed-chunks.ts";

export interface ModelSelectionView {
  readonly kind: "model";
  readonly item: string;
  readonly yPlates: number;
  readonly rot: number;
  readonly box: WorldBox;
}

export interface TrackSelectionView {
  readonly kind: "track";
  readonly item: string;
  readonly centreX: number;
  readonly centreZ: number;
  readonly yPlates: number;
  readonly heading: number;
  readonly box: WorldBox;
}

export interface TrainSelectionView {
  readonly kind: "train";
  readonly item: string;
  readonly vehicles: number;
  readonly lengthLdu: number;
  readonly box: WorldBox;
}

export type SelectionItemView = ModelSelectionView | TrackSelectionView | TrainSelectionView;

export interface SelectionTally {
  readonly models: number;
  readonly pieces: number;
  readonly trains: number;
}

export interface SelectionGrouping {
  readonly groups: ReadonlyArray<string>;
  readonly loose: number;
}

export interface SelectionView extends SelectionGrouping {
  readonly primary: SelectionItemView;
  readonly members: ReadonlyArray<SelectionItemView>;
  readonly box: WorldBox;
  readonly tally: SelectionTally;
  readonly movable: boolean;
  readonly pivotStuds: { readonly x: number; readonly z: number } | null;
}

export type SelectionMember =
  | { readonly kind: "model"; readonly model: PlacedModel }
  | { readonly kind: "track"; readonly placement: number }
  | { readonly kind: "train"; readonly train: ConsistHandle };

export interface SelectionViews {
  piece(placement: number): TrackSelectionView;
  train(train: ConsistHandle): TrainSelectionView | null;
  grouping(members: ReadonlyArray<SelectionMember>): SelectionGrouping;
}

function modelView(model: PlacedModel): ModelSelectionView {
  const { handle } = model;
  return {
    kind: "model",
    item: model.placeable.id,
    yPlates: handle.yPlates,
    rot: handle.rot,
    box: model.box,
  };
}

export function sameMember(a: SelectionMember, b: SelectionMember): boolean {
  switch (a.kind) {
    case "model":
      return b.kind === "model" && a.model === b.model;
    case "track":
      return b.kind === "track" && a.placement === b.placement;
    case "train":
      return b.kind === "train" && a.train === b.train;
    default: {
      const unhandled: never = a;
      throw new Error(`unhandled selection member ${String(unhandled)}`);
    }
  }
}

function sameIndices(a: ReadonlyArray<TrackPieceAt>, b: ReadonlyArray<TrackPieceAt>): boolean {
  return a.length === b.length && a.every((at, i) => at.index === b[i]?.index);
}

function placementThrough(placement: number, change: TrackChange): number | null {
  let at = placement;
  for (let i = change.lift.length - 1; i >= 0; i--) {
    const lifted = change.lift[i]?.index ?? at;
    if (lifted === at) return null;
    if (lifted < at) at--;
  }
  for (const laid of change.lay) {
    if (laid.index <= at) at++;
  }
  return at;
}

export function tallyOf(members: ReadonlyArray<SelectionMember>): SelectionTally {
  const count = (kind: SelectionMember["kind"]): number =>
    members.filter((member) => member.kind === kind).length;
  return { models: count("model"), pieces: count("track"), trains: count("train") };
}

export function boxesOf(
  members: ReadonlyArray<SelectionMember>,
  views: SelectionViews,
): ReadonlyArray<WorldBox> {
  return members.flatMap((member): WorldBox[] => {
    switch (member.kind) {
      case "model":
        return [member.model.box];
      case "track":
        return [views.piece(member.placement).box];
      case "train": {
        const train = views.train(member.train);
        return train ? [train.box] : [];
      }
      default: {
        const unhandled: never = member;
        throw new Error(`unhandled selection member ${String(unhandled)}`);
      }
    }
  });
}

function itemViewsOf(
  members: ReadonlyArray<SelectionMember>,
  views: SelectionViews,
): ReadonlyArray<SelectionItemView> {
  return members.flatMap((member): SelectionItemView[] => {
    switch (member.kind) {
      case "model":
        return [modelView(member.model)];
      case "track":
        return [views.piece(member.placement)];
      case "train": {
        const train = views.train(member.train);
        return train ? [train] : [];
      }
      default: {
        const unhandled: never = member;
        throw new Error(`unhandled selection member ${String(unhandled)}`);
      }
    }
  });
}

function isMovable(members: ReadonlyArray<SelectionMember>): boolean {
  return members.length > 0 && members.every((member) => member.kind !== "train");
}

function isLive(member: SelectionMember): boolean {
  if (member.kind === "model") return member.model.handle.live;
  if (member.kind === "train") return member.train.live;
  return true;
}

export class Selection {
  private picked: ReadonlyArray<SelectionMember> = [];
  private pivot: LatticePoint | null = null;

  get members(): ReadonlyArray<SelectionMember> {
    return this.picked;
  }

  get models(): ReadonlyArray<PlacedModel> {
    return this.picked.flatMap((member) => (member.kind === "model" ? [member.model] : []));
  }

  get pieces(): ReadonlyArray<number> {
    return this.picked.flatMap((member) => (member.kind === "track" ? [member.placement] : []));
  }

  get trains(): ReadonlyArray<ConsistHandle> {
    return this.picked.flatMap((member) => (member.kind === "train" ? [member.train] : []));
  }

  get rememberedPivot(): LatticePoint | null {
    return this.pivot;
  }

  get movable(): boolean {
    return isMovable(this.picked);
  }

  has(member: SelectionMember): boolean {
    return this.picked.some((picked) => sameMember(picked, member));
  }

  replace(members: ReadonlyArray<SelectionMember>, pivot: LatticePoint | null): void {
    const unique = members.filter(
      (member, index) => members.findIndex((other) => sameMember(other, member)) === index,
    );
    const train = unique.findLast((member) => member.kind === "train");
    this.picked = train ? [train] : unique;
    this.pivot = pivot;
  }

  toggle(member: SelectionMember, together: ReadonlyArray<SelectionMember> = [member]): void {
    this.replace(
      this.has(member)
        ? this.picked.filter((picked) => !together.some((other) => sameMember(other, picked)))
        : [...this.picked.filter((picked) => picked.kind !== "train"), ...together],
      null,
    );
  }

  swap(previous: PlacedModel, next: PlacedModel): boolean {
    if (!this.has({ kind: "model", model: previous })) return false;
    this.picked = this.picked.map((member) =>
      member.kind === "model" && member.model === previous
        ? { kind: "model", model: next }
        : member,
    );
    return true;
  }

  dropRemoved(): boolean {
    const live = this.picked.filter(isLive);
    if (live.length === this.picked.length) return false;
    this.replace(live, null);
    return true;
  }

  followTrackChange(change: TrackChange): boolean {
    if (change.lift.length + change.lay.length === 0) return false;
    if (sameIndices(change.lift, change.lay)) {
      const lifted = new Set(change.lift.map((at) => at.index));
      return this.pieces.some((placement) => lifted.has(placement));
    }
    let changed = false;
    const followed = this.picked.flatMap((member): SelectionMember[] => {
      if (member.kind !== "track") return [member];
      const placement = placementThrough(member.placement, change);
      if (placement !== member.placement) changed = true;
      return placement === null ? [] : [{ kind: "track", placement }];
    });
    if (!changed) return false;
    this.replace(followed, null);
    return true;
  }

  turnPivot(views: SelectionViews): LatticePoint | null {
    return this.pivotWithin(() => unionBox(this.boxes(views)));
  }

  boxes(views: SelectionViews): ReadonlyArray<WorldBox> {
    return boxesOf(this.picked, views);
  }

  view(views: SelectionViews): SelectionView | null {
    const members = itemViewsOf(this.picked, views);
    const primary = members.at(-1);
    if (!primary) return null;
    const box = unionBox(members.map((member) => member.box));
    const pivot = this.pivotWithin(() => box);
    return {
      primary,
      members,
      box,
      tally: tallyOf(this.picked),
      ...views.grouping(this.picked),
      movable: isMovable(this.picked),
      pivotStuds: pivot && { x: pivot.x / STUD_LDU + 0, z: pivot.z / STUD_LDU + 0 },
    };
  }

  private pivotWithin(box: () => WorldBox): LatticePoint | null {
    const [only, second] = this.picked;
    if (!only || !this.movable) return null;
    if (this.pivot) return this.pivot;
    if (only.kind === "model" && !second) return { x: only.model.handle.x, z: only.model.handle.z };
    return latticeCentre(box());
  }
}
