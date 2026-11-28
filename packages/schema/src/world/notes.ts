import * as v from "valibot";
import {
  Count,
  LatticeLdu,
  Ldu,
  NOTE_SHARD_FORMAT,
  QuarterTurn,
  SafeInteger,
  SuperChunk,
  ascendingSuperChunks,
  byIndex,
  compareSuperChunks,
  schemaVersionField,
  shardName,
  strictMessage,
  superChunkOf,
} from "./fields.ts";
import { ContributorId, Label, LayerId, LongText, Rgb } from "./document.ts";
import { PlacementRecordV1 } from "./v1.ts";

export const ZONE_VERTEX_MIN = 3;
export const ZONE_VERTEX_MAX = 4096;
export const TEXT_HEIGHT_STUDS_MAX = 256;
export const NOTE_KINDS = ["zone", "text", "ruler", "legend"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

const NoteFields = {
  index: Count,
  layer: LayerId,
  owner: v.exactOptional(ContributorId),
};

export const StudPoint = v.strictTuple([LatticeLdu, LatticeLdu], strictMessage);
export type StudPoint = v.InferOutput<typeof StudPoint>;

function twiceSignedArea(outline: ReadonlyArray<Readonly<StudPoint>>): bigint {
  let sum = 0n;
  for (let i = 0; i < outline.length; i++) {
    const from = outline[i];
    const to = outline[(i + 1) % outline.length];
    if (from && to) sum += BigInt(from[0]) * BigInt(to[1]) - BigInt(to[0]) * BigInt(from[1]);
  }
  return sum;
}

function samePoint(a: Readonly<StudPoint>, b: Readonly<StudPoint>): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function noVertexTwiceInARow(outline: ReadonlyArray<Readonly<StudPoint>>): boolean {
  return outline.every((point, i) => {
    const next = outline[(i + 1) % outline.length];
    return next === undefined || !samePoint(point, next);
  });
}

const Outline = v.pipe(
  v.array(StudPoint),
  v.minLength(ZONE_VERTEX_MIN, `must have at least ${ZONE_VERTEX_MIN} corners`),
  v.maxLength(ZONE_VERTEX_MAX, `must have at most ${ZONE_VERTEX_MAX} corners`),
  v.check((outline) => noVertexTwiceInARow(outline), "repeats a corner back to back"),
  v.check((outline) => twiceSignedArea(outline) !== 0n, "encloses no area"),
);

export const ZoneNoteV2 = v.strictObject(
  { kind: v.literal("zone"), ...NoteFields, name: Label, color: Rgb, outline: Outline },
  strictMessage,
);
export type ZoneNoteV2 = v.InferOutput<typeof ZoneNoteV2>;

export const TextNoteV2 = v.strictObject(
  {
    kind: v.literal("text"),
    ...NoteFields,
    text: LongText,
    x: LatticeLdu,
    z: LatticeLdu,
    rot: QuarterTurn,
    heightStuds: v.config(
      v.pipe(
        SafeInteger,
        v.minValue(1, `must be 1-${TEXT_HEIGHT_STUDS_MAX} studs`),
        v.maxValue(TEXT_HEIGHT_STUDS_MAX, `must be 1-${TEXT_HEIGHT_STUDS_MAX} studs`),
      ),
      { abortPipeEarly: true },
    ),
    color: Rgb,
  },
  strictMessage,
);
export type TextNoteV2 = v.InferOutput<typeof TextNoteV2>;

export const PointEndV2 = v.strictObject({ on: v.literal("point"), x: Ldu, z: Ldu }, strictMessage);
export type PointEndV2 = v.InferOutput<typeof PointEndV2>;

export const ModelEndV2 = v.strictObject(
  { on: v.literal("model"), ...PlacementRecordV1.entries, offsetX: Ldu, offsetZ: Ldu },
  strictMessage,
);
export type ModelEndV2 = v.InferOutput<typeof ModelEndV2>;

export const RulerEndV2 = v.variant("on", [PointEndV2, ModelEndV2], (issue) =>
  issue.received === "undefined" ? "is missing" : `must be "point" or "model"`,
);
export type RulerEndV2 = v.InferOutput<typeof RulerEndV2>;

function sameEnd(a: RulerEndV2, b: RulerEndV2): boolean {
  if (a.on === "point" && b.on === "point") return a.x === b.x && a.z === b.z;
  if (a.on === "model" && b.on === "model") {
    return (
      a.ref === b.ref &&
      a.color === b.color &&
      a.x === b.x &&
      a.z === b.z &&
      a.yPlates === b.yPlates &&
      a.rot === b.rot &&
      a.offsetX === b.offsetX &&
      a.offsetZ === b.offsetZ
    );
  }
  return false;
}

export const RulerNoteV2 = v.pipe(
  v.strictObject(
    { kind: v.literal("ruler"), ...NoteFields, from: RulerEndV2, to: RulerEndV2, color: Rgb },
    strictMessage,
  ),
  v.forward(
    v.partialCheck(
      [["from"], ["to"]],
      (ruler) => !sameEnd(ruler.from, ruler.to),
      "is the same end as from: the ruler measures nothing",
    ),
    ["to"],
  ),
);
export type RulerNoteV2 = v.InferOutput<typeof RulerNoteV2>;

export const LegendEntryV2 = v.strictObject({ color: Rgb, label: Label }, strictMessage);

export const LegendNoteV2 = v.strictObject(
  {
    kind: v.literal("legend"),
    ...NoteFields,
    x: LatticeLdu,
    z: LatticeLdu,
    title: v.exactOptional(Label),
    entries: v.pipe(v.array(LegendEntryV2), v.minLength(1, "is empty: a legend needs a row")),
  },
  strictMessage,
);
export type LegendNoteV2 = v.InferOutput<typeof LegendNoteV2>;

export const NoteRecordV2 = v.variant(
  "kind",
  [ZoneNoteV2, TextNoteV2, RulerNoteV2, LegendNoteV2],
  (issue) =>
    issue.received === "undefined"
      ? "is missing"
      : `must be ${NOTE_KINDS.map((kind) => `"${kind}"`).join(", ")}`,
);
export type NoteRecordV2 = v.InferOutput<typeof NoteRecordV2>;

export interface NoteAnchor {
  readonly x: number;
  readonly z: number;
}

function outlineCorner(outline: ReadonlyArray<Readonly<StudPoint>>): NoteAnchor {
  let x = Number.POSITIVE_INFINITY;
  let z = Number.POSITIVE_INFINITY;
  for (const [pointX, pointZ] of outline) {
    x = Math.min(x, pointX);
    z = Math.min(z, pointZ);
  }
  return { x, z };
}

export function noteAnchor(note: NoteRecordV2): NoteAnchor {
  switch (note.kind) {
    case "zone":
      return outlineCorner(note.outline);
    case "text":
    case "legend":
      return { x: note.x, z: note.z };
    case "ruler":
      return { x: note.from.x, z: note.from.z };
    default: {
      const unhandled: never = note;
      throw new Error(`unhandled note ${String(unhandled)}`);
    }
  }
}

function notesInside(
  superChunk: Readonly<SuperChunk>,
  notes: ReadonlyArray<NoteRecordV2>,
): boolean {
  return notes.every((note) => {
    const anchor = noteAnchor(note);
    return compareSuperChunks(superChunkOf(anchor.x, anchor.z), superChunk) === 0;
  });
}

export const NoteShardV2 = v.pipe(
  v.strictObject(
    {
      format: v.literal(NOTE_SHARD_FORMAT, `must be "${NOTE_SHARD_FORMAT}"`),
      schemaVersion: schemaVersionField(2),
      superChunk: SuperChunk,
      notes: v.array(NoteRecordV2),
    },
    strictMessage,
  ),
  v.check((shard) => shard.notes.length > 0, "must hold a note"),
  v.forward(
    v.partialCheck(
      [["superChunk"], ["notes"]],
      (shard) => notesInside(shard.superChunk, shard.notes),
      "must all be anchored inside the shard's super-chunk",
    ),
    ["notes"],
  ),
);
export type NoteShardV2 = v.InferOutput<typeof NoteShardV2>;

export const NoteShardEntryV2 = v.pipe(
  v.strictObject({ superChunk: SuperChunk, notes: Count }, strictMessage),
  v.check((entry) => entry.notes > 0, "must hold a note"),
);
export type NoteShardEntryV2 = v.InferOutput<typeof NoteShardEntryV2>;

export const NoteShardListV2 = v.pipe(
  v.array(NoteShardEntryV2),
  v.check(
    (entries) => ascendingSuperChunks(entries),
    "must list super-chunks in strictly ascending order",
  ),
);

function compareCorners(a: Readonly<StudPoint>, b: Readonly<StudPoint>): number {
  return a[0] - b[0] || a[1] - b[1];
}

function compareRotations(corners: ReadonlyArray<StudPoint>, a: number, b: number): number {
  for (let step = 0; step < corners.length; step++) {
    const fromA = corners[(a + step) % corners.length];
    const fromB = corners[(b + step) % corners.length];
    const order = fromA && fromB ? compareCorners(fromA, fromB) : 0;
    if (order !== 0) return order;
  }
  return 0;
}

export function canonicalOutline(outline: ReadonlyArray<Readonly<StudPoint>>): StudPoint[] {
  const corners: StudPoint[] = outline.map(([x, z]) => [x, z]);
  if (twiceSignedArea(corners) < 0n) corners.reverse();
  let start = 0;
  for (let i = 1; i < corners.length; i++) {
    if (compareRotations(corners, i, start) < 0) start = i;
  }
  return [...corners.slice(start), ...corners.slice(0, start)];
}

function canonicalNote(note: NoteRecordV2): NoteRecordV2 {
  return note.kind === "zone" ? { ...note, outline: canonicalOutline(note.outline) } : note;
}

export function noteShard(superChunk: SuperChunk, notes: ReadonlyArray<NoteRecordV2>): NoteShardV2 {
  return {
    format: NOTE_SHARD_FORMAT,
    schemaVersion: 2,
    superChunk,
    notes: byIndex(notes).map(canonicalNote),
  };
}

export function noteShards(notes: ReadonlyArray<NoteRecordV2>): NoteShardV2[] {
  const groups = new Map<string, { superChunk: SuperChunk; notes: NoteRecordV2[] }>();
  for (const note of notes) {
    const anchor = noteAnchor(note);
    const superChunk = superChunkOf(anchor.x, anchor.z);
    const name = shardName(superChunk);
    const group = groups.get(name) ?? { superChunk, notes: [] };
    group.notes.push(note);
    groups.set(name, group);
  }
  const shards = [...groups.values()].map((group) => noteShard(group.superChunk, group.notes));
  shards.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return shards;
}

export function worldNotes(shards: ReadonlyArray<NoteShardV2>): NoteRecordV2[] {
  return byIndex(shards.flatMap((shard) => shard.notes));
}

export function noteShardEntry(shard: NoteShardV2): NoteShardEntryV2 {
  return { superChunk: shard.superChunk, notes: shard.notes.length };
}
