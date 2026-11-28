import { planManifest, type PlanArchive } from "@brr/schema/plan";
import {
  BASE_LAYER,
  DEFAULT_WORLD_DOCUMENT,
  canonicalJson,
  importRef,
  inventoryFile,
  noteShards,
  shardEntry,
  worldManifest,
  worldShards,
  worldShardsV1,
  type ImportedFile,
  type PlacementRecordV1,
  type WorldArchive,
  type WorldHeader,
} from "@brr/schema/world";
import v1Manifest from "../../test-fixtures/world-schema/v1/manifest.json" with { type: "json" };
import v1ShardWest from "../../test-fixtures/world-schema/v1/shards/-1_0.json" with { type: "json" };
import v1Shard from "../../test-fixtures/world-schema/v1/shards/0_0.json" with { type: "json" };
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { expect, it } from "vitest";
import type { PersistentStorage } from "./persistent-storage.ts";
import { storageModule } from "./storage.module.ts";
import { INDEXED_DB, PERSISTENT_STORAGE, WORLD_REPOSITORY } from "./tokens.ts";
import {
  WORLD_INDEX_DATABASE,
  contentSha256,
  IndexedDbWorldRepository,
  worldDatabaseName,
} from "./world-repository.ts";
import { openDatabase, requestResult, transactionDone } from "./indexed-db.ts";

const utf8 = new TextEncoder();

const NO_DATABASE: IDBFactory = {
  open: () => {
    throw new Error("archives are packed and read without a database");
  },
  deleteDatabase: () => {
    throw new Error("archives are packed and read without a database");
  },
  cmp: () => 0,
  databases: async () => [],
};

const HEADER: WorldHeader = {
  name: "Imported models",
  bundleVersion: "test",
  view: { targetX: 0, targetY: 0, targetZ: 0, distance: 1, yaw: 0, pitch: 0 },
  disclaimer: "disclaimer",
  ...DEFAULT_WORLD_DOCUMENT,
};

const NO_SIDE_FILES = {
  putNotes: [],
  dropNotes: [],
  putInventories: [],
  dropInventories: [],
} as const;

async function modelFile(name: string, text: string): Promise<ImportedFile> {
  const bytes = utf8.encode(text);
  return { sha256: await contentSha256(bytes), name, bytes };
}

function placing(placed: ReadonlyArray<ImportedFile>): PlacementRecordV1[] {
  return placed.map((file, i) => ({
    ref: importRef(file.sha256),
    color: 0,
    x: i * 640,
    z: 0,
    yPlates: 0,
    rot: 0,
  }));
}

function archivePlacing(
  placed: ReadonlyArray<ImportedFile>,
  carried: ReadonlyArray<ImportedFile>,
): WorldArchive {
  const shards = worldShards(placing(placed), []);
  return {
    manifest: worldManifest(HEADER, shards.map(shardEntry)),
    shards,
    notes: [],
    inventories: [],
    credits: "credits",
    imports: carried,
  };
}

it("carries each placed model file under its content hash, and refuses one that is altered, missing or unplaced", async () => {
  const repository = new IndexedDbWorldRepository(NO_DATABASE, null);
  const road = await modelFile("custom road.ldr", "0 Road\n1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat\n");
  const modular = await modelFile(
    "modular.mpd",
    "0 FILE a.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
  );

  const read = await repository.readArchive(
    repository.packArchive(archivePlacing([road, modular], [road, modular])),
  );
  expect(read.ok && read.value.imports.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
    { ...road, name: "custom road.ldr" },
    modular,
  ]);

  const altered = { ...road, bytes: utf8.encode("0 Road, edited after hashing\n") };
  const tampered = await repository.readArchive(
    repository.packArchive(archivePlacing([road], [altered])),
  );
  expect(tampered.ok ? [] : tampered.issues.map((issue) => issue.message)).toContain(
    "does not hash to the SHA-256 in its path",
  );

  const missing = await repository.readArchive(repository.packArchive(archivePlacing([road], [])));
  expect(missing.ok ? [] : missing.issues.map((issue) => issue.message)).toEqual([
    "is used by a placement but missing",
  ]);

  const unplaced = await repository.readArchive(
    repository.packArchive(archivePlacing([road], [road, modular])),
  );
  expect(unplaced.ok ? [] : unplaced.issues.map((issue) => issue.message)).toEqual([
    "is not used by any placement",
  ]);
});

function planPlacing(
  placed: ReadonlyArray<ImportedFile>,
  carried: ReadonlyArray<ImportedFile>,
): PlanArchive {
  const shards = worldShardsV1(placing(placed), []);
  const plan = {
    name: "Table",
    originChunkX: 0,
    originChunkZ: 0,
    maxOverhangMm: 0,
    maxReachMm: 700,
    footprint: { roomWidthMm: 1000, roomDepthMm: 1000, tables: [], obstacles: [] },
  };
  return {
    manifest: planManifest(
      { bundleVersion: "test", plan, disclaimer: "disclaimer" },
      shards.map(shardEntry),
    ),
    shards,
    credits: "credits",
    outputs: {
      "plan.svg": "<svg/>",
      "parts.csv": "",
      "bricklink.xml": "",
      "rebrickable.csv": "",
    },
    imports: carried,
  };
}

