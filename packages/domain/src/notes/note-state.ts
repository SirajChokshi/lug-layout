import { isRot90, rot90Cos, rot90Sin, type Rot90 } from "@brr/math";
import type {
  ModelEndV2,
  NoteRecordV2,
  PlacementRecordV1,
  RulerEndV2,
  RulerNoteV2,
} from "@brr/schema/world";

export interface NoteEntry {
  readonly id: string;
  readonly note: NoteRecordV2;
}

export type NoteState = ReadonlyArray<NoteEntry>;

export interface NoteChange {
  readonly before: NoteState;
  readonly after: NoteState;
}

export interface NotePoint {
  readonly x: number;
  readonly z: number;
}

export interface NoteSpan {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
}

export interface PlacementMove {
  readonly before: PlacementRecordV1;
  readonly after: PlacementRecordV1 | null;
}

function quarterTurn(rot: number): Rot90 {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  return rot;
}

export function rulerEndPoint(end: RulerEndV2): NotePoint {
  if (end.on === "point") return { x: end.x, z: end.z };
  const rot = quarterTurn(end.rot);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  return {
    x: end.x + cos * end.offsetX + sin * end.offsetZ + 0,
    z: end.z - sin * end.offsetX + cos * end.offsetZ + 0,
  };
}

export function rulerSpan(ruler: RulerNoteV2): NoteSpan {
  const a = rulerEndPoint(ruler.from);
  const b = rulerEndPoint(ruler.to);
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z };
}

export function modelEnd(placement: PlacementRecordV1, point: NotePoint): ModelEndV2 {
  const rot = quarterTurn(placement.rot);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const dx = point.x - placement.x;
  const dz = point.z - placement.z;
  return {
    on: "model",
    ref: placement.ref,
    color: placement.color,
    x: placement.x,
    z: placement.z,
    yPlates: placement.yPlates,
    rot: placement.rot,
    offsetX: cos * dx - sin * dz + 0,
    offsetZ: sin * dx + cos * dz + 0,
  };
}

export function namesPlacement(end: ModelEndV2, placement: PlacementRecordV1): boolean {
  return (
    end.ref === placement.ref &&
    end.color === placement.color &&
    end.x === placement.x &&
    end.z === placement.z &&
    end.yPlates === placement.yPlates &&
    end.rot === placement.rot
  );
}

export function attachedEnds(note: NoteRecordV2): ReadonlyArray<ModelEndV2> {
  if (note.kind !== "ruler") return [];
  const ends: ModelEndV2[] = [];
  if (note.from.on === "model") ends.push(note.from);
  if (note.to.on === "model") ends.push(note.to);
  return ends;
}

function sameEnd(a: RulerEndV2, b: RulerEndV2): boolean {
  if (a.on === "point" && b.on === "point") return a.x === b.x && a.z === b.z;
  if (a.on === "model" && b.on === "model") {
    return namesPlacement(a, b) && a.offsetX === b.offsetX && a.offsetZ === b.offsetZ;
  }
  return false;
}

function followedEnd(end: RulerEndV2, moves: ReadonlyArray<PlacementMove>): RulerEndV2 {
  if (end.on !== "model") return end;
  const move = moves.find((candidate) => namesPlacement(end, candidate.before));
  if (!move) return end;
  if (move.after === null) return { on: "point", ...rulerEndPoint(end) };
  if (namesPlacement(end, move.after)) return end;
  return {
    on: "model",
    ref: move.after.ref,
    color: move.after.color,
    x: move.after.x,
    z: move.after.z,
    yPlates: move.after.yPlates,
    rot: move.after.rot,
    offsetX: end.offsetX,
    offsetZ: end.offsetZ,
  };
}

function reindexed(entries: ReadonlyArray<NoteEntry>): NoteEntry[] {
  return entries.map((entry, index) =>
    entry.note.index === index ? entry : { id: entry.id, note: { ...entry.note, index } },
  );
}

export function followPlacements(state: NoteState, moves: ReadonlyArray<PlacementMove>): NoteState {
  let changed = false;
  const kept: NoteEntry[] = [];
  for (const entry of state) {
    const { note } = entry;
    if (note.kind !== "ruler") {
      kept.push(entry);
      continue;
    }
    const from = followedEnd(note.from, moves);
    const to = followedEnd(note.to, moves);
    if (from === note.from && to === note.to) {
      kept.push(entry);
      continue;
    }
    changed = true;
    if (!sameEnd(from, to)) kept.push({ id: entry.id, note: { ...note, from, to } });
  }
  return changed ? reindexed(kept) : state;
}

type WithoutIndex<Note> = Note extends unknown ? Omit<Note, "index"> : never;

export type NoteBody = WithoutIndex<NoteRecordV2>;

export function noteAt(body: NoteBody, index: number): NoteRecordV2 {
  return { ...body, index };
}

export function withNote(state: NoteState, id: string, body: NoteBody): NoteState {
  return [...state, { id, note: noteAt(body, state.length) }];
}

export function withReplacedNote(state: NoteState, id: string, body: NoteBody): NoteState {
  return state.map((entry) =>
    entry.id === id ? { id, note: noteAt(body, entry.note.index) } : entry,
  );
}

export function withoutNote(state: NoteState, id: string): NoteState {
  const kept = state.filter((entry) => entry.id !== id);
  return kept.length === state.length ? state : reindexed(kept);
}
