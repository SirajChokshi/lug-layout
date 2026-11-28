import { LINK_PROGRESS_SHARE } from "@brr/catalog";
import { EditHistory, World, addShards, type AppliedEdit, type PlacementTarget } from "@brr/domain";
import {
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import type { Decoded, Issue } from "@brr/schema/decode";
import type { PlanArchive } from "@brr/schema/plan";
import {
  BASE_LAYER,
  DEFAULT_WORLD_DOCUMENT,
  noteShardEntry,
  noteShards,
  shardEntry,
  shardName,
  worldManifest,
  worldShards,
  type ImportedFile,
  type NoteShardV2,
  type PlacementRecordV2,
  type SavedViewV1,
  type WorldArchive,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldShardV2,
} from "@brr/schema/world";
import {
  INDEXED_DB,
  PERSISTENT_STORAGE,
  WORLD_REPOSITORY,
  type IWorldRepository,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR_CAMERA, WORLD_SESSION } from "../tokens.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import type { BomInput } from "../bom/bom-service.ts";
import type { PlanSheetShapes } from "../plan/plan-sheet-service.ts";
import type {
  IEditedWorld,
  IWorldSession,
  ModelFileOutcome,
  PlanContents,
  StoredContents,
  WorldContents,
} from "./world-session.ts";
import { silentPeers } from "../catalog/silent-peers.test-support.ts";

const BASEPLATE = "ldraw:3811";
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
  setGhostVerdict(): void {}
  setSelectionBoxes(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
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
    return { world: this.world, refs: [BASEPLATE], track: [], consists: [], notes: [] };
  }

  placedCredits(): ReadonlyArray<ModelCredit> {
    return [];
  }

  validate({ shards }: StoredContents): ReadonlyArray<Issue> {
    const handles = addShards(new World(), shards, baseplateTarget);
    return handles.ok ? [] : handles.issues;
  }

  async load({ shards }: StoredContents): Promise<ReadonlyArray<Issue>> {
    const world = new World();
    const handles = addShards(world, shards, baseplateTarget);
    if (!handles.ok) return handles.issues;
    this.world = world;
    this.history = new EditHistory(world);
    return [];
  }

  async addImportedModel(): Promise<ModelFileOutcome> {
    return { kind: "refused", reason: "this test imports no models" };
  }

  planContents(): Decoded<PlanContents> {
    return { ok: false, issues: [{ path: "plan", message: "is not saved in this test" }] };
  }

  async addPlan(): Promise<ReadonlyArray<Issue>> {
    return [{ path: "plan", message: "is not opened in this test" }];
  }

  bomInput(): BomInput {
    throw new Error("this test counts no parts");
  }

  planSheetShapes(): PlanSheetShapes {
    throw new Error("this test draws no plan sheet");
  }
}

interface MemoryWorld {
  header: WorldHeader;
  readonly shards: Map<string, WorldShardV2>;
  readonly notes: Map<string, NoteShardV2>;
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
    const world = {
      header,
      shards: new Map<string, WorldShardV2>(),
      notes: new Map<string, NoteShardV2>(),
    };
    this.worlds.set(id, world);
    return this.entry(id, world);
  }

  async list(): Promise<ReadonlyArray<WorldIndexEntry>> {
    return [...this.worlds].map(([id, world]) => this.entry(id, world));
  }

  async create(
    header: WorldHeader,
    shards: ReadonlyArray<WorldShardV2>,
    notes: ReadonlyArray<NoteShardV2>,
  ): Promise<WorldIndexEntry> {
    const id = `world-${this.nextId++}`;
    this.worlds.set(id, { header, shards: new Map(), notes: new Map() });
    return this.save(id, { header, put: shards, drop: [], putNotes: notes, dropNotes: [] });
  }

  async read(id: string): Promise<Decoded<StoredWorld>> {
    const world = this.worlds.get(id);
    if (!world) return { ok: false, issues: [{ path: id, message: "is not stored" }] };
    const shards = [...world.shards.values()];
    const notes = [...world.notes.values()];
    const manifest = worldManifest(world.header, shards.map(shardEntry), notes.map(noteShardEntry));
    return { ok: true, value: { id, manifest, shards, notes } };
  }

  async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    if (this.failSaves) throw new Error("QuotaExceededError");
    const world = this.worlds.get(id) ?? {
      header: change.header,
      shards: new Map(),
      notes: new Map(),
    };
    world.header = change.header;
    for (const superChunk of change.drop) world.shards.delete(shardName(superChunk));
    for (const shard of change.put) world.shards.set(shardName(shard.superChunk), shard);
    for (const superChunk of change.dropNotes) world.notes.delete(shardName(superChunk));
    for (const shard of change.putNotes) world.notes.set(shardName(shard.superChunk), shard);
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

  async readWorldFiles(): Promise<Decoded<WorldArchive>> {
    return this.readArchive();
  }

  packPlanArchive(): Uint8Array {
    return new Uint8Array();
  }

  async readPlanArchive(): Promise<Decoded<PlanArchive>> {
    return { ok: false, issues: [{ path: "archive", message: "is not read in this test" }] };
  }
}

class ViewRecordingRepository extends FailingSaveRepository {
  readonly savedViews: SavedViewV1[] = [];

  override async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    this.savedViews.push(change.header.view);
    return super.save(id, change);
  }
}

async function sessionWithFailingSaves() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(LINK_PROGRESS_SHARE).toConstantValue(silentPeers);
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
      ...DEFAULT_WORLD_DOCUMENT,
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