it("carries every model file a plan places in the same bytes whichever order they come in, and refuses one that is missing", async () => {
  const repository = new IndexedDbWorldRepository(NO_DATABASE, null);
  const cottage = await modelFile(
    "my-cottage.ldr",
    "0 Cottage\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
  );
  const shed = await modelFile(
    "my-shed.mpd",
    "0 FILE a.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 roof.dat\n0 FILE roof.dat\n3 4 0 0 0 1 0 0 0 0 1\n",
  );
  const placed = [cottage, shed];

  const packed = repository.packPlanArchive(planPlacing(placed, [cottage, shed]));
  const read = await repository.readPlanArchive(packed);
  expect(read.ok && read.value.imports.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
    cottage,
    shed,
  ]);
  expect(repository.packPlanArchive(planPlacing(placed, [shed, cottage]))).toEqual(packed);

  const missing = await repository.readPlanArchive(
    repository.packPlanArchive(planPlacing(placed, [cottage])),
  );
  expect(missing.ok ? [] : missing.issues.map((issue) => issue.message)).toEqual([
    "is used by a placement but missing",
  ]);
});

class RecordingStorage implements PersistentStorage {
  persistRequests = 0;

  async persist(): Promise<boolean> {
    this.persistRequests++;
    return true;
  }
}

it("asks for persistent storage once, on the first save that changes a world's content", async () => {
  const storage = new RecordingStorage();
  const container = new Container();
  container.load(storageModule);
  container.rebind(INDEXED_DB).toConstantValue(new IDBFactory());
  container.rebind(PERSISTENT_STORAGE).toConstantValue(storage);
  const worlds = container.get(WORLD_REPOSITORY);
  const shards = worldShards([{ ref: "ldraw:3811", color: 2, x: 0, z: 0, yPlates: 0, rot: 0 }], []);
  const { id } = await worlds.create(HEADER, [], [], []);
  await worlds.save(id, { header: HEADER, put: [], drop: [], ...NO_SIDE_FILES });
  expect(storage.persistRequests).toBe(0);
  await worlds.save(id, { header: HEADER, put: shards, drop: [], ...NO_SIDE_FILES });
  await worlds.save(id, {
    header: HEADER,
    put: [],
    drop: shards.map((shard) => shard.superChunk),
    ...NO_SIDE_FILES,
  });
  expect(storage.persistRequests).toBe(1);
});

function repositoryOn(factory: IDBFactory) {
  const container = new Container();
  container.load(storageModule);
  container.rebind(INDEXED_DB).toConstantValue(factory);
  container.rebind(PERSISTENT_STORAGE).toConstantValue(null);
  return container.get(WORLD_REPOSITORY);
}

async function seedV1World(factory: IDBFactory, id: string): Promise<void> {
  const index = await openDatabase(factory, WORLD_INDEX_DATABASE, [
    { name: "worlds", keyPath: "id" },
  ]);
  const listed = index.transaction("worlds", "readwrite");
  listed
    .objectStore("worlds")
    .put({ id, name: v1Manifest.name, placements: 3, track: 2, shards: 2, savedAt: 1 });
  await transactionDone(listed);
  index.close();
  const world = await openDatabase(factory, worldDatabaseName(id), [
    { name: "manifest" },
    { name: "shards" },
  ]);
  const stored = world.transaction(["manifest", "shards"], "readwrite");
  stored.objectStore("manifest").put(canonicalJson(v1Manifest), "manifest");
  stored.objectStore("shards").put(canonicalJson(v1Shard), "0_0");
  stored.objectStore("shards").put(canonicalJson(v1ShardWest), "-1_0");
  await transactionDone(stored);
  world.close();
}

async function storedShardTexts(factory: IDBFactory, id: string): Promise<string[]> {
  const world = await openDatabase(factory, worldDatabaseName(id), [
    { name: "manifest" },
    { name: "shards" },
  ]);
  const texts = await requestResult(world.transaction("shards").objectStore("shards").getAll());
  world.close();
  return texts.map(String);
}

