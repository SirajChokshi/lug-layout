import v1Manifest from "../../../test-fixtures/world-schema/v1/manifest.json" with { type: "json" };
import v1ShardWest from "../../../test-fixtures/world-schema/v1/shards/-1_0.json" with { type: "json" };
import v1Shard from "../../../test-fixtures/world-schema/v1/shards/0_0.json" with { type: "json" };
import migratedManifest from "../../../test-fixtures/world-schema/v1-migrated/manifest.json" with { type: "json" };
import migratedShardWest from "../../../test-fixtures/world-schema/v1-migrated/shards/-1_0.json" with { type: "json" };
import migratedShard from "../../../test-fixtures/world-schema/v1-migrated/shards/0_0.json" with { type: "json" };
import richManifest from "../../../test-fixtures/world-schema/v2/manifest.json" with { type: "json" };
import richNotesWest from "../../../test-fixtures/world-schema/v2/notes/-1_0.json" with { type: "json" };
import richNotes from "../../../test-fixtures/world-schema/v2/notes/0_0.json" with { type: "json" };
import richShard from "../../../test-fixtures/world-schema/v2/shards/0_0.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import {
  CREDITS_FILE,
  MANIFEST_FILE,
  NoteShardV2,
  WorldHeader,
  WorldManifestV2,
  WorldShardV2,
  canonicalJson,
  decodeWorldManifest,
  noteShardEntry,
  noteShards,
  readWorldFiles,
  shardEntry,
  worldArchiveFiles,
  worldHeader,
  worldManifest,
  worldNotes,
  worldShards,
  worldTrack,
  type NoteRecordV2,
  type PlacementRecordV2,
  type TrackRecordV2,
} from "./index.ts";

function filesOf(entries: Readonly<Record<string, unknown>>): Map<string, string> {
  return new Map(Object.entries(entries).map(([name, json]) => [name, canonicalJson(json)]));
}

const V1 = filesOf({
  [MANIFEST_FILE]: v1Manifest,
  "shards/-1_0.json": v1ShardWest,
  "shards/0_0.json": v1Shard,
});

const MIGRATED = filesOf({
  [MANIFEST_FILE]: migratedManifest,
  "shards/-1_0.json": migratedShardWest,
  "shards/0_0.json": migratedShard,
});

const RICH = filesOf({
  [MANIFEST_FILE]: richManifest,
  "shards/0_0.json": richShard,
  "notes/-1_0.json": richNotesWest,
  "notes/0_0.json": richNotes,
});

function readOk(files: ReadonlyMap<string, string>) {
  const read = readWorldFiles(files);
  if (!read.ok) throw new Error(read.issues.map((i) => `${i.path} ${i.message}`).join("; "));
  return read.value;
}

function written(world: ReturnType<typeof readOk>): Map<string, string> {
  const files = worldArchiveFiles({ ...world, credits: "credits" });
  return new Map(
    files.flatMap((file) => (file.name === CREDITS_FILE ? [] : [[file.name, file.text]])),
  );
}

function jsonOf(files: ReadonlyMap<string, string>, name: string): Record<string, unknown> {
  return JSON.parse(files.get(name) ?? "{}");
}

function withJson(
  files: ReadonlyMap<string, string>,
  name: string,
  patch: (json: Record<string, unknown>) => Record<string, unknown>,
): Map<string, string> {
  return new Map([...files, [name, canonicalJson(patch(jsonOf(files, name)))]]);
}

type Json = Record<string, unknown>;

function rows(json: Json, key: string): Json[] {
  const value = json[key];
  if (!Array.isArray(value)) throw new Error(`the fixture's ${key} is not a list`);
  return value.map((row: unknown) => ({ ...Object(row) }));
}

function backwards<T>(list: ReadonlyArray<T>): T[] {
  return list.flatMap((_, i) => list.slice(list.length - 1 - i, list.length - i));
}

