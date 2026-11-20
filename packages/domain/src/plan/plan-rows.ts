import { FACT_STRIDE, clearFacts } from "./plan-facts.ts";
import { BOX_STRIDE, type PlacementKey } from "./plan-rules.ts";
import { NO_SHAPE, ShapeTable, type PlanShape } from "./plan-shape.ts";

export const MODEL_SEGMENT = 0;
export const TRACK_SEGMENT = 1;
export const NO_ROW = -1;
export const BOX_READ = 0;
export const BOX_Y_UNREADABLE = 1;
export const BOX_PLAN_UNREADABLE = 2;
export const LABEL_AT = 0;
export const LABEL_NUMBERED = 1;

const SEGMENTS = 2;
const INITIAL_ROWS = 64;
const INITIAL_SLOTS = 128;
const HASH_MULTIPLIER = 0x9e3779b1;
const LIVE_LIMIT = 0.5;
const SLOT_EMPTY = 0;
const SLOT_LIVE = 1;

function grownInt32(
  array: Int32Array<ArrayBuffer>,
  length: number,
  fill = 0,
): Int32Array<ArrayBuffer> {
  const grown = new Int32Array(length).fill(fill);
  grown.set(array);
  return grown;
}

function grownUint8(array: Uint8Array<ArrayBuffer>, length: number): Uint8Array<ArrayBuffer> {
  const grown = new Uint8Array(length);
  grown.set(array);
  return grown;
}

function grownFloat64(array: Float64Array<ArrayBuffer>, length: number): Float64Array<ArrayBuffer> {
  const grown = new Float64Array(length);
  grown.set(array);
  return grown;
}

class StringTable {
  private readonly ids = new Map<string, number>();
  private readonly values: string[] = [];

  intern(value: string): number {
    const known = this.ids.get(value);
    if (known !== undefined) return known;
    const id = this.values.length;
    this.values.push(value);
    this.ids.set(value, id);
    return id;
  }

  value(id: number): string {
    return this.values[id] ?? "";
  }
}

class IdTable {
  private keys: Int32Array;
  private rows: Int32Array;
  private state: Uint8Array;
  private live = 0;

  constructor(slots: number) {
    this.keys = new Int32Array(slots);
    this.rows = new Int32Array(slots);
    this.state = new Uint8Array(slots);
  }

  private home(key: number, slots: number): number {
    return (Math.imul(key, HASH_MULTIPLIER) >>> 0) & (slots - 1);
  }

  private slotOf(key: number): number {
    const slots = this.state.length;
    for (let i = this.home(key, slots), probes = 0; probes < slots; probes++) {
      if (this.state[i] === SLOT_EMPTY) return NO_ROW;
      if (this.keys[i] === key) return i;
      i = (i + 1) & (slots - 1);
    }
    return NO_ROW;
  }

  get(key: number): number {
    const slot = this.slotOf(key);
    return slot === NO_ROW ? NO_ROW : (this.rows[slot] ?? NO_ROW);
  }

  set(key: number, row: number): void {
    if (this.live + 1 > this.state.length * LIVE_LIMIT) this.resize(this.state.length * 2);
    this.insert(key, row);
  }

  delete(key: number): void {
    let hole = this.slotOf(key);
    if (hole === NO_ROW) return;
    const slots = this.state.length;
    const mask = slots - 1;
    for (let next = (hole + 1) & mask; this.state[next] === SLOT_LIVE; next = (next + 1) & mask) {
      const nextKey = this.keys[next] ?? 0;
      const fromHome = (next - this.home(nextKey, slots)) & mask;
      if (fromHome < ((next - hole) & mask)) continue;
      this.keys[hole] = nextKey;
      this.rows[hole] = this.rows[next] ?? NO_ROW;
      hole = next;
    }
    this.state[hole] = SLOT_EMPTY;
    this.live--;
  }

  clear(): void {
    this.state.fill(SLOT_EMPTY);
    this.live = 0;
  }

  private insert(key: number, row: number): void {
    const slots = this.state.length;
    for (let i = this.home(key, slots), probes = 0; probes < slots; probes++) {
      if (this.state[i] === SLOT_EMPTY) {
        this.keys[i] = key;
        this.rows[i] = row;
        this.state[i] = SLOT_LIVE;
        this.live++;
        return;
      }
      if (this.keys[i] === key) {
        this.rows[i] = row;
        return;
      }
      i = (i + 1) & (slots - 1);
    }
    throw new Error("plan row id table is full");
  }

