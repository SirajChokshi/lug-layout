import {
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  chunkOf,
  isLatticePose,
  isRot90,
  zeta16FloorStuds,
  type Zeta16,
} from "@brr/math";
import * as v from "valibot";
import { decodeZeta16, encodeZeta16 } from "../bundle/index.ts";
import { decode, type Decoded, type Issue } from "../decode/index.ts";

export const WORLD_FORMAT = "brr.world";
export const SHARD_FORMAT = "brr.shard";
export const WORLD_SCHEMA_VERSION = 1;
export const SUPER_CHUNK_CHUNKS = 8;
export const MANIFEST_FILE = "manifest.json";
export const CREDITS_FILE = "CREDITS.txt";
export const SHARD_DIRECTORY = "shards/";

const CATALOG_REF = /^[a-z][a-z0-9]*:[A-Za-z0-9._-]+$/;

const SafeInteger = v.pipe(v.number(), v.safeInteger("must be an integer"));
const Count = v.pipe(SafeInteger, v.minValue(0, "must not be negative"));
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const SchemaVersion = v.literal(WORLD_SCHEMA_VERSION, (issue) =>
  typeof issue.input === "number" && issue.input > WORLD_SCHEMA_VERSION
    ? `is ${issue.input}, newer than the schema version ${WORLD_SCHEMA_VERSION} this app reads`
    : `must be ${WORLD_SCHEMA_VERSION}`,
);

const LatticeLdu = v.config(
  v.pipe(
    v.number(),
    v.safeInteger("must be an integer"),
    v.check((ldu) => isLatticePose(ldu, 0, 0), "is outside the int32 LDU range"),
    v.check((ldu) => ldu % STUD_LDU === 0, `must be a multiple of ${STUD_LDU} LDU`),
  ),
  { abortPipeEarly: true },
);

const FiniteNumber = v.pipe(v.number(), v.finite("must be a finite number"));

function strictMessage(issue: v.StrictObjectIssue | v.StrictTupleIssue): string {
  if (issue.expected === "never") return "is not part of this format";
  if (issue.received === "undefined" && issue.expected?.startsWith('"')) return "is missing";
  return issue.type === "strict_tuple" ? "must be a pair [x, z]" : "must be an object";
}

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

function readablePosition(position: ReadonlyArray<string>): boolean {
  return (
    position.length === ZETA16_COEFFICIENT_COUNT &&
    position.every((coefficient) => COEFFICIENT_TEXT.test(coefficient))
  );
}

function onLattice(position: ReadonlyArray<string>): boolean {
  const studs = zeta16FloorStuds(decodeTrackPosition(position));
  return isLatticePose(Number(studs.x) * STUD_LDU, Number(studs.z) * STUD_LDU, 0);
}

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

export const SavedViewV1 = v.strictObject(
  {
    targetX: FiniteNumber,
    targetY: FiniteNumber,
    targetZ: FiniteNumber,
    distance: FiniteNumber,
    yaw: FiniteNumber,
    pitch: FiniteNumber,
  },
  strictMessage,
);
export type SavedViewV1 = v.InferOutput<typeof SavedViewV1>;

export const ShardEntryV1 = v.pipe(
  v.strictObject({ superChunk: SuperChunk, placements: Count, track: Count }, strictMessage),
  v.check((entry) => entry.placements + entry.track > 0, "must hold a placement or a track piece"),
);
export type ShardEntryV1 = v.InferOutput<typeof ShardEntryV1>;

function ascendingSuperChunks(entries: ReadonlyArray<ShardEntryV1>): boolean {
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (previous && current && compareSuperChunks(previous.superChunk, current.superChunk) >= 0) {
      return false;
    }
  }
  return true;
}

export const WORLD_NAME_MAX_LENGTH = 200;

export const WorldName = v.pipe(
  v.string(),
  v.check(
    (name) => name.trim() !== "" && name.length <= WORLD_NAME_MAX_LENGTH,
    `must be 1 to ${WORLD_NAME_MAX_LENGTH} characters, not all spaces`,
  ),
);
export type WorldName = v.InferOutput<typeof WorldName>;

