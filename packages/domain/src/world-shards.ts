import { CHUNK_LDU } from "@brr/math";
import type { Decoded, Issue } from "@brr/schema/decode";
import {
  BASE_LAYER_ID,
  compareSuperChunks,
  encodeTrackPosition,
  shardName,
  superChunkOf,
  superChunkOfChunk,
  superChunkOfTrack,
  worldShards,
  type PlacementRecordV2,
  type SuperChunk,
  type TrackRecordV2,
  type WorldShardV2,
} from "@brr/schema/world";
import type { LayeredPose, TrackPieceAt } from "./edit-history.ts";
import { NO_OWNER, SLOT_LIVE, type PlacementHandle, type World } from "./world.ts";

export interface PlacementTarget {
  readonly refId: number;
  readonly colorId: number;
}

export function worldPlacements(
  world: World,
  refs: ReadonlyArray<string>,
  only?: ReadonlySet<string>,
): PlacementRecordV2[] {
  const placements: PlacementRecordV2[] = [];
  for (const chunk of world.chunks()) {
    if (chunk.liveCount === 0) continue;
    const superChunk = superChunkOfChunk(chunk.originX / CHUNK_LDU, chunk.originZ / CHUNK_LDU);
    if (only && !only.has(shardName(superChunk))) continue;
    for (let slot = 0; slot < chunk.count; slot++) {
      if (((chunk.flags[slot] ?? 0) & SLOT_LIVE) === 0) continue;
      const refId = chunk.refId[slot] ?? 0;
      const ref = refs[refId];
      if (ref === undefined) throw new Error(`placement refId ${refId} has no catalog id`);
      const layer = chunk.layer[slot] ?? BASE_LAYER_ID;
      const owner = chunk.owner[slot] ?? NO_OWNER;
      placements.push({
        ref,
        color: chunk.colorId[slot] ?? 0,
        x: chunk.x[slot] ?? 0,
        z: chunk.z[slot] ?? 0,
        yPlates: chunk.yPlates[slot] ?? 0,
        rot: chunk.rot[slot] ?? 0,
        ...(layer === BASE_LAYER_ID ? {} : { layer }),
        ...(owner === NO_OWNER ? {} : { owner }),
      });
    }
  }
  return placements;
}

export interface ShardChange {
  readonly put: ReadonlyArray<WorldShardV2>;
  readonly drop: ReadonlyArray<SuperChunk>;
}

export class DirtyShards {
  private readonly dirty = new Map<string, SuperChunk>();

  get size(): number {
    return this.dirty.size;
  }

  clear(): void {
    this.dirty.clear();
  }

  restore(change: ShardChange): void {
    for (const shard of change.put) this.dirty.set(shardName(shard.superChunk), shard.superChunk);
    for (const superChunk of change.drop) this.dirty.set(shardName(superChunk), superChunk);
  }

  touch(x: number, z: number): void {
    const superChunk = superChunkOf(x, z);
    this.dirty.set(shardName(superChunk), superChunk);
  }

  touchTrack(track: ReadonlyArray<TrackRecordV2>): void {
    for (const piece of track) {
      const superChunk = superChunkOfTrack(piece.position);
      this.dirty.set(shardName(superChunk), superChunk);
    }
  }

  touchTrackPieces(pieces: ReadonlyArray<TrackPieceAt>): void {
    for (const piece of pieces) {
      const superChunk = superChunkOfTrack(encodeTrackPosition(piece.pose.position));
      this.dirty.set(shardName(superChunk), superChunk);
    }
  }

  take(
    world: World,
    refs: ReadonlyArray<string>,
    track: ReadonlyArray<TrackRecordV2>,
  ): ShardChange {
    const names = new Set(this.dirty.keys());
    const put = worldShards(
      worldPlacements(world, refs, names),
      track.filter((piece) => names.has(shardName(superChunkOfTrack(piece.position)))),
    );
    for (const shard of put) names.delete(shardName(shard.superChunk));
    const drop = [...names].flatMap((name) => {
      const superChunk = this.dirty.get(name);
      return superChunk ? [superChunk] : [];
    });
    this.dirty.clear();
    return { put, drop };
  }
}

export function shardPoses(
  shards: ReadonlyArray<WorldShardV2>,
  resolve: (ref: string, color: number) => PlacementTarget | null,
): Decoded<LayeredPose[]> {
  const issues: Issue[] = [];
  const unknown = new Set<string>();
  for (const shard of shards) {
    for (const placement of shard.placements) {
      const key = `${placement.ref} in colour ${placement.color}`;
      if (!unknown.has(key) && resolve(placement.ref, placement.color) === null) {
        unknown.add(key);
        issues.push({
          path: `shard ${shardName(shard.superChunk)}`,
          message: `"${placement.ref}" in colour ${placement.color} is not in this app's catalog`,
        });
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const poses: LayeredPose[] = [];
  const ordered = [...shards];
  ordered.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  for (const shard of ordered) {
    for (const placement of shard.placements) {
      const target = resolve(placement.ref, placement.color);
      if (!target) continue;
      poses.push({
        refId: target.refId,
        colorId: target.colorId,
        x: placement.x,
        z: placement.z,
        yPlates: placement.yPlates,
        rot: placement.rot,
        layer: placement.layer ?? BASE_LAYER_ID,
        owner: placement.owner ?? NO_OWNER,
      });
    }
  }
  return { ok: true, value: poses };
}

export function addShards(
  world: World,
  shards: ReadonlyArray<WorldShardV2>,
  resolve: (ref: string, color: number) => PlacementTarget | null,
): Decoded<PlacementHandle[]> {
  const poses = shardPoses(shards, resolve);
  if (!poses.ok) return poses;
  return {
    ok: true,
    value: poses.value.map((pose) =>
      world.add(
        pose.refId,
        pose.colorId,
        pose.x,
        pose.z,
        pose.yPlates,
        pose.rot,
        pose.layer,
        pose.owner,
      ),
    ),
  };
}
