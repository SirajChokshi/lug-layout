import { planManifest, type PlanArchive } from "@brr/schema/plan";
import {
  importRef,
  shardEntry,
  worldManifest,
  worldShards,
  type ImportedFile,
  type WorldArchive,
} from "@brr/schema/world";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { expect, it } from "vitest";
import type { PersistentStorage } from "./persistent-storage.ts";
import { storageModule } from "./storage.module.ts";
import { INDEXED_DB, PERSISTENT_STORAGE, WORLD_REPOSITORY } from "./tokens.ts";
import { contentSha256, IndexedDbWorldRepository } from "./world-repository.ts";

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

const HEADER = {
  name: "Imported models",
  bundleVersion: "test",
  view: { targetX: 0, targetY: 0, targetZ: 0, distance: 1, yaw: 0, pitch: 0 },
  disclaimer: "disclaimer",
};

async function modelFile(name: string, text: string): Promise<ImportedFile> {
  const bytes = utf8.encode(text);
  return { sha256: await contentSha256(bytes), name, bytes };
}

function archivePlacing(
  placed: ReadonlyArray<ImportedFile>,
  carried: ReadonlyArray<ImportedFile>,
): WorldArchive {
  const shards = worldShards(
    placed.map((file, i) => ({
      ref: importRef(file.sha256),
      color: 0,
      x: i * 640,
      z: 0,
      yPlates: 0,
      rot: 0,
    })),
    [],
  );
  return {
    manifest: worldManifest(HEADER, shards.map(shardEntry)),
    shards,
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
  const { shards } = archivePlacing(placed, []);
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
  const { id } = await worlds.create(HEADER, []);
  await worlds.save(id, { header: HEADER, put: [], drop: [] });
  expect(storage.persistRequests).toBe(0);
  await worlds.save(id, { header: HEADER, put: shards, drop: [] });
  await worlds.save(id, { header: HEADER, put: [], drop: shards.map((shard) => shard.superChunk) });
  expect(storage.persistRequests).toBe(1);
});