  private resize(slots: number): void {
    const keys = this.keys;
    const rows = this.rows;
    const state = this.state;
    this.keys = new Int32Array(slots);
    this.rows = new Int32Array(slots);
    this.state = new Uint8Array(slots);
    this.live = 0;
    for (let i = 0; i < state.length; i++) {
      if (state[i] === SLOT_LIVE) this.insert(keys[i] ?? 0, rows[i] ?? NO_ROW);
    }
  }
}

export class RowList {
  prev: Int32Array<ArrayBuffer>;
  next: Int32Array<ArrayBuffer>;
  private readonly heads = new Int32Array(SEGMENTS).fill(NO_ROW);
  private readonly tails = new Int32Array(SEGMENTS).fill(NO_ROW);

  constructor(capacity: number) {
    this.prev = new Int32Array(capacity).fill(NO_ROW);
    this.next = new Int32Array(capacity).fill(NO_ROW);
  }

  grow(capacity: number): void {
    if (this.prev.length >= capacity) return;
    this.prev = grownInt32(this.prev, capacity, NO_ROW);
    this.next = grownInt32(this.next, capacity, NO_ROW);
  }

  clear(): void {
    this.heads.fill(NO_ROW);
    this.tails.fill(NO_ROW);
  }

  first(): number {
    const models = this.heads[MODEL_SEGMENT] ?? NO_ROW;
    return models === NO_ROW ? (this.heads[TRACK_SEGMENT] ?? NO_ROW) : models;
  }

  after(rows: PlanRows, row: number): number {
    const next = this.next[row] ?? NO_ROW;
    if (next !== NO_ROW || rows.segment[row] === TRACK_SEGMENT) return next;
    return this.heads[TRACK_SEGMENT] ?? NO_ROW;
  }

  link(rows: PlanRows, row: number): void {
    this.linkAfter(rows, row, rows.segment[row] === TRACK_SEGMENT);
  }

  linkInOrder(rows: PlanRows, row: number): void {
    this.linkAfter(rows, row, true);
  }

  private linkAfter(rows: PlanRows, row: number, bySource: boolean): void {
    const segment = rows.segment[row] ?? MODEL_SEGMENT;
    let before = this.tails[segment] ?? NO_ROW;
    if (bySource) {
      const source = rows.source[row] ?? 0;
      while (before !== NO_ROW && (rows.source[before] ?? 0) > source) {
        before = this.prev[before] ?? NO_ROW;
      }
    }
    const after =
      before === NO_ROW ? (this.heads[segment] ?? NO_ROW) : (this.next[before] ?? NO_ROW);
    this.prev[row] = before;
    this.next[row] = after;
    if (before === NO_ROW) this.heads[segment] = row;
    else this.next[before] = row;
    if (after === NO_ROW) this.tails[segment] = row;
    else this.prev[after] = row;
  }

  unlink(rows: PlanRows, row: number): void {
    const segment = rows.segment[row] ?? MODEL_SEGMENT;
    const before = this.prev[row] ?? NO_ROW;
    const after = this.next[row] ?? NO_ROW;
    if (before === NO_ROW) this.heads[segment] = after;
    else this.next[before] = after;
    if (after === NO_ROW) this.tails[segment] = before;
    else this.prev[after] = before;
    this.prev[row] = NO_ROW;
    this.next[row] = NO_ROW;
  }
}

export class PlanRows {
  capacity = INITIAL_ROWS;
  count = 0;
  chunkKey = new Float64Array(INITIAL_ROWS);
  slot = new Int32Array(INITIAL_ROWS);
  ref = new Int32Array(INITIAL_ROWS);
  labelBase = new Int32Array(INITIAL_ROWS);
  labelKind = new Uint8Array(INITIAL_ROWS);
  labelA = new Float64Array(INITIAL_ROWS);
  labelB = new Float64Array(INITIAL_ROWS);
  box = new Float64Array(INITIAL_ROWS * BOX_STRIDE);
  segment = new Uint8Array(INITIAL_ROWS);
  source = new Int32Array(INITIAL_ROWS);
  boxState = new Uint8Array(INITIAL_ROWS);
  unsupported = new Uint8Array(INITIAL_ROWS);
  shape = new Int32Array(INITIAL_ROWS).fill(NO_SHAPE);
  facts = new Int32Array(INITIAL_ROWS * FACT_STRIDE);
  readonly shapes = new ShapeTable();
  readonly order = new RowList(INITIAL_ROWS);
  private free = new Int32Array(INITIAL_ROWS);
  private freeCount = 0;
  private allocated = 0;
  private readonly models = new IdTable(INITIAL_SLOTS);
  private trackRows = new Int32Array(INITIAL_ROWS).fill(NO_ROW);
  private readonly strings = new StringTable();

