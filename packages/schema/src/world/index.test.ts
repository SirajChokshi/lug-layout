import { CHUNK_LDU, STUD_LDU, ZETA16_ORDER, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import {
  SUPER_CHUNK_CHUNKS,
  WorldManifestV1,
  WorldShardV1,
  canonicalJson,
  encodeTrackPosition,
  importRef,
  readWorldArchive,
  referencedImports,
  shardEntry,
  superChunkOfTrack,
  worldShard,
  worldArchiveFiles,
  worldManifest,
  worldShards,
  worldTrack,
  type ConsistRecordV1,
  type PlacementRecordV1,
  type TrackRecordV1,
  type WorldHeader,
} from "./index.ts";

const INT64_MAX = 2n ** 63n - 1n;
const SUPER_CHUNK_STUDS = (SUPER_CHUNK_CHUNKS * CHUNK_LDU) / STUD_LDU;
const ZEROS = ["0", "0", "0", "0", "0", "0", "0", "0"];

const shard = {
  format: "brr.shard",
  schemaVersion: 1,
  superChunk: [0, 0],
  placements: [{ ref: "omr:10264-1", color: 0, x: 40, z: 60, yPlates: 0, rot: 1 }],
  track: [
    { index: 0, ref: "ldraw:74746", heading: 3, position: ["2", ...ZEROS.slice(1)], yPlates: 0 },
  ],
};

const manifest = {
  format: "brr.world",
  schemaVersion: 1,
  name: "Town",
  bundleVersion: "1fd935a2278f8b65",
  placements: 1,
  track: 1,
  shards: [{ superChunk: [0, 0], placements: 1, track: 1 }],
  view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0.78, pitch: 0.75 },
  credits: "CREDITS.txt",
  disclaimer: "disclaimer",
};

const consist: ConsistRecordV1 = {
  ref: "omr:10133-1",
  color: 0,
  track: {
    on: "track",
    ref: "ldraw:74746",
    heading: 3,
    position: ["2", ...ZEROS.slice(1)],
    yPlates: 0,
  },
  route: 0,
  reversed: true,
  offsetLdu: 120,
};

function withConsist(patch: Record<string, unknown>) {
  return { ...manifest, consists: [{ ...consist, ...patch }] };
}

function withPlacement(patch: Record<string, unknown>) {
  return { ...shard, placements: [{ ...shard.placements[0], ...patch }] };
}

