import type { WorldBox } from "@brr/render";
import { latticeCentre, unionBox, type LatticePoint } from "./group-transform.ts";
import type { PlacedModel } from "./placed-chunks.ts";

export interface SelectedModelView {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
  readonly chunkKey: number;
  readonly slot: number;
  readonly box: WorldBox;
}

export interface SelectionView {
  readonly primary: SelectedModelView;
  readonly members: ReadonlyArray<SelectedModelView>;
  readonly box: WorldBox;
}

function memberView(model: PlacedModel): SelectedModelView {
  const { handle } = model;
  return {
    item: model.placeable.id,
    x: handle.x,
    z: handle.z,
    yPlates: handle.yPlates,
    rot: handle.rot,
    chunkKey: handle.chunkKey,
    slot: handle.slot,
    box: model.box,
  };
}

export class Selection {
  private picked: ReadonlyArray<PlacedModel> = [];
  private pivot: LatticePoint | null = null;

  get members(): ReadonlyArray<PlacedModel> {
    return this.picked;
  }

  get primary(): PlacedModel | null {
    return this.picked.at(-1) ?? null;
  }

  has(model: PlacedModel): boolean {
    return this.picked.includes(model);
  }

  replace(members: ReadonlyArray<PlacedModel>, pivot: LatticePoint | null): void {
    this.picked = [...new Set(members)];
    this.pivot = pivot;
  }

  toggle(model: PlacedModel): void {
    this.replace(
      this.has(model) ? this.picked.filter((member) => member !== model) : [...this.picked, model],
      null,
    );
  }

  swap(previous: PlacedModel, next: PlacedModel): void {
    this.picked = this.picked.map((member) => (member === previous ? next : member));
  }

  dropRemoved(): boolean {
    const live = this.picked.filter((model) => model.handle.live);
    if (live.length === this.picked.length) return false;
    this.replace(live, null);
    return true;
  }

  turnPivot(): LatticePoint | null {
    const [only, second] = this.picked;
    if (!only) return null;
    if (this.pivot) return this.pivot;
    if (!second) return { x: only.handle.x, z: only.handle.z };
    return latticeCentre(unionBox(this.boxes()));
  }

  boxes(): ReadonlyArray<WorldBox> {
    return this.picked.map((model) => model.box);
  }

  view(): SelectionView | null {
    const primary = this.primary;
    if (!primary) return null;
    return {
      primary: memberView(primary),
      members: this.picked.map(memberView),
      box: unionBox(this.boxes()),
    };
  }
}
