import * as v from "valibot";
import { decode, type Decoded, type Issue } from "../decode/index.ts";
import {
  BASE_LAYER_ID,
  ContributorId,
  DEFAULT_WORLD_DOCUMENT,
  GroupId,
  LayerId,
  WorldDocumentEntries,
  activePlanListed,
  plansOnPlanLayers,
  typedTablesFit,
  worldDocument,
  type WorldDocumentIndex,
} from "./document.ts";
import {
  CREDITS_FILE,
  Count,
  SHARD_FORMAT,
  SuperChunk,
  WORLD_FORMAT,
  WorldName,
  byIndex,
  compareSuperChunks,
  decodeWorldSchemaVersion,
  groupBySuperChunk,
  placementsInside,
  schemaVersionField,
  strictMessage,
  trackInside,
} from "./fields.ts";
import { NoteShardListV2, type NoteShardEntryV2, type NoteShardV2 } from "./notes.ts";
import {
  ConsistListV1,
  PlacementRecordV1,
  SavedViewV1,
  ShardListV1,
  TrackRecordV1,
  WorldManifestV1,
  WorldShardV1,
  shardTotals,
  type ShardEntryV1,
} from "./v1.ts";

const SchemaVersion = schemaVersionField(2);

const RecordTags = {
  layer: v.exactOptional(
    v.config(
      v.pipe(
        LayerId,
        v.check((id) => id !== BASE_LAYER_ID, "is left out on the base layer"),
      ),
      { abortPipeEarly: true },
    ),
  ),
  owner: v.exactOptional(ContributorId),
  group: v.exactOptional(GroupId),
};

export const PlacementRecordV2 = v.strictObject(
  { ...PlacementRecordV1.entries, ...RecordTags },
  strictMessage,
);
export type PlacementRecordV2 = v.InferOutput<typeof PlacementRecordV2>;

export const TrackRecordV2 = v.strictObject(
  { ...TrackRecordV1.entries, ...RecordTags },
  strictMessage,
);
export type TrackRecordV2 = v.InferOutput<typeof TrackRecordV2>;

export const WorldShardV2 = v.pipe(
  v.strictObject(
    {
      format: v.literal(SHARD_FORMAT, `must be "${SHARD_FORMAT}"`),
      schemaVersion: SchemaVersion,
      superChunk: SuperChunk,
      placements: v.array(PlacementRecordV2),
      track: v.array(TrackRecordV2),
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
      (shard) => placementsInside(shard.superChunk, shard.placements),
      "must all lie inside the shard's super-chunk",
    ),
    ["placements"],
  ),
  v.forward(
    v.partialCheck(
      [["superChunk"], ["track"]],
      (shard) => trackInside(shard.superChunk, shard.track),
      "must all lie inside the shard's super-chunk",
    ),
    ["track"],
  ),
);
export type WorldShardV2 = v.InferOutput<typeof WorldShardV2>;

const WorldManifestFieldsV2 = v.strictObject(
  {
    format: v.literal(WORLD_FORMAT, `must be "${WORLD_FORMAT}"`),
    schemaVersion: SchemaVersion,
    name: WorldName,
    bundleVersion: v.string(),
    placements: Count,
    track: Count,
    shards: ShardListV1,
    notes: Count,
    noteShards: NoteShardListV2,
    view: SavedViewV1,
    credits: v.literal(CREDITS_FILE, `must be "${CREDITS_FILE}"`),
    disclaimer: v.pipe(v.string(), v.minLength(1, "is empty")),
    consists: ConsistListV1,
    ...WorldDocumentEntries,
  },
  strictMessage,
);

const PLANS_OFF_PLAN_LAYERS = "must each lie on a plan layer the manifest lists";
const ACTIVE_PLAN_UNLISTED = "must be the index of a listed plan";
const TABLE_TYPE_MISFIT =
  "must give each typed table a table type the manifest lists, with its width and depth in either orientation and its height";

