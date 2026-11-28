import { canonicalJson, worldShards, type TrackRecordV1 } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { World } from "./world.ts";
import { DirtyShards, addShards, worldPlacements } from "./world-shards.ts";

const REFS = ["ldraw:3811", "omr:10264-1"];
const TEN_KM_LDU = 25_000_000;
const SCENERY_LAYER = 7;
const CONTRIBUTOR = 12;

const ORIGIN_TRACK: TrackRecordV1 = {
  index: 0,
  ref: "ldraw:53401",
  heading: 0,
  position: ["0", "0", "0", "0", "0", "0", "0", "0"],
  yPlates: 0,
};

function resolve(ref: string, color: number) {
  const refId = REFS.indexOf(ref);
  const colorId = refId === 0 ? 2 : 0;
  return refId < 0 || color !== colorId ? null : { refId, colorId };
}

function shardsOf(world: World, refs: ReadonlyArray<string>) {
  return worldShards(worldPlacements(world, refs), []);
}

function editedWorld(): World {
  const world = new World();
  const first = world.add(0, 2, 0, 0, 0, 0, 0);
  world.add(1, 0, 40, -60, 0, 1, SCENERY_LAYER, CONTRIBUTOR);
  world.add(0, 2, 640, 0, 0, 0, 0);
  world.add(1, 0, TEN_KM_LDU, -TEN_KM_LDU, 0, 3, 0);
  world.remove(first);
  world.add(1, 0, 20, 20, 0, 2, 0);
  return world;
}

describe("world shards", () => {
  it("round-trips an edited world to byte-identical shards, one shard per occupied super-chunk", () => {
    const shards = shardsOf(editedWorld(), REFS);
    const reloaded = new World();
    expect(addShards(reloaded, shards, resolve).ok).toBe(true);

    expect(shardsOf(reloaded, REFS).map(canonicalJson)).toEqual(shards.map(canonicalJson));
    expect(shards.map((shard) => shard.superChunk)).toEqual([
      [0, -1],
      [0, 0],
      [4882, -4883],
    ]);
    expect(reloaded.size).toBe(4);
    expect(
      shards.flatMap((shard) =>
        shard.placements.map((placement) => ("layer" in placement ? placement.layer : "base")),
      ),
    ).toEqual([SCENERY_LAYER, "base", "base", "base"]);
    expect(
      shards.flatMap((shard) =>
        shard.placements.map((placement) => ("owner" in placement ? placement.owner : "none")),
      ),
    ).toEqual([CONTRIBUTOR, "none", "none", "none"]);
  });

  it("refuses a shard naming a ref outside the catalog and adds nothing", () => {
    const shards = shardsOf(editedWorld(), [...REFS.slice(0, 1), "omr:unknown-1"]);
    const world = new World();
    const result = addShards(world, shards, resolve);

    expect(result.ok).toBe(false);
    expect(world.size).toBe(0);
  });

  it("reports an emptied super-chunk as dropped and touched ones as rewritten", () => {
    const world = new World();
    const keep = world.add(0, 2, 0, 0, 0, 0, 0);
    const gone = world.add(1, 0, TEN_KM_LDU, 0, 0, 0, 0);
    const dirty = new DirtyShards();
    world.remove(gone);
    dirty.touch(TEN_KM_LDU, 0);
    dirty.touch(keep.x, keep.z);

    const change = dirty.take(world, REFS, []);

    expect(change.put.map((shard) => shard.superChunk)).toEqual([[0, 0]]);
    expect(change.drop).toEqual([[4882, 0]]);
    expect(dirty.size).toBe(0);
  });

  it("puts back every super-chunk of a change whose write failed, so the next take rewrites it", () => {
    const world = new World();
    world.add(0, 2, 0, 0, 0, 0, 0);
    world.add(1, 0, TEN_KM_LDU, 0, 0, 0, 0);
    const dirty = new DirtyShards();
    dirty.touch(0, 0);
    dirty.touch(TEN_KM_LDU, 0);
    const failed = dirty.take(world, REFS, []);
    dirty.touch(0, 0);

    dirty.restore(failed);

    expect(dirty.take(world, REFS, []).put.map((shard) => shard.superChunk)).toEqual([
      [0, 0],
      [4882, 0],
    ]);
  });

  it("rewrites a touched shard with the track pieces it holds, so saving a placement keeps them", () => {
    const world = new World();
    world.add(0, 2, 0, 0, 0, 0, 0);
    const dirty = new DirtyShards();
    dirty.touch(0, 0);

    const [shard] = dirty.take(world, REFS, [ORIGIN_TRACK]).put;

    expect(shard?.placements).toHaveLength(1);
    expect(shard?.track).toEqual([ORIGIN_TRACK]);
  });

  it("refuses a placement whose colour isn't the catalog item's", () => {
    const world = new World();
    world.add(0, 4, 0, 0, 0, 0, 0);
    expect(addShards(new World(), shardsOf(world, REFS), resolve).ok).toBe(false);
  });
});
