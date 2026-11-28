import {
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  chunkOf,
  isLatticePose,
  isRot90,
  zeta16,
  zeta16FloorStuds,
  type Zeta16,
} from "@brr/math";
import * as v from "valibot";
import { decodeZeta16, encodeZeta16 } from "../bundle/index.ts";
import { decode, type Decoded, type Issue } from "../decode/index.ts";

export const WORLD_FORMAT = "brr.world";
export const SHARD_FORMAT = "brr.shard";
export const NOTE_SHARD_FORMAT = "brr.notes";
export const WORLD_SCHEMA_VERSION = 2;
export const WORLD_SCHEMA_VERSIONS = [1, WORLD_SCHEMA_VERSION] as const;
export type WorldSchemaVersion = (typeof WORLD_SCHEMA_VERSIONS)[number];
export const SUPER_CHUNK_CHUNKS = 8;
export const MANIFEST_FILE = "manifest.json";
export const CREDITS_FILE = "CREDITS.txt";
export const SHARD_DIRECTORY = "shards/";
export const NOTE_SHARD_DIRECTORY = "notes/";
export const IMPORT_DIRECTORY = "imports/";
export const IMPORT_REF_PREFIX = "import:";

const CATALOG_REF = /^[a-z][a-z0-9]*:[A-Za-z0-9._-]+$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/u;

export const SafeInteger = v.pipe(v.number(), v.safeInteger("must be an integer"));
export const Count = v.pipe(SafeInteger, v.minValue(0, "must not be negative"));
export const Sha256 = v.pipe(v.string(), v.regex(SHA256_HEX, "must be a SHA-256 in lowercase hex"));
export const CatalogRef = v.pipe(
  v.string(),
  v.regex(CATALOG_REF, "is not a namespaced catalog id"),
);
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function newerVersionMessage(input: unknown, expected: string): string {
  return typeof input === "number" && input > WORLD_SCHEMA_VERSION
    ? `is ${input}, newer than the schema version ${WORLD_SCHEMA_VERSION} this app reads`
    : `must be ${expected}`;
}

export function schemaVersionField<const Version extends WorldSchemaVersion>(version: Version) {
  return v.literal(version, (issue) => newerVersionMessage(issue.input, String(version)));
}

const SchemaVersionOnly = v.looseObject(
  {
    schemaVersion: v.picklist(WORLD_SCHEMA_VERSIONS, (issue) =>
      newerVersionMessage(issue.input, WORLD_SCHEMA_VERSIONS.join(" or ")),
    ),
  },
  "must be an object",
);

export function decodeWorldSchemaVersion(
  value: unknown,
  path: string,
): Decoded<WorldSchemaVersion> {
  const read = decode(SchemaVersionOnly, value, path);
  return read.ok ? { ok: true, value: read.value.schemaVersion } : read;
}

export const Ldu = v.config(
  v.pipe(
    v.number(),
    v.safeInteger("must be an integer"),
    v.check((ldu) => isLatticePose(ldu, 0, 0), "is outside the int32 LDU range"),
  ),
  { abortPipeEarly: true },
);

export const LatticeLdu = v.config(
  v.pipe(
    v.number(),
    v.safeInteger("must be an integer"),
    v.check((ldu) => isLatticePose(ldu, 0, 0), "is outside the int32 LDU range"),
    v.check((ldu) => ldu % STUD_LDU === 0, `must be a multiple of ${STUD_LDU} LDU`),
  ),
  { abortPipeEarly: true },
);

export const YPlates = v.config(
  v.pipe(
    v.number(),
    v.safeInteger("must be an integer"),
    v.check((yPlates) => isLatticePose(0, 0, yPlates), "is outside the int16 plate range"),
  ),
  { abortPipeEarly: true },
);

export const QuarterTurn = v.config(
  v.pipe(
    v.number(),
    v.safeInteger("must be an integer"),
    v.check(isRot90, "is not a quarter turn 0-3"),
  ),
  { abortPipeEarly: true },
);

