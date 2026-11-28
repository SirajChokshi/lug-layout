import { injectable } from "inversify";
import { PLAN_LAYERS, SHEET_LAYER_IDS, type SheetLayerId } from "./plan-drawing.ts";
import {
  DEFAULT_OVERLAP_MM,
  type SheetContent,
  type SheetFormat,
  type SheetLayout,
  type SheetSelection,
} from "./sheet-document.ts";

export interface SheetSet extends SheetSelection {
  readonly id: string;
  readonly layout: SheetLayout;
  readonly format: SheetFormat;
}

export interface SheetSetPatch {
  readonly name?: string;
  readonly content?: SheetContent;
  readonly layers?: ReadonlyArray<SheetLayerId>;
  readonly layout?: SheetLayout;
  readonly format?: SheetFormat;
}

export interface ISheetSets {
  sets(planId: string): ReadonlyArray<SheetSet>;
  add(planId: string): SheetSet;
  update(planId: string, setId: string, patch: SheetSetPatch): void;
  remove(planId: string, setId: string): void;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export const MAIN_PLAN_LAYERS: ReadonlyArray<SheetLayerId> = SHEET_LAYER_IDS.filter((id) =>
  PLAN_LAYERS.has(id),
);

export const TABLE_PLAN_LAYERS: ReadonlyArray<SheetLayerId> = [
  "room",
  "aisles",
  "tables",
  "obstacles",
  "dimensions",
  "table-numbers",
];

export const WHOLE_PLAN_SELECTION: SheetSelection = {
  name: "",
  content: "placements",
  layers: MAIN_PLAN_LAYERS,
};

const MAIN_PLAN: Omit<SheetSet, "id"> = {
  name: "Main plan",
  content: "placements",
  layers: MAIN_PLAN_LAYERS,
  layout: {
    kind: "tiled",
    paper: "a4",
    orientation: "auto",
    denominator: 1,
    overlapMm: DEFAULT_OVERLAP_MM,
  },
  format: "pdf",
};

const TABLE_PLAN: Omit<SheetSet, "id"> = {
  name: "Table plan",
  content: "tables",
  layers: TABLE_PLAN_LAYERS,
  layout: { kind: "fit", paper: "a3", orientation: "auto" },
  format: "pdf",
};

function canonicalLayers(layers: ReadonlyArray<SheetLayerId>): ReadonlyArray<SheetLayerId> {
  const chosen = new Set(layers);
  return SHEET_LAYER_IDS.filter((id) => chosen.has(id));
}

@injectable()
export class SheetSets implements ISheetSets {
  private readonly byPlan = new Map<string, ReadonlyArray<SheetSet>>();
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  private revision = 0;

  sets(planId: string): ReadonlyArray<SheetSet> {
    const known = this.byPlan.get(planId);
    if (known) return known;
    const defaults = [this.created(MAIN_PLAN), this.created(TABLE_PLAN)];
    this.byPlan.set(planId, defaults);
    return defaults;
  }

  add(planId: string): SheetSet {
    const current = this.sets(planId);
    const names = new Set(current.map((set) => set.name));
    let n = current.length + 1;
    while (names.has(`Sheet ${n}`)) n++;
    const added = this.created({ ...MAIN_PLAN, name: `Sheet ${n}` });
    this.byPlan.set(planId, [...current, added]);
    this.changed();
    return added;
  }

  update(planId: string, setId: string, patch: SheetSetPatch): void {
    const current = this.sets(planId);
    if (!current.some((set) => set.id === setId)) throw new Error(`no sheet set ${setId}`);
    this.byPlan.set(
      planId,
      current.map((set) =>
        set.id === setId
          ? {
              ...set,
              ...patch,
              layers: canonicalLayers(patch.layers ?? set.layers),
            }
          : set,
      ),
    );
    this.changed();
  }

  remove(planId: string, setId: string): void {
    const current = this.sets(planId);
    this.byPlan.set(
      planId,
      current.filter((set) => set.id !== setId),
    );
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  version(): number {
    return this.revision;
  }

  private created(template: Omit<SheetSet, "id">): SheetSet {
    this.serial += 1;
    return { ...template, id: `sheet-${this.serial}` };
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
