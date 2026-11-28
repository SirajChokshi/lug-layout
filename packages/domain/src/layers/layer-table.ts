import { decode, type Decoded } from "@brr/schema/decode";
import {
  BASE_LAYER,
  LAYER_ID_MAX,
  LayerRecordV2,
  LayerTableV2,
  OPACITY_PERCENT_MAX,
  type LayerKind,
} from "@brr/schema/world";

export type LayerAction =
  | "create"
  | "rename"
  | "move"
  | "show"
  | "hide"
  | "lock"
  | "unlock"
  | "opacity";

export type LayerPatch = Partial<Pick<LayerRecordV2, "name" | "visible" | "locked" | "opacity">>;

export interface CreatedLayer {
  readonly table: LayerTable;
  readonly id: number;
}

const HIDDEN = 1;
const LOCKED = 2;

function refused<T>(path: string, message: string): Decoded<T> {
  return { ok: false, issues: [{ path, message }] };
}

function layerPath(id: number): string {
  return `layer ${id}`;
}

function sameLayer(a: LayerRecordV2, b: LayerRecordV2): boolean {
  return (
    a.name === b.name && a.visible === b.visible && a.locked === b.locked && a.opacity === b.opacity
  );
}

function flagsOf(layers: ReadonlyArray<LayerRecordV2>): Uint8Array {
  let highest = 0;
  for (const layer of layers) highest = Math.max(highest, layer.id);
  const flags = new Uint8Array(highest + 1);
  for (const layer of layers) {
    flags[layer.id] = (layer.visible ? 0 : HIDDEN) | (layer.locked ? LOCKED : 0);
  }
  return flags;
}

function trimmedName<T extends LayerPatch>(patch: T): T {
  return patch.name === undefined ? patch : { ...patch, name: patch.name.trim() };
}

export class LayerTable {
  static readonly base: LayerTable = new LayerTable([BASE_LAYER]);

  private readonly byId: ReadonlyMap<number, LayerRecordV2>;
  private readonly flags: Uint8Array;

  private constructor(readonly layers: ReadonlyArray<LayerRecordV2>) {
    this.byId = new Map(layers.map((layer) => [layer.id, layer]));
    this.flags = flagsOf(layers);
  }

  static of(layers: unknown, path: string): Decoded<LayerTable> {
    const decoded = decode(LayerTableV2, layers, path);
    return decoded.ok ? { ok: true, value: new LayerTable(decoded.value) } : decoded;
  }

  layer(id: number): LayerRecordV2 | undefined {
    return this.byId.get(id);
  }

  isHidden(id: number): boolean {
    return ((this.flags[id] ?? 0) & HIDDEN) !== 0;
  }

  isLocked(id: number): boolean {
    return ((this.flags[id] ?? 0) & LOCKED) !== 0;
  }

  created(name: string, kind: LayerKind): Decoded<CreatedLayer> {
    const id = this.freeId();
    if (id === null) return refused("layers", `already use every layer id 0-${LAYER_ID_MAX}`);
    const record = decode(
      LayerRecordV2,
      {
        id,
        name: name.trim(),
        kind,
        visible: true,
        locked: false,
        opacity: OPACITY_PERCENT_MAX,
      },
      layerPath(id),
    );
    if (!record.ok) return record;
    return { ok: true, value: { table: new LayerTable([...this.layers, record.value]), id } };
  }

  patched(id: number, patch: LayerPatch): Decoded<LayerTable> {
    const layer = this.byId.get(id);
    if (!layer) return this.unlisted(id);
    const record = decode(LayerRecordV2, { ...layer, ...trimmedName(patch) }, layerPath(id));
    if (!record.ok) return record;
    if (sameLayer(record.value, layer)) return { ok: true, value: this };
    const changed = record.value;
    return {
      ok: true,
      value: new LayerTable(this.layers.map((row) => (row.id === id ? changed : row))),
    };
  }

  movedTo(id: number, position: number): Decoded<LayerTable> {
    const layer = this.byId.get(id);
    if (!layer) return this.unlisted(id);
    const last = this.layers.length - 1;
    if (!Number.isSafeInteger(position) || position < 0 || position > last) {
      return refused(layerPath(id), `can only move to a position 0-${last}, not ${position}`);
    }
    if (this.layers[position] === layer) return { ok: true, value: this };
    const order = this.layers.filter((row) => row !== layer);
    order.splice(position, 0, layer);
    return { ok: true, value: new LayerTable(order) };
  }

  private unlisted<T>(id: number): Decoded<T> {
    return refused(layerPath(id), "isn't in the layer table");
  }

  private freeId(): number | null {
    let highest = -1;
    for (const layer of this.layers) highest = Math.max(highest, layer.id);
    if (highest < LAYER_ID_MAX) return highest + 1;
    for (let id = 0; id <= LAYER_ID_MAX; id++) if (!this.byId.has(id)) return id;
    return null;
  }
}

export interface LayerChange {
  readonly action: LayerAction;
  readonly layer: number;
  readonly before: LayerTable;
  readonly after: LayerTable;
}