const WorldManifestFields = v.strictObject(
  {
    format: v.literal(WORLD_FORMAT, `must be "${WORLD_FORMAT}"`),
    schemaVersion: SchemaVersion,
    name: WorldName,
    bundleVersion: v.string(),
    placements: Count,
    track: Count,
    shards: v.pipe(
      v.array(ShardEntryV1),
      v.check(
        (entries) => ascendingSuperChunks(entries),
        "must list super-chunks in strictly ascending order",
      ),
    ),
    view: SavedViewV1,
    credits: v.literal(CREDITS_FILE, `must be "${CREDITS_FILE}"`),
    disclaimer: v.pipe(v.string(), v.minLength(1, "is empty")),
  },
  strictMessage,
);

export const WorldManifestV1 = v.pipe(
  WorldManifestFields,
  v.forward(
    v.partialCheck(
      [["placements"], ["shards"]],
      (manifest) =>
        manifest.placements === manifest.shards.reduce((sum, entry) => sum + entry.placements, 0),
      "must equal the sum of the shards' placements",
    ),
    ["placements"],
  ),
  v.forward(
    v.partialCheck(
      [["track"], ["shards"]],
      (manifest) => manifest.track === manifest.shards.reduce((sum, entry) => sum + entry.track, 0),
      "must equal the sum of the shards' track pieces",
    ),
    ["track"],
  ),
);
export type WorldManifestV1 = v.InferOutput<typeof WorldManifestV1>;

export const WorldHeader = v.pick(WorldManifestFields, [
  "name",
  "bundleVersion",
  "view",
  "disclaimer",
]);
export type WorldHeader = v.InferOutput<typeof WorldHeader>;

export const PlacementRecordV1 = v.strictObject(
  {
    ref: v.pipe(v.string(), v.regex(CATALOG_REF, "is not a namespaced catalog id")),
    color: Count,
    x: LatticeLdu,
    z: LatticeLdu,
    yPlates: v.config(
      v.pipe(
        v.number(),
        v.safeInteger("must be an integer"),
        v.check((yPlates) => isLatticePose(0, 0, yPlates), "is outside the int16 plate range"),
      ),
      { abortPipeEarly: true },
    ),
    rot: v.config(
      v.pipe(
        v.number(),
        v.safeInteger("must be an integer"),
        v.check(isRot90, "is not a quarter turn 0-3"),
      ),
      { abortPipeEarly: true },
    ),
  },
  strictMessage,
);
export type PlacementRecordV1 = v.InferOutput<typeof PlacementRecordV1>;

const Coefficient = v.config(
  v.pipe(
    v.string(),
    v.regex(COEFFICIENT_TEXT, "must be a canonical decimal integer"),
    v.check(
      (text) => BigInt(text) >= INT64_MIN && BigInt(text) <= INT64_MAX,
      "is outside the int64 range",
    ),
  ),
  { abortPipeEarly: true },
);

export const TrackRecordV1 = v.strictObject(
  {
    index: Count,
    ref: v.pipe(v.string(), v.regex(CATALOG_REF, "is not a namespaced catalog id")),
    heading: v.config(
      v.pipe(
        SafeInteger,
        v.minValue(0, "must be a heading 0-15"),
        v.maxValue(ZETA16_ORDER - 1, "must be a heading 0-15"),
      ),
      { abortPipeEarly: true },
    ),
    position: v.config(
      v.pipe(
        v.array(Coefficient),
        v.length(ZETA16_COEFFICIENT_COUNT, `must have ${ZETA16_COEFFICIENT_COUNT} coefficients`),
        v.check((position: string[]) => onLattice(position), "is outside the int32 LDU range"),
      ),
      { abortPipeEarly: true },
    ),
    yPlates: v.config(
      v.pipe(
        v.number(),
        v.safeInteger("must be an integer"),
        v.check((yPlates) => isLatticePose(0, 0, yPlates), "is outside the int16 plate range"),
      ),
      { abortPipeEarly: true },
    ),
  },
  strictMessage,
);
export type TrackRecordV1 = v.InferOutput<typeof TrackRecordV1>;