describe("camera saving", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves a moved camera with the world 500 ms after it settles, once for continuous motion, and never for a still camera or a world's restored view", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const container = new Container();
    container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
    container.rebind(LINK_PROGRESS_SHARE).toConstantValue(silentPeers);
    container.rebind(SCENE_BACKEND).toConstantValue(new StubSceneBackend());
    const repository = new ViewRecordingRepository();
    container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
    const session = container.get(WORLD_SESSION);
    const camera = container.get(EDITOR_CAMERA);
    await session.start(new BaseplateWorld(), "test");
    const saves = (): number => repository.savedViews.length;
    const afterStart = saves();

    for (let i = 0; i < 5; i++) {
      session.pollCamera();
      await vi.advanceTimersByTimeAsync(200);
    }
    const afterStill = saves();
    for (let i = 0; i < 10; i++) {
      camera.orbit(5, 0);
      session.pollCamera();
      await vi.advanceTimersByTimeAsync(100);
    }
    const duringMotion = saves();
    await vi.advanceTimersByTimeAsync(399);
    const justBeforeSettled = saves();
    await vi.advanceTimersByTimeAsync(1);
    const settled = saves();
    const settledView = repository.savedViews.at(-1);
    const cameraWhenSettled = camera.savedView();

    const other = repository.seed({
      name: "Other",
      bundleVersion: "test",
      view: { targetX: 640, targetY: 0, targetZ: 640, distance: 2600, yaw: 1, pitch: 0.75 },
      disclaimer: "disclaimer",
      ...DEFAULT_WORLD_DOCUMENT,
    });
    expect(await session.openWorld(other.id)).toBe(true);
    const afterOpen = saves();
    for (let i = 0; i < 5; i++) {
      session.pollCamera();
      await vi.advanceTimersByTimeAsync(200);
    }

    expect({
      afterStill,
      duringMotion,
      justBeforeSettled,
      settled,
      settledView,
      afterRestoredView: saves(),
    }).toEqual({
      afterStill: afterStart,
      duringMotion: afterStart,
      justBeforeSettled: afterStart,
      settled: afterStart + 1,
      settledView: cameraWhenSettled,
      afterRestoredView: afterOpen,
    });
  });
});

async function sessionOnIndexedDb() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(LINK_PROGRESS_SHARE).toConstantValue(silentPeers);
  container.rebind(SCENE_BACKEND).toConstantValue(new StubSceneBackend());
  container.rebind(INDEXED_DB).toConstantValue(new IDBFactory());
  container.rebind(PERSISTENT_STORAGE).toConstantValue(null);
  const session = container.get(WORLD_SESSION);
  const repository = container.get(WORLD_REPOSITORY);
  const edited = new BaseplateWorld();
  await session.start(edited, "test");
  return { session, repository, edited };
}

describe("schema v2 document data", () => {
  const SHOW: WorldHeader = {
    name: "Show",
    bundleVersion: "test",
    view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0, pitch: 0.75 },
    disclaimer: "disclaimer",
    layers: [
      { id: 1, name: "Labels", kind: "notes", visible: true, locked: false, opacity: 80 },
      { ...BASE_LAYER, name: "Plates", locked: true },
    ],
    contributors: [{ id: 3, name: "Ada", color: "#1f77b4" }],
    event: { title: "Show layout", startDate: "2027-03-12", endDate: "2027-03-14" },
  };
  const LABELS = noteShards([
    {
      kind: "text",
      index: 0,
      layer: 1,
      owner: 3,
      text: "Station",
      x: 0,
      z: 0,
      rot: 0,
      heightStuds: 4,
      color: "#000000",
    },
  ]);
  const PLATE: PlacementRecordV2 = { ref: BASEPLATE, color: 2, x: 0, z: 0, yPlates: 0, rot: 0 };

  function showArchive(repository: IWorldRepository, placements: ReadonlyArray<PlacementRecordV2>) {
    const shards = worldShards(placements, []);
    return repository.packArchive({
      manifest: worldManifest(SHOW, shards.map(shardEntry), LABELS.map(noteShardEntry)),
      shards,
      notes: LABELS,
      credits: "credits",
      imports: [],
    });
  }

  it("keeps an imported world's layers, roster, event and notes through the saves of its edits", async () => {
    const { session, repository, edited } = await sessionOnIndexedDb();
    expect(await session.importWorld(showArchive(repository, [PLATE]))).toBe(true);
    const id = session.view().world?.id ?? "";

    session.placementsEdited(edited.place(1));
    await vi.waitFor(() => expect(session.view().world?.placements).toBe(2));
    const stored = await repository.read(id);
    if (!stored.ok) throw new Error("the edited world didn't reopen");

    const { layers, contributors, event } = stored.value.manifest;
    expect({ layers, contributors, event, notes: stored.value.notes }).toEqual({
      layers: SHOW.layers,
      contributors: SHOW.contributors,
      event: SHOW.event,
      notes: LABELS,
    });
  });

  it("refuses a world whose placements carry an owner, rather than dropping it on the next save", async () => {
    const { session, repository } = await sessionOnIndexedDb();
    const before = await repository.list();

    expect(await session.importWorld(showArchive(repository, [{ ...PLATE, owner: 3 }]))).toBe(
      false,
    );
    expect(session.view().fileError).toBe(
      "import failed: shard 0_0.placements.0: is on a layer, in a group or owned by a contributor, which this editor can't keep yet",
    );
    expect(await repository.list()).toEqual(before);
  });
});