function withTrack(patch: Record<string, unknown>) {
  return { ...shard, track: [{ ...shard.track[0], ...patch }] };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function shardFor(position: string[]) {
  const piece = { index: 0, ref: "ldraw:74746", heading: 0, position, yPlates: 0 };
  return worldShard(superChunkOfTrack(position), [], [piece]);
}

function reread(files: ReadonlyMap<string, string>) {
  const read = readWorldArchive(files);
  if (!read.ok) throw new Error(read.issues.map((i) => `${i.path} ${i.message}`).join("; "));
  return read.value;
}

function backwards<T>(rows: ReadonlyArray<T>): ReadonlyArray<T> {
  return rows.map((_, i) => rows[rows.length - 1 - i]).filter((row) => row !== undefined);
}

describe("world schema v1", () => {
  it("accepts a valid shard and manifest unchanged, with or without consists on the rails", () => {
    const decodedShard = decode(WorldShardV1, shard);
    const decodedManifest = decode(WorldManifestV1, manifest);
    const withTrain = withConsist({});
    const decodedWithTrain = decode(WorldManifestV1, withTrain);
    expect(decodedShard.ok && canonicalJson(decodedShard.value)).toBe(canonicalJson(shard));
    expect(decodedManifest.ok && canonicalJson(decodedManifest.value)).toBe(
      canonicalJson(manifest),
    );
    expect(decodedWithTrain.ok && canonicalJson(decodedWithTrain.value)).toBe(
      canonicalJson(withTrain),
    );
  });

  it.each([
    ["an x off the 20-LDU lattice", withPlacement({ x: 30 }), "$.placements.0.x"],
    ["a fractional height", withPlacement({ yPlates: 0.5 }), "$.placements.0.yPlates"],
    ["a non-quarter turn", withPlacement({ rot: 4 }), "$.placements.0.rot"],
    ["a placement outside its super-chunk", withPlacement({ x: 5120 }), "$.placements"],
    ["a ref without a namespace", withPlacement({ ref: "10264-1" }), "$.placements.0.ref"],
    ["an unknown key", withPlacement({ colour: 2 }), "$.placements.0.colour"],
    [
      "a track piece outside its super-chunk",
      withTrack({ position: ["256", ...ZEROS.slice(1)] }),
      "$.track",
    ],
    ["a heading past 15", withTrack({ heading: 16 }), "$.track.0.heading"],
    [
      "a padded coefficient",
      withTrack({ position: ["02", ...ZEROS.slice(1)] }),
      "$.track.0.position.0",
    ],
    ["negative zero", withTrack({ position: ["-0", ...ZEROS.slice(1)] }), "$.track.0.position.0"],
    [
      "a coefficient past int64",
      withTrack({ position: [String(INT64_MAX + 1n), ...ZEROS.slice(1)] }),
      "$.track.0.position.0",
    ],
    ["seven coefficients", withTrack({ position: ZEROS.slice(1) }), "$.track.0.position"],
    [
      "a position off the int32 lattice",
      withTrack({ position: ["1073741824", ...ZEROS.slice(1)] }),
      "$.track.0.position",
    ],
    ["neither placements nor track", { ...shard, placements: [], track: [] }, "$"],
    ["a newer schema version", { ...shard, schemaVersion: 2 }, "$.schemaVersion"],
  ])("rejects a shard with %s at its path", (_name, value, path) => {
    const decoded = decode(WorldShardV1, value);
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toContain(path);
  });

  it.each([
    [
      "a placement count that disagrees with its shards",
      { ...manifest, placements: 2 },
      "$.placements",
    ],
    [
      "unsorted shard entries",
      {
        ...manifest,
        placements: 2,
        track: 1,
        shards: [
          { superChunk: [1, 0], placements: 1, track: 0 },
          { superChunk: [0, 0], placements: 1, track: 1 },
        ],
      },
      "$.shards",
    ],
    ["no disclaimer", { ...manifest, disclaimer: "" }, "$.disclaimer"],
    ["a track count that disagrees with its shards", { ...manifest, track: 3 }, "$.track"],
    ["an empty consist list", { ...manifest, consists: [] }, "$.consists"],
    ["a consist between whole LDU", withConsist({ offsetLdu: 12.5 }), "$.consists.0.offsetLdu"],
    ["a consist ref without a namespace", withConsist({ ref: "10133-1" }), "$.consists.0.ref"],
    [
      "a consist on a track heading past 15",
      withConsist({ track: { ...consist.track, heading: 16 } }),
      "$.consists.0.track.heading",
    ],
    ["a consist with an unknown key", withConsist({ facing: 1 }), "$.consists.0.facing"],
    [
      "a consist on a model off the lattice",
      withConsist({
        track: {
          on: "model",
          ref: "omr:7936-1",
          color: 0,
          x: 30,
          z: 0,
          yPlates: 0,
          rot: 0,
          piece: 2,
        },
      }),
      "$.consists.0.track.x",
    ],
    [
      "a consist on something that is neither track nor a model",
      withConsist({ track: { ...consist.track, on: "table" } }),
      "$.consists.0.track.on",
    ],
  ])("rejects a manifest with %s at its path", (_name, value, path) => {
    const decoded = decode(WorldManifestV1, value);
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toContain(path);
  });

  it("says a required key is missing", () => {
    const { color: _color, ...withoutColor } = shard.placements[0] ?? { color: 0 };
    const decoded = decode(WorldShardV1, { ...shard, placements: [withoutColor] });
    expect(decoded.ok ? [] : decoded.issues).toEqual([
      { path: "$.placements.0.color", message: "is missing" },
    ]);
  });

  it("reports a fractional heading once", () => {
    const decoded = decode(WorldShardV1, withTrack({ heading: 16.5 }));
    expect(decoded.ok ? [] : decoded.issues).toEqual([
      { path: "$.track.0.heading", message: "must be an integer" },
    ]);
  });

  it("reports a fractional coordinate once, as not an integer", () => {
    const decoded = decode(WorldShardV1, withPlacement({ x: 620.5 }));
    expect(decoded.ok ? [] : decoded.issues).toEqual([
      { path: "$.placements.0.x", message: "must be an integer" },
    ]);
  });

  it("serializes with sorted keys whatever the insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: [2, { b: 1, a: 0 }], x: "é" } })).toBe(
      '{"a":{"x":"é","y":[2,{"a":0,"b":1}]},"z":1}\n',
    );
  });

  const header: WorldHeader = {
    name: "Town",
    bundleVersion: "1fd935a2278f8b65",
    view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0.78, pitch: 0.75 },
    disclaimer: "disclaimer",
  };
  const placements: ReadonlyArray<PlacementRecordV1> = [
    { ref: "omr:10185-1", color: 0, x: 640, z: -1280, yPlates: 0, rot: 3 },
    { ref: "ldraw:3811", color: 2, x: -5120, z: 40960, yPlates: 0, rot: 0 },
    { ref: "ldraw:3811", color: 2, x: 0, z: 0, yPlates: -32768, rot: 1 },
    { ref: "generated:mils-road-curve", color: 72, x: 5100, z: 5120, yPlates: 32767, rot: 2 },
  ];
  const track: ReadonlyArray<TrackRecordV1> = Array.from(
    { length: ZETA16_ORDER },
    (_, heading) => ({
      index: heading,
      ref: heading % 2 === 0 ? "ldraw:74746" : "ldraw:74747",
      heading,
      position: encodeTrackPosition(
        zeta16([
          BigInt(heading * 40 - 320),
          0n,
          BigInt(heading) - 7n,
          0n,
          BigInt(300 - heading * 37),
          0n,
          0n,
          0n,
        ]),
      ),
      yPlates: 0,
    }),
  );

  function archiveFiles(
    placed: ReadonlyArray<PlacementRecordV1>,
    laid: ReadonlyArray<TrackRecordV1>,
  ): Map<string, string> {
    const shards = worldShards(placed, laid);
    const files = worldArchiveFiles({
      manifest: worldManifest(
        header,
        shards.map((s) => ({
          superChunk: s.superChunk,
          placements: s.placements.length,
          track: s.track.length,
        })),
      ),
      shards,
      credits: "credits",
    });
    return new Map(files.map((file) => [file.name, file.text]));
  }

  it("splits a world into super-chunk shards that reload byte-identical, track order exact", () => {
    const saved = archiveFiles(placements, track);
    expect(saved.size).toBeGreaterThan(3);
    const loaded = reread(saved);
    const resaved = archiveFiles(
      loaded.shards.flatMap((s) => s.placements),
      worldTrack(loaded.shards),
    );
    expect(resaved).toEqual(saved);
    expect(worldTrack(loaded.shards)).toEqual(track);
  });

  it("keeps the consists on the rails through an archive, and counts their imported files as used", () => {
    const sha256 = "a".repeat(64);
    const consists: ConsistRecordV1[] = [
      { ...consist, ref: importRef(sha256) },
      {
        ...consist,
        reversed: false,
        offsetLdu: 0,
        track: {
          on: "model",
          ref: "omr:7936-1",
          color: 0,
          x: 40,
          z: -60,
          yPlates: 0,
          rot: 3,
          piece: 2,
        },
      },
    ];
    const shards = worldShards(placements, track);
    const files = worldArchiveFiles({
      manifest: worldManifest({ ...header, consists }, shards.map(shardEntry)),
      shards,
      credits: "credits",
    });
    const loaded = reread(new Map(files.map((file) => [file.name, file.text])));

    expect(loaded.manifest.consists).toEqual(consists);
    expect(referencedImports(loaded.shards, loaded.manifest.consists ?? [])).toEqual(
      new Set([sha256]),
    );
    expect(referencedImports(loaded.shards, [])).toEqual(new Set());
  });

  it("writes the same bytes whatever order the placements arrive in", () => {
    expect(archiveFiles(backwards(placements), track)).toEqual(archiveFiles(placements, track));
  });

  it("refuses an archive whose track indices skip or repeat", () => {
    const skipped = archiveFiles(
      placements,
      track.filter((piece) => piece.index !== 4),
    );
    const repeated = archiveFiles(
      placements,
      track.map((piece) => (piece.index === 4 ? { ...piece, index: 3 } : piece)),
    );
    for (const files of [skipped, repeated]) {
      expect(readWorldArchive(files)).toEqual({
        ok: false,
        issues: [
          {
            path: "manifest.json",
            message: "the shards' track indices must run 0, 1, 2, … once each",
          },
        ],
      });
    }
  });

  it("reports a shard it can't read without also blaming the track indices", () => {
    const files = archiveFiles(placements, track);
    const shardPath = [...files.keys()].find((name) => name.startsWith("shards/"));
    if (!shardPath) throw new Error("the archive has no shard");
    files.set(shardPath, "{");
    const read = readWorldArchive(files);
    expect(read.ok ? [] : read.issues.map((issue) => issue.path)).toEqual([shardPath]);
  });

  it("refuses an oversized coefficient in an irrational slot with one issue, and never throws", () => {
    const position = ["0", "9".repeat(3000), ...ZEROS.slice(2)];
    expect(decode(WorldShardV1, withTrack({ position }))).toEqual({
      ok: false,
      issues: [{ path: "$.track.0.position.1", message: "is outside the int64 range" }],
    });
    const files = archiveFiles(placements, track);
    const shardPath = [...files.keys()].find((name) => name.startsWith("shards/"));
    const stored = shardPath ? files.get(shardPath) : undefined;
    if (!shardPath || !stored) throw new Error("the archive has no shard");
    const parsed: { track: Array<{ position: string[] }> } = JSON.parse(stored);
    const first = parsed.track[0];
    if (first) first.position = position;
    files.set(shardPath, JSON.stringify(parsed));
    expect(readWorldArchive(files).ok).toBe(false);
  });

  it("bounds the int32 range by the exact position, not its floored stud", () => {
    const inside = ["107374182", ...ZEROS.slice(1)];
    const past = ["107374182", "1", ...ZEROS.slice(2)];
    expect(decode(WorldShardV1, shardFor(inside)).ok).toBe(true);
    expect(decode(WorldShardV1, shardFor(past))).toMatchObject({
      ok: false,
      issues: [{ path: "$.track.0.position", message: "is outside the int32 LDU range" }],
    });
  });

  it("files a piece a hair either side of a super-chunk line on the side it lies", () => {
    let p = 1n;
    let q = 1n;
    for (let i = 0; i < 40; i++) {
      const position = encodeTrackPosition(
        zeta16([BigInt(SUPER_CHUNK_STUDS) - p, 0n, q, 0n, 100n, 0n, -q, 0n]),
      );
      const pastTheLine = 2n * q * q > p * p;
      expect(superChunkOfTrack(position)).toEqual([pastTheLine ? 1 : 0, 0]);
      [p, q] = [p + 2n * q, p + q];
    }
  });

  it("files symmetric track poses on super-chunk lines into the exact super-chunk", () => {
    const next = lcg(31);
    for (let i = 0; i < 2000; i++) {
      const lineX = (next() % 17) - 8;
      const insideZ = (next() % 9) - 4;
      const a = BigInt((next() % 41) - 20);
      const b = BigInt((next() % 41) - 20);
      const c = BigInt((next() % 41) - 20);
      const position = encodeTrackPosition(
        zeta16([
          BigInt(lineX * SUPER_CHUNK_STUDS),
          a,
          b,
          c,
          BigInt(insideZ * SUPER_CHUNK_STUDS + SUPER_CHUNK_STUDS / 2),
          c,
          b,
          a,
        ]),
      );
      expect(superChunkOfTrack(position)).toEqual([lineX, insideZ]);
      const piece = { index: 0, ref: "ldraw:74747", heading: 4, position, yPlates: 0 };
      expect(decode(WorldShardV1, worldShard([lineX, insideZ], [], [piece])).ok).toBe(true);
    }
    expect(superChunkOfTrack(["1024", "40", "0", "0", "0", "0", "0", "40"])).toEqual([4, 0]);
  });
});