export const FiniteNumber = v.pipe(v.number(), v.finite("must be a finite number"));

export function strictMessage(issue: v.StrictObjectIssue | v.StrictTupleIssue): string {
  if (issue.expected === "never") return "is not part of this format";
  if (issue.received === "undefined" && issue.expected?.startsWith('"')) return "is missing";
  return issue.type === "strict_tuple" ? "must be a pair [x, z]" : "must be an object";
}

export function nonBlankText(maxLength: number) {
  return v.pipe(
    v.string(),
    v.check(
      (text) => text.trim() !== "" && text.length <= maxLength,
      `must be 1 to ${maxLength} characters, not all spaces`,
    ),
  );
}

export const WORLD_NAME_MAX_LENGTH = 200;

export const WorldName = nonBlankText(WORLD_NAME_MAX_LENGTH);
export type WorldName = v.InferOutput<typeof WorldName>;

export const SuperChunk = v.strictTuple([SafeInteger, SafeInteger], strictMessage);
export type SuperChunk = v.InferOutput<typeof SuperChunk>;

export function superChunkOfChunk(chunkX: number, chunkZ: number): SuperChunk {
  return [Math.floor(chunkX / SUPER_CHUNK_CHUNKS), Math.floor(chunkZ / SUPER_CHUNK_CHUNKS)];
}

export function superChunkOf(x: number, z: number): SuperChunk {
  return superChunkOfChunk(chunkOf(x), chunkOf(z));
}

export function encodeTrackPosition(position: Zeta16): string[] {
  return encodeZeta16(position);
}

export function decodeTrackPosition(position: ReadonlyArray<string>): Zeta16 {
  return decodeZeta16(position);
}

const COEFFICIENT_TEXT = /^(?:0|-?[1-9]\d*)$/u;

function fitsInt64(text: string): boolean {
  const value = BigInt(text);
  return value >= INT64_MIN && value <= INT64_MAX;
}

export function readablePosition(position: ReadonlyArray<string>): boolean {
  return (
    position.length === ZETA16_COEFFICIENT_COUNT &&
    position.every((coefficient) => COEFFICIENT_TEXT.test(coefficient) && fitsInt64(coefficient))
  );
}

function onLattice(position: ReadonlyArray<string>): boolean {
  const ldu = BigInt(STUD_LDU);
  const scaled = decodeTrackPosition(position).map((coefficient) => coefficient * ldu);
  const floor = zeta16FloorStuds(zeta16(scaled));
  return isLatticePose(Number(floor.x), Number(floor.z), 0);
}

const Coefficient = v.config(
  v.pipe(
    v.string(),
    v.regex(COEFFICIENT_TEXT, "must be a canonical decimal integer"),
    v.check(fitsInt64, "is outside the int64 range"),
  ),
  { abortPipeEarly: true },
);

export const TrackPosition = v.config(
  v.pipe(
    v.array(Coefficient),
    v.length(ZETA16_COEFFICIENT_COUNT, `must have ${ZETA16_COEFFICIENT_COUNT} coefficients`),
    v.check((position: string[]) => onLattice(position), "is outside the int32 LDU range"),
  ),
  { abortPipeEarly: true },
);

export function superChunkOfTrack(position: ReadonlyArray<string>): SuperChunk {
  const studs = zeta16FloorStuds(decodeTrackPosition(position));
  return superChunkOf(Number(studs.x) * STUD_LDU, Number(studs.z) * STUD_LDU);
}

export function compareSuperChunks(a: Readonly<SuperChunk>, b: Readonly<SuperChunk>): number {
  return a[0] - b[0] || a[1] - b[1];
}

export function shardName(superChunk: Readonly<SuperChunk>): string {
  return `${superChunk[0]}_${superChunk[1]}`;
}