export const WorldManifestV2 = v.pipe(
  WorldManifestFieldsV2,
  v.forward(
    v.partialCheck(
      [["placements"], ["shards"]],
      (manifest) => manifest.placements === shardTotals(manifest.shards).placements,
      "must equal the sum of the shards' placements",
    ),
    ["placements"],
  ),
  v.forward(
    v.partialCheck(
      [["track"], ["shards"]],
      (manifest) => manifest.track === shardTotals(manifest.shards).track,
      "must equal the sum of the shards' track pieces",
    ),
    ["track"],
  ),
  v.forward(
    v.partialCheck(
      [["notes"], ["noteShards"]],
      (manifest) =>
        manifest.notes === manifest.noteShards.reduce((sum, entry) => sum + entry.notes, 0),
      "must equal the sum of the note shards' notes",
    ),
    ["notes"],
  ),
  v.forward(v.partialCheck([["layers"], ["plans"]], plansOnPlanLayers, PLANS_OFF_PLAN_LAYERS), [
    "plans",
  ]),
  v.forward(v.partialCheck([["plans"], ["activePlan"]], activePlanListed, ACTIVE_PLAN_UNLISTED), [
    "activePlan",
  ]),
  v.forward(v.partialCheck([["plans"], ["tableTypes"]], typedTablesFit, TABLE_TYPE_MISFIT), [
    "plans",
  ]),
);
export type WorldManifestV2 = v.InferOutput<typeof WorldManifestV2>;

export const WorldHeader = v.pipe(
  v.pick(WorldManifestFieldsV2, [
    "name",
    "bundleVersion",
    "view",
    "disclaimer",
    "consists",
    "layers",
    "groups",
    "contributors",
    "plans",
    "activePlan",
    "tableTypes",
    "event",
  ]),
  v.forward(v.partialCheck([["layers"], ["plans"]], plansOnPlanLayers, PLANS_OFF_PLAN_LAYERS), [
    "plans",
  ]),
  v.forward(v.partialCheck([["plans"], ["activePlan"]], activePlanListed, ACTIVE_PLAN_UNLISTED), [
    "activePlan",
  ]),
  v.forward(v.partialCheck([["plans"], ["tableTypes"]], typedTablesFit, TABLE_TYPE_MISFIT), [
    "plans",
  ]),
);
export type WorldHeader = v.InferOutput<typeof WorldHeader>;

interface RecordTagsOf {
  readonly layer?: number;
  readonly owner?: number;
  readonly group?: number;
}

function compareTags(a: RecordTagsOf, b: RecordTagsOf): number {
  return (
    (a.layer ?? BASE_LAYER_ID) - (b.layer ?? BASE_LAYER_ID) ||
    (a.owner ?? -1) - (b.owner ?? -1) ||
    (a.group ?? -1) - (b.group ?? -1)
  );
}

function comparePlacements(a: PlacementRecordV2, b: PlacementRecordV2): number {
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return (
    a.color - b.color ||
    a.x - b.x ||
    a.z - b.z ||
    a.yPlates - b.yPlates ||
    a.rot - b.rot ||
    compareTags(a, b)
  );
}

export function worldShard(
  superChunk: SuperChunk,
  placements: ReadonlyArray<PlacementRecordV2>,
  track: ReadonlyArray<TrackRecordV2>,
): WorldShardV2 {
  const sortedPlacements = [...placements];
  sortedPlacements.sort(comparePlacements);
  return {
    format: SHARD_FORMAT,
    schemaVersion: 2,
    superChunk,
    placements: sortedPlacements,
    track: byIndex(track),
  };
}

export function worldShards(
  placements: ReadonlyArray<PlacementRecordV2>,
  track: ReadonlyArray<TrackRecordV2>,
): WorldShardV2[] {
  return groupBySuperChunk(placements, track).map((group) =>
    worldShard(group.superChunk, group.placements, group.track),
  );
}

export function worldTrack<Piece extends { readonly index: number }>(
  shards: ReadonlyArray<{ readonly track: ReadonlyArray<Piece> }>,
): Piece[] {
  return byIndex(shards.flatMap((shard) => shard.track));
}

export function shardEntry(shard: {
  readonly superChunk: SuperChunk;
  readonly placements: ReadonlyArray<unknown>;
  readonly track: ReadonlyArray<unknown>;
}): ShardEntryV1 {
  return {
    superChunk: shard.superChunk,
    placements: shard.placements.length,
    track: shard.track.length,
  };
}

export function worldHeader(manifest: WorldManifestV2): WorldHeader {
  return {
    name: manifest.name,
    bundleVersion: manifest.bundleVersion,
    view: manifest.view,
    disclaimer: manifest.disclaimer,
    ...(manifest.consists ? { consists: manifest.consists } : {}),
    ...worldDocument(manifest),
  };
}

