import { ZETA16_ORDER } from "@brr/math";
import * as v from "valibot";
import {
  CREDITS_FILE,
  CatalogRef,
  Count,
  FiniteNumber,
  LatticeLdu,
  QuarterTurn,
  SHARD_FORMAT,
  SafeInteger,
  SuperChunk,
  TrackPosition,
  WORLD_FORMAT,
  WorldName,
  YPlates,
  ascendingSuperChunks,
  byIndex,
  groupBySuperChunk,
  placementsInside,
  schemaVersionField,
  strictMessage,
  trackInside,
} from "./fields.ts";

const TRACK_RISE_MIN = -(2 ** 7);
const TRACK_RISE_MAX = 2 ** 7 - 1;

const SchemaVersion = schemaVersionField(1);

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

export const ShardListV1 = v.pipe(
  v.array(ShardEntryV1),
  v.check(
    (entries) => ascendingSuperChunks(entries),
    "must list super-chunks in strictly ascending order",
  ),
);

export const PlacementRecordV1 = v.strictObject(
  {
    ref: CatalogRef,
    color: Count,
    x: LatticeLdu,
    z: LatticeLdu,
    yPlates: YPlates,
    rot: QuarterTurn,
  },
  strictMessage,
);
export type PlacementRecordV1 = v.InferOutput<typeof PlacementRecordV1>;

export const TrackRecordV1 = v.strictObject(
  {
    index: Count,
    ref: CatalogRef,
    heading: v.config(
      v.pipe(
        SafeInteger,
        v.minValue(0, "must be a heading 0-15"),
        v.maxValue(ZETA16_ORDER - 1, "must be a heading 0-15"),
      ),
      { abortPipeEarly: true },
    ),
    position: TrackPosition,
    yPlates: YPlates,
    rise: v.exactOptional(
      v.config(
        v.pipe(
          SafeInteger,
          v.minValue(TRACK_RISE_MIN, "must be a rise of -128 to 127 plates"),
          v.maxValue(TRACK_RISE_MAX, "must be a rise of -128 to 127 plates"),
          v.check((rise) => rise !== 0, "is written only when the piece ramps"),
        ),
        { abortPipeEarly: true },
      ),
    ),
  },
  strictMessage,
);
export type TrackRecordV1 = v.InferOutput<typeof TrackRecordV1>;

export const LaidPieceV1 = v.strictObject(
  {
    on: v.literal("track"),
    ref: TrackRecordV1.entries.ref,
    heading: TrackRecordV1.entries.heading,
    position: TrackRecordV1.entries.position,
    yPlates: TrackRecordV1.entries.yPlates,
  },
  strictMessage,
);
export type LaidPieceV1 = v.InferOutput<typeof LaidPieceV1>;

export const CarriedPieceV1 = v.strictObject(
  { on: v.literal("model"), ...PlacementRecordV1.entries, piece: Count },
  strictMessage,
);
export type CarriedPieceV1 = v.InferOutput<typeof CarriedPieceV1>;

export const ConsistPieceV1 = v.variant("on", [LaidPieceV1, CarriedPieceV1], (issue) =>
  issue.received === "undefined" ? "is missing" : `must be "track" or "model"`,
);
export type ConsistPieceV1 = v.InferOutput<typeof ConsistPieceV1>;

export const CoupledVehicleV1 = v.strictObject(
  {
    ref: PlacementRecordV1.entries.ref,
    color: Count,
    reversed: v.boolean(),
  },
  strictMessage,
);
export type CoupledVehicleV1 = v.InferOutput<typeof CoupledVehicleV1>;

export const ConsistRecordV1 = v.strictObject(
  {
    ref: PlacementRecordV1.entries.ref,
    color: Count,
    track: ConsistPieceV1,
    route: Count,
    reversed: v.boolean(),
    offsetLdu: Count,
    coupled: v.exactOptional(
      v.pipe(v.array(CoupledVehicleV1), v.minLength(1, "is empty: leave it out instead")),
    ),
  },
  strictMessage,
);
export type ConsistRecordV1 = v.InferOutput<typeof ConsistRecordV1>;

export const ConsistListV1 = v.exactOptional(
  v.pipe(v.array(ConsistRecordV1), v.minLength(1, "is empty: leave it out instead")),
);

export function shardTotals(entries: ReadonlyArray<ShardEntryV1>): {
  readonly placements: number;
  readonly track: number;
} {
  let placements = 0;
  let track = 0;
  for (const entry of entries) {
    placements += entry.placements;
    track += entry.track;
  }
  return { placements, track };
}

const WorldManifestFieldsV1 = v.strictObject(
  {
    format: v.literal(WORLD_FORMAT, `must be "${WORLD_FORMAT}"`),
    schemaVersion: SchemaVersion,
    name: WorldName,
    bundleVersion: v.string(),
    placements: Count,
    track: Count,
    shards: ShardListV1,
    view: SavedViewV1,
    credits: v.literal(CREDITS_FILE, `must be "${CREDITS_FILE}"`),
    disclaimer: v.pipe(v.string(), v.minLength(1, "is empty")),
    consists: ConsistListV1,
  },
  strictMessage,
);

export const WorldManifestV1 = v.pipe(
  WorldManifestFieldsV1,
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
);
export type WorldManifestV1 = v.InferOutput<typeof WorldManifestV1>;

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
export type WorldShardV1 = v.InferOutput<typeof WorldShardV1>;

function comparePlacementsV1(a: PlacementRecordV1, b: PlacementRecordV1): number {
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return a.color - b.color || a.x - b.x || a.z - b.z || a.yPlates - b.yPlates || a.rot - b.rot;
}

function untaggedPlacement(placement: PlacementRecordV1): PlacementRecordV1 {
  return {
    ref: placement.ref,
    color: placement.color,
    x: placement.x,
    z: placement.z,
    yPlates: placement.yPlates,
    rot: placement.rot,
  };
}

function untaggedPiece(piece: TrackRecordV1): TrackRecordV1 {
  return {
    index: piece.index,
    ref: piece.ref,
    heading: piece.heading,
    position: piece.position,
    yPlates: piece.yPlates,
    ...(piece.rise === undefined ? {} : { rise: piece.rise }),
  };
}

export function worldShardV1(
  superChunk: SuperChunk,
  placements: ReadonlyArray<PlacementRecordV1>,
  track: ReadonlyArray<TrackRecordV1>,
): WorldShardV1 {
  const sortedPlacements = placements.map(untaggedPlacement);
  sortedPlacements.sort(comparePlacementsV1);
  return {
    format: SHARD_FORMAT,
    schemaVersion: 1,
    superChunk,
    placements: sortedPlacements,
    track: byIndex(track).map(untaggedPiece),
  };
}

export function worldShardsV1(
  placements: ReadonlyArray<PlacementRecordV1>,
  track: ReadonlyArray<TrackRecordV1>,
): WorldShardV1[] {
  return groupBySuperChunk(placements, track).map((group) =>
    worldShardV1(group.superChunk, group.placements, group.track),
  );
}