export const WorldShardV1 = v.pipe(
  v.strictObject(
    {
      format: v.literal(SHARD_FORMAT, `must be "${SHARD_FORMAT}"`),
      schemaVersion: SchemaVersion,
      superChunk: SuperChunk,
      placements: v.array(PlacementRecordV1),
      track: v.array(TrackRecordV1),
    },
    strictMessage,
  ),
  v.check(
    (shard) => shard.placements.length + shard.track.length > 0,
    "must hold a placement or a track piece",
  ),
  v.forward(
    v.partialCheck(
      [["superChunk"], ["placements"]],
      (shard) =>
        shard.placements.every(
          (placement) =>
            compareSuperChunks(superChunkOf(placement.x, placement.z), shard.superChunk) === 0,
        ),
      "must all lie inside the shard's super-chunk",
    ),
    ["placements"],
  ),
  v.forward(
    v.partialCheck(
      [["superChunk"], ["track"]],
      (shard) =>
        shard.track.every(
          (piece) =>
            !readablePosition(piece.position) ||
            compareSuperChunks(superChunkOfTrack(piece.position), shard.superChunk) === 0,
        ),
      "must all lie inside the shard's super-chunk",
    ),
    ["track"],
  ),
);
export type WorldShardV1 = v.InferOutput<typeof WorldShardV1>;

export const WorldIndexEntry = v.strictObject(
  {
    id: v.pipe(v.string(), v.minLength(1, "is empty")),
    name: v.string(),
    placements: Count,
    track: Count,
    shards: Count,
    savedAt: FiniteNumber,
  },
  strictMessage,
);
export type WorldIndexEntry = v.InferOutput<typeof WorldIndexEntry>;

export type WorldArchive = {
  readonly manifest: WorldManifestV1;
  readonly shards: ReadonlyArray<WorldShardV1>;
  readonly credits: string;
};

type ArchiveText = {
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

export function shardEntry(shard: WorldShardV1): ShardEntryV1 {
  return {
    superChunk: shard.superChunk,
    placements: shard.placements.length,
    track: shard.track.length,
  };
}

function comparePlacements(a: PlacementRecordV1, b: PlacementRecordV1): number {
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return a.color - b.color || a.x - b.x || a.z - b.z || a.yPlates - b.yPlates || a.rot - b.rot;
}

export function worldShard(
  superChunk: SuperChunk,
  placements: ReadonlyArray<PlacementRecordV1>,
  track: ReadonlyArray<TrackRecordV1>,
): WorldShardV1 {
  const sortedPlacements = [...placements];
  sortedPlacements.sort(comparePlacements);
  const sortedTrack = [...track];
  sortedTrack.sort((a, b) => a.index - b.index);
  return {
    format: SHARD_FORMAT,
    schemaVersion: WORLD_SCHEMA_VERSION,
    superChunk,
    placements: sortedPlacements,
    track: sortedTrack,
  };
}

interface ShardGroup {
  readonly superChunk: SuperChunk;
  readonly placements: PlacementRecordV1[];
  readonly track: TrackRecordV1[];
}

export function worldShards(
  placements: ReadonlyArray<PlacementRecordV1>,
  track: ReadonlyArray<TrackRecordV1>,
): WorldShardV1[] {
  const groups = new Map<string, ShardGroup>();
  const groupOf = (superChunk: SuperChunk): ShardGroup => {
    const name = shardName(superChunk);
    const found = groups.get(name);
    if (found) return found;
    const group: ShardGroup = { superChunk, placements: [], track: [] };
    groups.set(name, group);
    return group;
  };
  for (const placement of placements) {
    groupOf(superChunkOf(placement.x, placement.z)).placements.push(placement);
  }
  for (const piece of track) groupOf(superChunkOfTrack(piece.position)).track.push(piece);
  const shards = [...groups.values()].map((group) =>
    worldShard(group.superChunk, group.placements, group.track),
  );
  shards.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return shards;
}

export function worldTrack(shards: ReadonlyArray<WorldShardV1>): TrackRecordV1[] {
  const track = shards.flatMap((shard) => shard.track);
  track.sort((a, b) => a.index - b.index);
  return track;
}

export function worldHeader(manifest: WorldManifestV1): WorldHeader {
  return {
    name: manifest.name,
    bundleVersion: manifest.bundleVersion,
    view: manifest.view,
    disclaimer: manifest.disclaimer,
  };
}

export function worldManifest(
  header: WorldHeader,
  shards: ReadonlyArray<ShardEntryV1>,
): WorldManifestV1 {
  const entries = [...shards];
  entries.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return {
    format: WORLD_FORMAT,
    schemaVersion: WORLD_SCHEMA_VERSION,
    name: header.name,
    bundleVersion: header.bundleVersion,
    placements: entries.reduce((sum, entry) => sum + entry.placements, 0),
    track: entries.reduce((sum, entry) => sum + entry.track, 0),
    shards: entries,
    view: header.view,
    credits: CREDITS_FILE,
    disclaimer: header.disclaimer,
  };
}

export function worldArchiveFiles(archive: WorldArchive): ArchiveText[] {
  const shards = [...archive.shards];
  shards.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return [
    { name: MANIFEST_FILE, text: canonicalJson(archive.manifest) },
    ...shards.map((shard) => ({ name: shardPath(shard.superChunk), text: canonicalJson(shard) })),
    { name: CREDITS_FILE, text: archive.credits },
  ];
}

export function parseJsonText(text: string, path: string): Decoded<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, issues: [{ path, message: `is not JSON (${String(error)})` }] };
  }
}