export function worldManifest(
  header: WorldHeader,
  shards: ReadonlyArray<ShardEntryV1>,
  noteShards: ReadonlyArray<NoteShardEntryV2> = [],
): WorldManifestV2 {
  const entries = [...shards];
  entries.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  const noteEntries = [...noteShards];
  noteEntries.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  const totals = shardTotals(entries);
  return {
    format: WORLD_FORMAT,
    schemaVersion: 2,
    name: header.name,
    bundleVersion: header.bundleVersion,
    placements: totals.placements,
    track: totals.track,
    shards: entries,
    notes: noteEntries.reduce((sum, entry) => sum + entry.notes, 0),
    noteShards: noteEntries,
    view: header.view,
    credits: CREDITS_FILE,
    disclaimer: header.disclaimer,
    ...(header.consists ? { consists: header.consists } : {}),
    ...worldDocument(header),
  };
}

export function migrateShardV1(shard: WorldShardV1): WorldShardV2 {
  return worldShard(shard.superChunk, shard.placements, shard.track);
}

export function migrateManifestV1(manifest: WorldManifestV1): WorldManifestV2 {
  return worldManifest(
    {
      name: manifest.name,
      bundleVersion: manifest.bundleVersion,
      view: manifest.view,
      disclaimer: manifest.disclaimer,
      ...(manifest.consists ? { consists: manifest.consists } : {}),
      ...DEFAULT_WORLD_DOCUMENT,
    },
    manifest.shards,
  );
}

export interface WorldContentsV2 {
  readonly manifest: WorldManifestV2;
  readonly shards: ReadonlyArray<WorldShardV2>;
  readonly notes: ReadonlyArray<NoteShardV2>;
}

export function migrateWorldV1(world: {
  readonly manifest: WorldManifestV1;
  readonly shards: ReadonlyArray<WorldShardV1>;
}): WorldContentsV2 {
  return {
    manifest: migrateManifestV1(world.manifest),
    shards: world.shards.map(migrateShardV1),
    notes: [],
  };
}

function tagIssues(
  index: WorldDocumentIndex,
  tags: RecordTagsOf,
  path: string,
  issues: Issue[],
): void {
  const layer = index.layerIssue(tags.layer ?? BASE_LAYER_ID, "parts");
  if (layer !== null) issues.push({ path: `${path}.layer`, message: layer });
  const owner = tags.owner === undefined ? null : index.ownerIssue(tags.owner);
  if (owner !== null) issues.push({ path: `${path}.owner`, message: owner });
  const group = tags.group === undefined ? null : index.groupIssue(tags.group);
  if (group !== null) issues.push({ path: `${path}.group`, message: group });
}

export function shardReferenceIssues(
  index: WorldDocumentIndex,
  shard: WorldShardV2,
  path: string,
): Issue[] {
  const issues: Issue[] = [];
  shard.placements.forEach((placement, i) =>
    tagIssues(index, placement, `${path}.placements.${i}`, issues),
  );
  shard.track.forEach((piece, i) => tagIssues(index, piece, `${path}.track.${i}`, issues));
  return issues;
}

export function noteShardReferenceIssues(
  index: WorldDocumentIndex,
  shard: NoteShardV2,
  path: string,
): Issue[] {
  const issues: Issue[] = [];
  shard.notes.forEach((note, i) => {
    const layer = index.layerIssue(note.layer, "notes");
    if (layer !== null) issues.push({ path: `${path}.notes.${i}.layer`, message: layer });
    const owner = note.owner === undefined ? null : index.ownerIssue(note.owner);
    if (owner !== null) issues.push({ path: `${path}.notes.${i}.owner`, message: owner });
  });
  return issues;
}

export function decodeWorldManifest(value: unknown, path: string): Decoded<WorldManifestV2> {
  const version = decodeWorldSchemaVersion(value, path);
  if (!version.ok) return version;
  switch (version.value) {
    case 1: {
      const manifest = decode(WorldManifestV1, value, path);
      return manifest.ok ? { ok: true, value: migrateManifestV1(manifest.value) } : manifest;
    }
    case 2:
      return decode(WorldManifestV2, value, path);
    default: {
      const unhandled: never = version.value;
      throw new Error(`unhandled world schema version ${String(unhandled)}`);
    }
  }
}

export function decodeWorldShard(value: unknown, path: string): Decoded<WorldShardV2> {
  const version = decodeWorldSchemaVersion(value, path);
  if (!version.ok) return version;
  switch (version.value) {
    case 1: {
      const shard = decode(WorldShardV1, value, path);
      return shard.ok ? { ok: true, value: migrateShardV1(shard.value) } : shard;
    }
    case 2:
      return decode(WorldShardV2, value, path);
    default: {
      const unhandled: never = version.value;
      throw new Error(`unhandled world schema version ${String(unhandled)}`);
    }
  }
}
