import { EditHistory, World, addShards, type AppliedEdit, type PlacementTarget } from "@brr/domain";
import {
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import type { Decoded, Issue } from "@brr/schema/decode";
import {
  shardEntry,
  shardName,
  worldManifest,
  type ImportedFile,
  type WorldArchive,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldShardV1,
} from "@brr/schema/world";
import {
  WORLD_REPOSITORY,
  type IWorldRepository,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { Container } from "inversify";
import { describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { WORLD_SESSION } from "../tokens.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import type { IEditedWorld, IWorldSession, WorldContents } from "./world-session.ts";

const BASEPLATE = "ldraw:3811@2";
const BASEPLATE_LDU = 640;

class StubSceneBackend implements ISceneBackend {
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return false;
  }
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  setFarModel(): void {}
}

function baseplateTarget(ref: string, color: number): PlacementTarget | null {
  return ref === BASEPLATE ? { refId: 0, colorId: color } : null;
}

class BaseplateWorld implements IEditedWorld {
  private world = new World();
  private history = new EditHistory(this.world);

  get placements(): number {
    return this.world.size;
  }

  place(column: number): AppliedEdit {
    const x = column * BASEPLATE_LDU;
    return this.history.place({ refId: 0, colorId: 2, x, z: 0, yPlates: 0, rot: 0 });
  }

  contents(): WorldContents {
    return { world: this.world, refs: [BASEPLATE], track: [] };
  }

  placedCredits(): ReadonlyArray<ModelCredit> {
    return [];
  }

  validate(shards: ReadonlyArray<WorldShardV1>): ReadonlyArray<Issue> {
    const handles = addShards(new World(), shards, baseplateTarget);
    return handles.ok ? [] : handles.issues;
  }

  async load(shards: ReadonlyArray<WorldShardV1>): Promise<ReadonlyArray<Issue>> {
    const world = new World();
    const handles = addShards(world, shards, baseplateTarget);
    if (!handles.ok) return handles.issues;
    this.world = world;
    this.history = new EditHistory(world);
    return [];
  }

  async addImportedModel(): Promise<string | null> {
    return null;
  }
}

interface MemoryWorld {
  header: WorldHeader;
  readonly shards: Map<string, WorldShardV1>;
}

class FailingSaveRepository implements IWorldRepository {
  failSaves = false;
  private readonly worlds = new Map<string, MemoryWorld>();
  private readonly imports = new Map<string, ImportedFile>();
  private nextId = 1;

  storedPlacements(): number {
    let count = 0;
    for (const world of this.worlds.values()) {
      for (const shard of world.shards.values()) count += shard.placements.length;
    }
    return count;
  }

  private entry(id: string, world: MemoryWorld): WorldIndexEntry {
    const manifest = worldManifest(world.header, [...world.shards.values()].map(shardEntry));
    return {
      id,
      name: world.header.name,
      placements: manifest.placements,
      track: manifest.track,
      shards: manifest.shards.length,
      savedAt: 0,
    };
  }

  seed(header: WorldHeader): WorldIndexEntry {
    const id = `world-${this.nextId++}`;
    const world = { header, shards: new Map<string, WorldShardV1>() };
    this.worlds.set(id, world);
    return this.entry(id, world);
  }

  async list(): Promise<ReadonlyArray<WorldIndexEntry>> {
    return [...this.worlds].map(([id, world]) => this.entry(id, world));
  }

  async create(header: WorldHeader, shards: ReadonlyArray<WorldShardV1>): Promise<WorldIndexEntry> {
    const id = `world-${this.nextId++}`;
    this.worlds.set(id, { header, shards: new Map() });
    return this.save(id, { header, put: shards, drop: [] });
  }

  async read(id: string): Promise<Decoded<StoredWorld>> {
    const world = this.worlds.get(id);
    if (!world) return { ok: false, issues: [{ path: id, message: "is not stored" }] };
    const shards = [...world.shards.values()];
    return {
      ok: true,
      value: { id, manifest: worldManifest(world.header, shards.map(shardEntry)), shards },
    };
  }

  async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    if (this.failSaves) throw new Error("QuotaExceededError");
    const world = this.worlds.get(id) ?? { header: change.header, shards: new Map() };
    world.header = change.header;
    for (const superChunk of change.drop) world.shards.delete(shardName(superChunk));
    for (const shard of change.put) world.shards.set(shardName(shard.superChunk), shard);
    this.worlds.set(id, world);
    return this.entry(id, world);
  }

  async remove(id: string): Promise<void> {
    this.worlds.delete(id);
  }

  async putImportedFile(file: ImportedFile): Promise<void> {
    this.imports.set(file.sha256, file);
  }

  async importedFile(sha256: string): Promise<ImportedFile | undefined> {
    return this.imports.get(sha256);
  }

  async shardFiles(): Promise<never[]> {
    return [];
  }

  packArchive(): Uint8Array {
    return new Uint8Array();
  }

  async readArchive(): Promise<Decoded<WorldArchive>> {
    return { ok: false, issues: [{ path: "archive", message: "is not read in this test" }] };
  }
}

async function sessionWithFailingSaves() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(SCENE_BACKEND).toConstantValue(new StubSceneBackend());
  const repository = new FailingSaveRepository();
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const session = container.get(WORLD_SESSION);
  const edited = new BaseplateWorld();
  await session.start(edited, "test");
  expect(session.view().world?.save).toBe("saved");

  session.placementsEdited(edited.place(0));
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(1));
  repository.failSaves = true;
  session.placementsEdited(edited.place(1));
  await vi.waitFor(() => expect(session.view().world?.save).toBe("failed"));
  return { session, edited, repository };
}

describe("unsaved edits after a failed save", () => {
  it.each([
    ["New", (session: IWorldSession) => session.newWorld("Other")],
    ["Import", (session: IWorldSession) => session.importWorld(new Uint8Array())],
  ])("refuses %s and keeps the world and its edits", async (_action, act) => {
    const { session, edited } = await sessionWithFailingSaves();

    expect(await act(session)).toBe(false);

    const view = session.view();
    expect(view.world?.name).toBe("World 1");
    expect(edited.placements).toBe(2);
    expect(view.unsavedEdits).toBe(true);
    expect(view.fileError).toContain("has unsaved edits (saving failed: QuotaExceededError)");
  });

  it("refuses Open of another world, then saves everything on Retry and lets the switch through", async () => {
    const { session, repository } = await sessionWithFailingSaves();
    const other = repository.seed({
      name: "Other",
      bundleVersion: "test",
      view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0, pitch: 0.75 },
      disclaimer: "disclaimer",
    });

    expect(await session.openWorld(other.id)).toBe(false);
    expect(session.view().world?.name).toBe("World 1");

    repository.failSaves = false;
    await session.retrySave();
    expect(repository.storedPlacements()).toBe(2);
    expect(session.view().unsavedEdits).toBe(false);
    expect(session.view().world?.save).toBe("saved");

    expect(await session.openWorld(other.id)).toBe(true);
    expect(session.view().world?.name).toBe("Other");
  });
});