export function readWorldArchive(files: ReadonlyMap<string, string>): Decoded<WorldArchive> {
  const manifestText = files.get(MANIFEST_FILE);
  if (manifestText === undefined) {
    return { ok: false, issues: [{ path: MANIFEST_FILE, message: "is missing from the archive" }] };
  }
  const manifestJson = parseJsonText(manifestText, MANIFEST_FILE);
  if (!manifestJson.ok) return manifestJson;
  const manifest = decode(WorldManifestV1, manifestJson.value, MANIFEST_FILE);
  if (!manifest.ok) return manifest;
  const credits = files.get(CREDITS_FILE);
  const issues: Issue[] = [];
  if (credits === undefined) issues.push({ path: CREDITS_FILE, message: "is missing" });
  const expected = new Set([MANIFEST_FILE, CREDITS_FILE]);
  const shards: WorldShardV1[] = [];
  for (const entry of manifest.value.shards) {
    const path = shardPath(entry.superChunk);
    expected.add(path);
    const text = files.get(path);
    if (text === undefined) {
      issues.push({ path, message: "is listed in the manifest but missing" });
      continue;
    }
    const json = parseJsonText(text, path);
    const shard = json.ok ? decode(WorldShardV1, json.value, path) : json;
    if (!shard.ok) {
      issues.push(...shard.issues);
      continue;
    }
    if (compareSuperChunks(shard.value.superChunk, entry.superChunk) !== 0) {
      issues.push({ path, message: "holds a different super-chunk than its name" });
    }
    if (shard.value.placements.length !== entry.placements) {
      issues.push({
        path,
        message: `holds ${shard.value.placements.length} placements, the manifest says ${entry.placements}`,
      });
    }
    if (shard.value.track.length !== entry.track) {
      issues.push({
        path,
        message: `holds ${shard.value.track.length} track pieces, the manifest says ${entry.track}`,
      });
    }
    shards.push(shard.value);
  }
  const everyShardRead = shards.length === manifest.value.shards.length;
  if (everyShardRead && worldTrack(shards).some((piece, position) => piece.index !== position)) {
    issues.push({
      path: MANIFEST_FILE,
      message: "the shards' track indices must run 0, 1, 2, … once each",
    });
  }
  for (const name of files.keys()) {
    if (!expected.has(name)) issues.push({ path: name, message: "is not part of a world archive" });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { manifest: manifest.value, shards, credits: credits ?? "" } };
}
