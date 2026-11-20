import { FACT_STRIDE, clearFacts } from "./plan-facts.ts";
import { BOX_STRIDE } from "./plan-rules.ts";
import { BOX_READ } from "./plan-rows.ts";
import type { PlanShape } from "./plan-shape.ts";
import { TrackIssueRows } from "./track-issue-rows.ts";
import type { TrackOutline } from "./track-outline.ts";

export const WRITE_ADD = 0;
export const WRITE_UPDATE = 1;

const INITIAL_ENTRIES = 16;

function roomUint8(array: Uint8Array<ArrayBuffer>, length: number): Uint8Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const grown = new Uint8Array(Math.max(length, array.length * 2));
  grown.set(array);
  return grown;
}

function roomInt32(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const grown = new Int32Array(Math.max(length, array.length * 2));
  grown.set(array);
  return grown;
}

function roomFloat64(array: Float64Array<ArrayBuffer>, length: number): Float64Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const grown = new Float64Array(Math.max(length, array.length * 2));
  grown.set(array);
  return grown;
}

export class PlanDelta {
  cleared = false;
  removalCount = 0;
  removalSegment = new Uint8Array(INITIAL_ENTRIES);
  removalSource = new Int32Array(INITIAL_ENTRIES);
  writeCount = 0;
  writeKind = new Uint8Array(INITIAL_ENTRIES);
  writeSegment = new Uint8Array(INITIAL_ENTRIES);
  writeSource = new Int32Array(INITIAL_ENTRIES);
  chunkKey = new Float64Array(INITIAL_ENTRIES);
  slot = new Int32Array(INITIAL_ENTRIES);
  labelKind = new Uint8Array(INITIAL_ENTRIES);
  labelA = new Float64Array(INITIAL_ENTRIES);
  labelB = new Float64Array(INITIAL_ENTRIES);
  box = new Float64Array(INITIAL_ENTRIES * BOX_STRIDE);
  boxState = new Uint8Array(INITIAL_ENTRIES);
  facts = new Int32Array(INITIAL_ENTRIES * FACT_STRIDE);
  readonly shape: Array<PlanShape | null> = [];
  readonly outline: Array<TrackOutline | null> = [];
  readonly ref: string[] = [];
  readonly labelBase: string[] = [];
  readonly original: unknown[] = [];
  readonly caught: unknown[] = [];
  trackIssuesWritten = false;
  readonly trackIssues = new TrackIssueRows();

  reset(): void {
    this.cleared = false;
    this.removalCount = 0;
    this.writeCount = 0;
    this.trackIssuesWritten = false;
  }

  writeTrackIssues(): TrackIssueRows {
    this.trackIssues.clear();
    this.trackIssuesWritten = true;
    return this.trackIssues;
  }

  clearAll(): void {
    this.cleared = true;
  }

  remove(segment: number, source: number): void {
    const at = this.removalCount++;
    this.removalSegment = roomUint8(this.removalSegment, at + 1);
    this.removalSource = roomInt32(this.removalSource, at + 1);
    this.removalSegment[at] = segment;
    this.removalSource[at] = source;
  }

  write(
    kind: number,
    segment: number,
    source: number,
    slot: number,
    ref: string,
    labelKind: number,
    labelBase: string,
  ): number {
    const at = this.writeCount++;
    this.reserve(at + 1);
    this.writeKind[at] = kind;
    this.writeSegment[at] = segment;
    this.writeSource[at] = source;
    this.slot[at] = slot;
    this.ref[at] = ref;
    this.labelKind[at] = labelKind;
    this.labelBase[at] = labelBase;
    this.boxState[at] = BOX_READ;
    this.shape[at] = null;
    this.outline[at] = null;
    clearFacts(this.facts, at * FACT_STRIDE);
    this.original[at] = undefined;
    this.caught[at] = undefined;
    return at;
  }

  markUnreadable(entry: number, state: number, original: unknown, caught: unknown): void {
    this.boxState[entry] = state;
    this.original[entry] = original;
    this.caught[entry] = caught;
  }

  private reserve(entries: number): void {
    this.writeKind = roomUint8(this.writeKind, entries);
    this.writeSegment = roomUint8(this.writeSegment, entries);
    this.writeSource = roomInt32(this.writeSource, entries);
    this.chunkKey = roomFloat64(this.chunkKey, entries);
    this.slot = roomInt32(this.slot, entries);
    this.labelKind = roomUint8(this.labelKind, entries);
    this.labelA = roomFloat64(this.labelA, entries);
    this.labelB = roomFloat64(this.labelB, entries);
    this.box = roomFloat64(this.box, entries * BOX_STRIDE);
    this.boxState = roomUint8(this.boxState, entries);
    this.facts = roomInt32(this.facts, entries * FACT_STRIDE);
  }
}