export function shardPath(superChunk: Readonly<SuperChunk>): string {
  return `${SHARD_DIRECTORY}${shardName(superChunk)}.json`;
}

export function noteShardPath(superChunk: Readonly<SuperChunk>): string {
  return `${NOTE_SHARD_DIRECTORY}${shardName(superChunk)}.json`;
}

export function ascendingSuperChunks(
  entries: ReadonlyArray<{ readonly superChunk: Readonly<SuperChunk> }>,
): boolean {
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (previous && current && compareSuperChunks(previous.superChunk, current.superChunk) >= 0) {
      return false;
    }
  }
  return true;
}

export interface PlacedAt {
  readonly x: number;
  readonly z: number;
}

export interface LaidAt {
  readonly position: ReadonlyArray<string>;
}

export function placementsInside(
  superChunk: Readonly<SuperChunk>,
  placements: ReadonlyArray<PlacedAt>,
): boolean {
  return placements.every(
    (placement) => compareSuperChunks(superChunkOf(placement.x, placement.z), superChunk) === 0,
  );
}

export function trackInside(
  superChunk: Readonly<SuperChunk>,
  track: ReadonlyArray<LaidAt>,
): boolean {
  return track.every(
    (piece) =>
      !readablePosition(piece.position) ||
      compareSuperChunks(superChunkOfTrack(piece.position), superChunk) === 0,
  );
}

export interface ShardGroup<P, T> {
  readonly superChunk: SuperChunk;
  readonly placements: P[];
  readonly track: T[];
}

export function groupBySuperChunk<P extends PlacedAt, T extends LaidAt>(
  placements: ReadonlyArray<P>,
  track: ReadonlyArray<T>,
): ShardGroup<P, T>[] {
  const groups = new Map<string, ShardGroup<P, T>>();
  const groupOf = (superChunk: SuperChunk): ShardGroup<P, T> => {
    const name = shardName(superChunk);
    const found = groups.get(name);
    if (found) return found;
    const group: ShardGroup<P, T> = { superChunk, placements: [], track: [] };
    groups.set(name, group);
    return group;
  };
  for (const placement of placements) {
    groupOf(superChunkOf(placement.x, placement.z)).placements.push(placement);
  }
  for (const piece of track) groupOf(superChunkOfTrack(piece.position)).track.push(piece);
  const sorted = [...groups.values()];
  sorted.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return sorted;
}

export interface Indexed {
  readonly index: number;
}

export function byIndex<T extends Indexed>(rows: ReadonlyArray<T>): T[] {
  const sorted = [...rows];
  sorted.sort((a, b) => a.index - b.index);
  return sorted;
}

export type ArchiveText = {
  readonly name: string;
  readonly text: string;
};

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function writeCanonical(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
  } else if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is ${value}, which JSON can't hold`);
    out.push(JSON.stringify(value));
  } else if (typeof value === "string") {
    out.push(JSON.stringify(value));
  } else if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item: unknown, index) => {
      if (index > 0) out.push(",");
      writeCanonical(item, `${path}[${index}]`, out);
    });
    out.push("]");
  } else if (typeof value === "object" && isPlainObject(value)) {
    out.push("{");
    const keys = Object.keys(value);
    keys.sort();
    keys.forEach((key, index) => {
      if (index > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      writeCanonical(value[key], `${path}.${key}`, out);
    });
    out.push("}");
  } else {
    throw new TypeError(`${path} is a ${typeof value}, which canonical JSON doesn't hold`);
  }
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, "$", out);
  out.push("\n");
  return out.join("");
}

export function parseJsonText(text: string, path: string): Decoded<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, issues: [{ path, message: `is not JSON (${String(error)})` }] };
  }
}

export function unexpectedFiles(
  files: ReadonlyMap<string, string>,
  expected: ReadonlySet<string>,
  message: string,
): ReadonlyArray<Issue> {
  return [...files.keys()].flatMap((name) => (expected.has(name) ? [] : [{ path: name, message }]));
}