  add(segment: number, source: number): number {
    const row = this.allocate();
    this.segment[row] = segment;
    this.source[row] = source;
    this.unsupported[row] = 0;
    this.shape[row] = NO_SHAPE;
    clearFacts(this.facts, row * FACT_STRIDE);
    if (segment === TRACK_SEGMENT) this.setTrackRow(source, row);
    else this.models.set(source, row);
    this.order.link(this, row);
    this.count++;
    return row;
  }

  remove(row: number): void {
    this.order.unlink(this, row);
    const source = this.source[row] ?? 0;
    if (this.segment[row] === TRACK_SEGMENT) this.trackRows[source] = NO_ROW;
    else this.models.delete(source);
    this.free[this.freeCount++] = row;
    this.count--;
  }

  clear(): void {
    this.order.clear();
    this.models.clear();
    this.trackRows.fill(NO_ROW);
    this.freeCount = 0;
    this.allocated = 0;
    this.count = 0;
  }

  find(segment: number, source: number): number {
    if (segment === TRACK_SEGMENT) return this.trackRows[source] ?? NO_ROW;
    return this.models.get(source);
  }

  first(): number {
    return this.order.first();
  }

  after(row: number): number {
    return this.order.after(this, row);
  }

  write(row: number, slot: number, ref: string, labelKind: number, labelBase: string): void {
    this.slot[row] = slot;
    this.ref[row] = this.strings.intern(ref);
    this.labelKind[row] = labelKind;
    this.labelBase[row] = this.strings.intern(labelBase);
  }

  shapeOf(row: number): PlanShape | null {
    return this.shapes.at(this.shape[row] ?? NO_SHAPE);
  }

  refOf(row: number): string {
    return this.strings.value(this.ref[row] ?? 0);
  }

  labelOf(row: number): string {
    const base = this.strings.value(this.labelBase[row] ?? 0);
    const a = this.labelA[row] ?? 0;
    if (this.labelKind[row] === LABEL_NUMBERED) return `${base} #${a}`;
    return `${base} at ${a}, ${this.labelB[row] ?? 0}`;
  }

  keyOf(row: number): PlacementKey {
    return { chunkKey: this.chunkKey[row] ?? 0, slot: this.slot[row] ?? 0 };
  }

  private allocate(): number {
    if (this.freeCount > 0) return this.free[--this.freeCount] ?? NO_ROW;
    if (this.allocated === this.capacity) this.grow(this.capacity * 2);
    return this.allocated++;
  }

  private grow(capacity: number): void {
    this.chunkKey = grownFloat64(this.chunkKey, capacity);
    this.slot = grownInt32(this.slot, capacity);
    this.ref = grownInt32(this.ref, capacity);
    this.labelBase = grownInt32(this.labelBase, capacity);
    this.labelKind = grownUint8(this.labelKind, capacity);
    this.labelA = grownFloat64(this.labelA, capacity);
    this.labelB = grownFloat64(this.labelB, capacity);
    this.box = grownFloat64(this.box, capacity * BOX_STRIDE);
    this.segment = grownUint8(this.segment, capacity);
    this.source = grownInt32(this.source, capacity);
    this.boxState = grownUint8(this.boxState, capacity);
    this.unsupported = grownUint8(this.unsupported, capacity);
    this.shape = grownInt32(this.shape, capacity, NO_SHAPE);
    this.facts = grownInt32(this.facts, capacity * FACT_STRIDE);
    this.free = grownInt32(this.free, capacity);
    this.order.grow(capacity);
    this.capacity = capacity;
  }

  private setTrackRow(index: number, row: number): void {
    if (index >= this.trackRows.length) {
      let length = this.trackRows.length;
      while (length <= index) length *= 2;
      this.trackRows = grownInt32(this.trackRows, length, NO_ROW);
    }
    this.trackRows[index] = row;
  }
}
