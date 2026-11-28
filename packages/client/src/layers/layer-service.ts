import {
  LayerTable,
  type LayerAction,
  type LayerChange,
  type LayerLocks,
  type LayerPatch,
} from "@brr/domain";
import type { Decoded, Issue } from "@brr/schema/decode";
import { BASE_LAYER_ID, type LayerKind } from "@brr/schema/world";
import { injectable } from "inversify";

export interface ILayerService extends LayerLocks {
  subscribe(listener: () => void): () => void;
  table(): LayerTable;
  activeLayer(): number;
  setActiveLayer(id: number): ReadonlyArray<Issue>;
  activeLayerRefusal(): string | null;
  create(name: string, kind: LayerKind): Decoded<number>;
  rename(id: number, name: string): ReadonlyArray<Issue>;
  move(id: number, position: number): ReadonlyArray<Issue>;
  setVisible(id: number, visible: boolean): ReadonlyArray<Issue>;
  setLocked(id: number, locked: boolean): ReadonlyArray<Issue>;
  setOpacity(id: number, percent: number): ReadonlyArray<Issue>;
  onEdit(listener: (change: LayerChange) => void): () => void;
  restore(table: LayerTable): void;
  reset(table: LayerTable): void;
}

function onlyPartsLayer(table: LayerTable, id: number): Issue | null {
  const layer = table.layer(id);
  if (!layer) return { path: `layer ${id}`, message: "isn't in the layer table" };
  if (layer.kind !== "parts") {
    return {
      path: `layer ${id}`,
      message: `is a ${layer.kind} layer, and parts go on a parts layer`,
    };
  }
  return null;
}

@injectable()
export class LayerService implements ILayerService {
  private readonly listeners = new Set<() => void>();
  private readonly editListeners = new Set<(change: LayerChange) => void>();
  private current = LayerTable.base;
  private active = BASE_LAYER_ID;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEdit(listener: (change: LayerChange) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  table(): LayerTable {
    return this.current;
  }

  isLocked(layer: number): boolean {
    return this.current.isLocked(layer);
  }

  activeLayer(): number {
    return this.active;
  }

  setActiveLayer(id: number): ReadonlyArray<Issue> {
    const refused = onlyPartsLayer(this.current, id);
    if (refused) return [refused];
    if (id === this.active) return [];
    this.active = id;
    this.changed();
    return [];
  }

  activeLayerRefusal(): string | null {
    const layer = this.current.layer(this.active);
    if (!layer) throw new Error(`the active layer ${this.active} isn't in the layer table`);
    if (layer.locked) return `Layer "${layer.name}" is locked, so nothing can be added to it.`;
    if (!layer.visible) return `Layer "${layer.name}" is hidden, so nothing can be added to it.`;
    return null;
  }

  create(name: string, kind: LayerKind): Decoded<number> {
    const created = this.current.created(name, kind);
    if (!created.ok) return created;
    const { table, id } = created.value;
    if (kind === "parts") this.active = id;
    this.edit("create", id, table);
    return { ok: true, value: id };
  }

  rename(id: number, name: string): ReadonlyArray<Issue> {
    return this.patch("rename", id, { name });
  }

  move(id: number, position: number): ReadonlyArray<Issue> {
    const moved = this.current.movedTo(id, position);
    if (!moved.ok) return moved.issues;
    this.edit("move", id, moved.value);
    return [];
  }

  setVisible(id: number, visible: boolean): ReadonlyArray<Issue> {
    return this.patch(visible ? "show" : "hide", id, { visible });
  }

  setLocked(id: number, locked: boolean): ReadonlyArray<Issue> {
    return this.patch(locked ? "lock" : "unlock", id, { locked });
  }

  setOpacity(id: number, percent: number): ReadonlyArray<Issue> {
    return this.patch("opacity", id, { opacity: percent });
  }

  restore(table: LayerTable): void {
    if (table === this.current) return;
    this.current = table;
    if (onlyPartsLayer(table, this.active)) this.active = BASE_LAYER_ID;
    this.changed();
  }

  reset(table: LayerTable): void {
    this.current = table;
    this.active = BASE_LAYER_ID;
    this.changed();
  }

  private patch(action: LayerAction, id: number, patch: LayerPatch): ReadonlyArray<Issue> {
    const patched = this.current.patched(id, patch);
    if (!patched.ok) return patched.issues;
    this.edit(action, id, patched.value);
    return [];
  }

  private edit(action: LayerAction, layer: number, after: LayerTable): void {
    const before = this.current;
    if (after === before) return;
    this.current = after;
    this.changed();
    const change: LayerChange = { action, layer, before, after };
    for (const listener of this.editListeners) listener(change);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