it("opens a world an earlier version saved as schema v1, and keeps saving it as v2 beside the shards it hasn't rewritten", async () => {
  const factory = new IDBFactory();
  await seedV1World(factory, "saved-by-v1");
  const worlds = repositoryOn(factory);

  const opened = await worlds.read("saved-by-v1");
  if (!opened.ok) throw new Error("the v1 world didn't open");
  expect(opened.value.manifest.schemaVersion).toBe(2);
  expect(opened.value.manifest.layers).toEqual([BASE_LAYER]);
  expect(opened.value.shards.map((shard) => shard.placements.length)).toEqual([1, 2]);

  const east = worldShards(
    [{ ref: "ldraw:3811", color: 2, x: 5120, z: 0, yPlates: 0, rot: 0 }],
    [],
  );
  const header: WorldHeader = { ...HEADER, name: "Club loop" };
  await worlds.save("saved-by-v1", { header, put: east, drop: [], ...NO_SIDE_FILES });

  const reopened = await worlds.read("saved-by-v1");
  if (!reopened.ok) throw new Error("the upgraded world didn't reopen");
  expect(reopened.value.manifest.placements).toBe(4);
  expect(reopened.value.shards.map((shard) => shard.schemaVersion)).toEqual([2, 2, 2]);
  expect(
    (await storedShardTexts(factory, "saved-by-v1")).map((text) => JSON.parse(text).schemaVersion),
  ).toEqual([1, 1, 2]);
});

const NOTES_HEADER: WorldHeader = {
  ...HEADER,
  layers: [
    BASE_LAYER,
    { id: 1, name: "Notes", kind: "notes", visible: true, locked: false, opacity: 100 },
  ],
};

const ADA = { id: 3, name: "Ada", color: "#bf2626" } as const;

const ZONE = {
  kind: "zone",
  index: 0,
  layer: 1,
  name: "Town",
  color: "#2ca02c",
  outline: [
    [0, 0],
    [200, 0],
    [200, 200],
  ],
} as const;

it("stores a world's note shards and inventories beside its parts and drops them on request", async () => {
  const worlds = repositoryOn(new IDBFactory());
  const notes = noteShards([{ ...ZONE, outline: ZONE.outline.map(([x, z]) => [x, z]) }]);
  const header: WorldHeader = { ...NOTES_HEADER, contributors: [ADA] };
  const inventories = [
    inventoryFile(ADA.id, {
      rebrickable: [{ part: "3001", color: 4, quantity: 3 }],
      ldraw: [{ part: "ldraw:3811", color: 2, quantity: 2 }],
    }),
  ];
  const { id } = await worlds.create(header, [], notes, inventories);

  const read = await worlds.read(id);
  expect(read.ok && [read.value.notes, read.value.inventories]).toEqual([notes, inventories]);
  expect(read.ok && [read.value.manifest.notes, read.value.manifest.inventories]).toEqual([
    1,
    [{ contributor: ADA.id, parts: 5 }],
  ]);

  await worlds.save(id, {
    header,
    put: [],
    drop: [],
    ...NO_SIDE_FILES,
    dropNotes: notes.map((shard) => shard.superChunk),
    dropInventories: [ADA.id],
  });
  const dropped = await worlds.read(id);
  expect(
    dropped.ok && [
      dropped.value.notes,
      dropped.value.manifest.noteShards,
      dropped.value.inventories,
      dropped.value.manifest.inventories,
    ],
  ).toEqual([[], [], [], undefined]);
});

it("refuses to save a placement on a layer the header doesn't list, a note on a parts layer, or an inventory of a contributor it doesn't list", async () => {
  const worlds = repositoryOn(new IDBFactory());
  const { id } = await worlds.create(NOTES_HEADER, [], [], []);
  const onLayerSeven = worldShards(
    [{ ref: "ldraw:3811", color: 2, x: 0, z: 0, yPlates: 0, rot: 0, layer: 7 }],
    [],
  );
  const noteOnParts = noteShards([
    { ...ZONE, layer: 0, outline: ZONE.outline.map(([x, z]) => [x, z]) },
  ]);

  await expect(
    worlds.save(id, { header: NOTES_HEADER, put: onLayerSeven, drop: [], ...NO_SIDE_FILES }),
  ).rejects.toThrow("shard 0_0.placements.0.layer: names layer 7, which the manifest doesn't list");
  await expect(
    worlds.save(id, {
      header: NOTES_HEADER,
      put: [],
      drop: [],
      ...NO_SIDE_FILES,
      putNotes: noteOnParts,
    }),
  ).rejects.toThrow("note shard 0_0.notes.0.layer: names layer 0, a parts layer, not a notes one");
  await expect(
    worlds.save(id, {
      header: NOTES_HEADER,
      put: [],
      drop: [],
      ...NO_SIDE_FILES,
      putInventories: [
        inventoryFile(ADA.id, {
          rebrickable: [],
          ldraw: [{ part: "ldraw:3811", color: 2, quantity: 1 }],
        }),
      ],
    }),
  ).rejects.toThrow("inventories/3.json: names contributor 3, whom the manifest doesn't list");
  const unchanged = await worlds.read(id);
  expect(
    unchanged.ok && [unchanged.value.shards, unchanged.value.notes, unchanged.value.inventories],
  ).toEqual([[], [], []]);
});