function replaced(list: ReadonlyArray<Json>, index: number, patch: Json): Json[] {
  return list.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

const RICH_MANIFEST = jsonOf(RICH, MANIFEST_FILE);
const RICH_SHARD = jsonOf(RICH, "shards/0_0.json");
const RICH_NOTES = jsonOf(RICH, "notes/0_0.json");
const LAYERS = rows(RICH_MANIFEST, "layers");
const PLANS = rows(RICH_MANIFEST, "plans");
const NOTE_SHARD_ENTRIES = rows(RICH_MANIFEST, "noteShards");
const EVENT = { ...Object(RICH_MANIFEST["event"]) };

function manifestWith(patch: Json): Json {
  return { ...RICH_MANIFEST, ...patch };
}

function eventWith(patch: Json): Json {
  return manifestWith({ event: { ...EVENT, ...patch } });
}

function placementWith(patch: Json): Json {
  return { ...RICH_SHARD, placements: replaced(rows(RICH_SHARD, "placements"), 0, patch) };
}

function noteWith(index: number, patch: Json): Json {
  return { ...RICH_NOTES, notes: replaced(rows(RICH_NOTES, "notes"), index, patch) };
}

const SAME_POINT_RULER = {
  kind: "ruler",
  index: 0,
  layer: 2,
  from: { on: "point", x: 5, z: 5 },
  to: { on: "point", x: 5, z: 5 },
  color: "#000000",
};

describe("world schema v2", () => {
  it("migrates a v1 world to the v2 golden files, byte for byte", () => {
    const migrated = written(readOk(V1));
    expect(migrated).toEqual(MIGRATED);
  });

  it("reads the migrated golden as v2 and writes it back unchanged", () => {
    const golden = MIGRATED;
    expect(written(readOk(golden))).toEqual(golden);
  });

  it("reads a world using every document field and writes it back byte-identical", () => {
    const world = readOk(RICH);
    expect(written(world)).toEqual(RICH);
    expect(world.manifest.layers.map((layer) => layer.kind)).toEqual([
      "parts",
      "parts",
      "plan",
      "notes",
    ]);
    expect(worldNotes(world.notes).map((note) => note.kind)).toEqual([
      "zone",
      "legend",
      "text",
      "ruler",
    ]);
  });

  it("decodes a v1 manifest on its own as its v2 migration", () => {
    const v1 = jsonOf(V1, MANIFEST_FILE);
    const v2 = jsonOf(MIGRATED, MANIFEST_FILE);
    const decoded = decodeWorldManifest(v1, MANIFEST_FILE);
    expect(decoded.ok && canonicalJson(decoded.value)).toBe(canonicalJson(v2));
  });

  it.each([
    [
      "a schema version newer than this app reads",
      3,
      "is 3, newer than the schema version 2 this app reads",
    ],
    ["a schema version this app never wrote", 0, "must be 1 or 2"],
  ])("refuses a world with %s before reading anything else", (_name, schemaVersion, message) => {
    const files = withJson(RICH, MANIFEST_FILE, (json) => ({ ...json, schemaVersion, layers: [] }));
    expect(readWorldFiles(files)).toEqual({
      ok: false,
      issues: [{ path: `${MANIFEST_FILE}.schemaVersion`, message }],
    });
  });

  it.each([
    ["no base layer", manifestWith({ layers: LAYERS.slice(1) }), "$.layers"],
    [
      "a base layer that isn't a parts layer",
      manifestWith({ layers: replaced(LAYERS, 0, { kind: "notes" }) }),
      "$.layers",
    ],
    ["a repeated layer id", manifestWith({ layers: replaced(LAYERS, 1, { id: 2 }) }), "$.layers"],
    [
      "a layer of no known kind",
      manifestWith({ layers: replaced(LAYERS, 0, { kind: "area" }) }),
      "$.layers.0.kind",
    ],
    [
      "an opacity past 100 percent",
      manifestWith({ layers: replaced(LAYERS, 0, { opacity: 101 }) }),
      "$.layers.0.opacity",
    ],
    [
      "a layer id past 65535",
      manifestWith({ layers: replaced(LAYERS, 1, { id: 65536 }) }),
      "$.layers.1.id",
    ],
    ["an empty group list", manifestWith({ groups: [] }), "$.groups"],
    [
      "groups out of id order",
      manifestWith({
        groups: [
          { id: 2, name: "B" },
          { id: 1, name: "A" },
        ],
      }),
      "$.groups",
    ],
    [
      "a group inside a group the manifest doesn't list",
      manifestWith({ groups: [{ id: 1, name: "A", parent: 9 }] }),
      "$.groups",
    ],
    [
      "groups nested inside each other",
      manifestWith({
        groups: [
          { id: 1, name: "A", parent: 2 },
          { id: 2, name: "B", parent: 1 },
        ],
      }),
      "$.groups",
    ],
    [
      "a contributor colour in upper case",
      manifestWith({ contributors: [{ id: 0, name: "Ada", color: "#1F77B4" }] }),
      "$.contributors.0.color",
    ],
    [
      "a repeated contributor id",
      manifestWith({
        contributors: [
          { id: 0, name: "Ada", color: "#1f77b4" },
          { id: 0, name: "Grace", color: "#ff7f0e" },
        ],
      }),
      "$.contributors",
    ],
    [
      "a plan on a notes layer",
      manifestWith({ plans: replaced(PLANS, 0, { layer: 2 }) }),
      "$.plans",
    ],
    ["an active plan past the plans", manifestWith({ activePlan: 1 }), "$.activePlan"],
    [
      "an active plan with no plans",
      Object.fromEntries(Object.entries(RICH_MANIFEST).filter(([key]) => key !== "plans")),
      "$.activePlan",
    ],
    ["an empty event", manifestWith({ event: {} }), "$.event"],
    [
      "an end date without a start date",
      manifestWith({ event: { endDate: "2027-03-14" } }),
      "$.event.endDate",
    ],
    ["an end date before the start date", eventWith({ endDate: "2027-03-11" }), "$.event.endDate"],
    ["the thirtieth of February", eventWith({ startDate: "2027-02-30" }), "$.event.startDate"],
    ["a blank event title", eventWith({ title: "   " }), "$.event.title"],
    ["a note count that disagrees with its shards", manifestWith({ notes: 5 }), "$.notes"],
    [
      "note shards out of order",
      manifestWith({ noteShards: backwards(NOTE_SHARD_ENTRIES) }),
      "$.noteShards",
    ],
    ["an unknown key", manifestWith({ layer: 0 }), "$.layer"],
  ])("rejects a manifest with %s at its path", (_name, value, path) => {
    const decoded = decode(WorldManifestV2, value);
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toContain(path);
  });

  it("accepts the 29th of February only in a leap year", () => {
    expect(
      decode(WorldManifestV2, eventWith({ startDate: "2028-02-29", endDate: "2028-03-01" })).ok,
    ).toBe(true);
    expect(decode(WorldManifestV2, eventWith({ startDate: "2100-02-29" })).ok).toBe(false);
  });

  it.each([
    ["the base layer written out", placementWith({ layer: 0 }), "$.placements.0.layer"],
    ["a fractional owner", placementWith({ owner: 1.5 }), "$.placements.0.owner"],
    ["a negative group", placementWith({ group: -1 }), "$.placements.0.group"],
    ["an unknown key", placementWith({ contributor: 4 }), "$.placements.0.contributor"],
  ])("rejects a shard with %s at its path", (_name, value, path) => {
    const decoded = decode(WorldShardV2, value);
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toContain(path);
  });

  it.each([
    [
      "a zone with two corners",
      noteWith(0, {
        outline: [
          [0, 0],
          [20, 0],
        ],
      }),
      "$.notes.0.outline",
    ],
    [
      "a zone on one line",
      noteWith(0, {
        outline: [
          [0, 0],
          [20, 0],
          [40, 0],
        ],
      }),
      "$.notes.0.outline",
    ],
    [
      "a zone repeating a corner back to back",
      noteWith(0, {
        outline: [
          [0, 0],
          [20, 0],
          [20, 0],
          [20, 20],
        ],
      }),
      "$.notes.0.outline",
    ],
    [
      "a zone corner between studs",
      noteWith(0, {
        outline: [
          [0, 0],
          [30, 0],
          [20, 20],
        ],
      }),
      "$.notes.0.outline.1.0",
    ],
    ["a text zero studs high", noteWith(1, { heightStuds: 0 }), "$.notes.1.heightStuds"],
    ["a text off the stud lattice", noteWith(1, { x: 210 }), "$.notes.1.x"],
    [
      "a ruler whose ends are the same point",
      { ...RICH_NOTES, notes: [SAME_POINT_RULER] },
      "$.notes.0.to",
    ],
    ["a note of no known kind", noteWith(0, { kind: "area" }), "$.notes.0.kind"],
    [
      "a note anchored outside the shard's super-chunk",
      noteWith(0, {
        outline: [
          [-20, 0],
          [20, 0],
          [20, 20],
        ],
      }),
      "$.notes",
    ],
    ["no notes", { ...RICH_NOTES, notes: [] }, "$"],
  ])("rejects a note shard with %s at its path", (_name, value, path) => {
    const decoded = decode(NoteShardV2, value);
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toContain(path);
  });

  it.each([
    [
      "a placement on a layer the manifest doesn't list",
      withJson(RICH, "shards/0_0.json", () => placementWith({ layer: 7 })),
      "shards/0_0.json.placements.0.layer",
      "names layer 7, which the manifest doesn't list",
    ],
    [
      "a placement on a notes layer",
      withJson(RICH, "shards/0_0.json", () => placementWith({ layer: 2 })),
      "shards/0_0.json.placements.0.layer",
      "names layer 2, a notes layer, not a parts one",
    ],
    [
      "a track piece owned by a contributor the manifest doesn't list",
      withJson(RICH, "shards/0_0.json", (shard) => ({
        ...shard,
        track: replaced(rows(shard, "track"), 0, { owner: 9 }),
      })),
      "shards/0_0.json.track.0.owner",
      "names contributor 9, whom the manifest doesn't list",
    ],
    [
      "a placement in a group the manifest doesn't list",
      withJson(RICH, "shards/0_0.json", () => placementWith({ group: 5 })),
      "shards/0_0.json.placements.0.group",
      "names group 5, which the manifest doesn't list",
    ],
    [
      "a note on a parts layer",
      withJson(RICH, "notes/0_0.json", () => noteWith(0, { layer: 3 })),
      "notes/0_0.json.notes.0.layer",
      "names layer 3, a parts layer, not a notes one",
    ],
    [
      "note indices that skip one",
      withJson(RICH, "notes/0_0.json", () => noteWith(0, { index: 4 })),
      MANIFEST_FILE,
      "the note shards' note indices must run 0, 1, 2, … once each",
    ],
    [
      "a note shard the manifest lists but the archive lacks",
      new Map([...RICH].filter(([name]) => name !== "notes/-1_0.json")),
      "notes/-1_0.json",
      "is listed in the manifest but missing",
    ],
    [
      "a note shard the manifest doesn't list",
      new Map([...RICH, ["notes/9_9.json", RICH.get("notes/-1_0.json") ?? ""]]),
      "notes/9_9.json",
      "is not part of a world",
    ],
  ])("refuses a world with %s", (_name, files, path, message) => {
    const read = readWorldFiles(files);
    expect(read.ok ? [] : read.issues).toContainEqual({ path, message });
  });

  describe("canonical writing", () => {
    const world = readOk(RICH);
    const placements: PlacementRecordV2[] = world.shards.flatMap((shard) => shard.placements);
    const track: TrackRecordV2[] = worldTrack(world.shards);
    const notes: NoteRecordV2[] = worldNotes(world.notes);

    function archive(
      placed: ReadonlyArray<PlacementRecordV2>,
      laid: ReadonlyArray<TrackRecordV2>,
      noted: ReadonlyArray<NoteRecordV2>,
    ): Map<string, string> {
      const shards = worldShards(placed, laid);
      const notesShards = noteShards(noted);
      const manifest = worldManifest(
        worldHeader(world.manifest),
        shards.map(shardEntry),
        notesShards.map(noteShardEntry),
      );
      return written({ manifest, shards, notes: notesShards });
    }

    it("writes the same bytes whatever order the records arrive in", () => {
      expect(archive(backwards(placements), backwards(track), backwards(notes))).toEqual(RICH);
    });

    it("writes a zone outline from its lowest corner, counter-clockwise, however it was drawn", () => {
      const zone = notes[0];
      if (zone?.kind !== "zone") throw new Error("the rich world's first note is a zone");
      const outlines = [
        [
          [1280, 640],
          [1280, 0],
          [0, 0],
          [0, 640],
        ],
        [
          [0, 640],
          [1280, 640],
          [1280, 0],
          [0, 0],
        ],
        [
          [1280, 0],
          [1280, 640],
          [0, 640],
          [0, 0],
        ],
      ];
      for (const outline of outlines) {
        const redrawn: NoteRecordV2 = {
          ...zone,
          outline: outline.map(([x, z]) => [x ?? 0, z ?? 0]),
        };
        expect(archive(placements, track, [redrawn, ...notes.slice(1)])).toEqual(RICH);
      }
    });

    it("keeps the header's document tables through worldHeader and worldManifest", () => {
      const header = worldHeader(world.manifest);
      expect(decode(WorldHeader, header).ok).toBe(true);
      expect(
        canonicalJson(worldManifest(header, world.manifest.shards, world.manifest.noteShards)),
      ).toBe(RICH.get(MANIFEST_FILE));
    });
  });
});
