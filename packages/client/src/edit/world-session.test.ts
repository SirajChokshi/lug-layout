import { createHash } from "node:crypto";
import { LINK_PROGRESS_SHARE } from "@brr/catalog";
import { EditHistory, World, addShards, type AppliedEdit, type PlacementTarget } from "@brr/domain";
import {
  SCENE_BACKEND,
  type BufferMemory,
  type GroundSettings,
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
import { eventDraft } from "../event/event-details.ts";
import {
  EDITOR,
  EDITOR_CAMERA,
  EVENT_DETAILS,
  TABLE_GROUND,
  UNDERLAY_SERVICE,
  WORLD_SESSION,
} from "../tokens.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import type { BomInput } from "../bom/bom-service.ts";
import type { UnderlayPatch } from "../underlay/underlay-service.ts";
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
  ground: GroundSettings | null = null;
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
  setGround(ground: GroundSettings | null): void {
    this.ground = ground;
  }
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
  const backend = new StubSceneBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(INDEXED_DB).toConstantValue(new IDBFactory());
  container.rebind(PERSISTENT_STORAGE).toConstantValue(null);
  const session = container.get(WORLD_SESSION);
  const repository = container.get(WORLD_REPOSITORY);
  const underlay = container.get(UNDERLAY_SERVICE);
  container.get(TABLE_GROUND).lay({ part: BASEPLATE, depthBelowTopLdu: 8 });
  const edited = new BaseplateWorld();
  await session.start(edited, "test");
  return { session, repository, edited, container, underlay, backend };
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

  it("saves an event edit as one undo step, saves the details each undo and redo restores, and brings them back when the world reopens", async () => {
    const { session, repository, container } = await sessionOnIndexedDb();
    const editor = container.get(EDITOR);
    const events = container.get(EVENT_DETAILS);
    expect(await session.importWorld(showArchive(repository, [PLATE]))).toBe(true);
    const id = session.view().world?.id ?? "";
    const storedEvent = async () => {
      const stored = await repository.read(id);
      if (!stored.ok) throw new Error("the world didn't reopen");
      return stored.value.manifest.event ?? null;
    };
    const saved = (event: unknown) =>
      vi.waitFor(async () => expect(await storedEvent()).toEqual(event));
    const clubbed = { title: "Show layout", club: "PennLUG", startDate: "2027-03-12" };
    expect(events.event()).toEqual(SHOW.event);

    expect(
      events.edit({ ...eventDraft(SHOW.event ?? null), club: "  PennLUG ", endDate: "" }),
    ).toEqual({
      kind: "recorded",
    });
    await saved(clubbed);
    expect(editor.snapshot().history.undoLabel).toBe("event details");
    editor.undo(0);
    await saved(SHOW.event);
    editor.redo(0);
    await saved(clubbed);
    expect(events.edit(eventDraft(null))).toEqual({ kind: "recorded" });
    await saved(null);
    editor.undo(0);
    await saved(clubbed);

    expect(await session.newWorld("Other")).toBe(true);
    expect(events.event()).toBeNull();
    expect(await session.openWorld(id)).toBe(true);
    expect(events.event()).toEqual(clubbed);
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

describe("floor-plan underlay", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const HALL = { name: "hall.png", bytes: new Uint8Array([...PNG, 1, 2, 3]) };
  const ANNEX = { name: "annex.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4]) };
  const HALL_SHA256 = createHash("sha256").update(HALL.bytes).digest("hex");
  const SCALED = {
    from: [100, 50],
    to: [600, 50],
    distanceMm: 4000,
    x: 640,
    z: 0,
  } satisfies UnderlayPatch;
  const RECORD = { ...SCALED, image: HALL_SHA256, opacity: 50, locked: false };
  const LOCKED = "is locked: unlock it to move, rescale, replace or remove it";

  function hallArchive(repository: IWorldRepository, imports: ReadonlyArray<ImportedFile>) {
    const header: WorldHeader = {
      name: "Hall",
      bundleVersion: "test",
      view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0, pitch: 0.75 },
      disclaimer: "disclaimer",
      ...DEFAULT_WORLD_DOCUMENT,
      underlay: RECORD,
    };
    return repository.packArchive({
      manifest: worldManifest(header, []),
      shards: [],
      notes: [],
      credits: "credits",
      imports,
    });
  }

  it("keeps the image and its scale with the world through saves and reopening, and opens it from an archive", async () => {
    const { session, repository, underlay, backend } = await sessionOnIndexedDb();
    const id = session.view().world?.id ?? "";
    expect(await underlay.edit(SCALED, HALL)).toEqual([]);
    await session.retrySave();
    const stored = await repository.read(id);
    const drawn = backend.ground?.underlay;
    expect({
      manifest: stored.ok && stored.value.manifest.underlay,
      file: (await repository.importedFile(HALL_SHA256))?.bytes,
      drawn: drawn && { ...drawn, image: drawn.image.type },
    }).toEqual({
      manifest: RECORD,
      file: HALL.bytes,
      drawn: { image: "image/png", cornerX: -1360, cornerZ: -1000, lduPerPixel: 20, opacity: 0.5 },
    });

    expect(await session.newWorld("Other")).toBe(true);
    expect({ view: underlay.view(), drawn: backend.ground?.underlay }).toEqual({
      view: null,
      drawn: null,
    });
    expect(await session.openWorld(id)).toBe(true);
    expect({ name: underlay.view()?.name, record: underlay.view()?.record }).toEqual({
      name: HALL.name,
      record: RECORD,
    });

    const carried = { ...HALL, sha256: HALL_SHA256 };
    expect(await session.importWorld(hallArchive(repository, [carried]))).toBe(true);
    expect(session.view().world?.name).toBe("Hall");
    expect(underlay.view()?.record).toEqual(RECORD);
  });

  it("applies edits issued back to back in turn; locked, it refuses moving, rescaling, replacing and removing but takes opacity and unlocking", async () => {
    const { underlay } = await sessionOnIndexedDb();
    const backToBack = await Promise.all([
      underlay.edit(SCALED, HALL),
      underlay.edit({ opacity: 70 }),
      underlay.edit({ locked: true }),
    ]);
    expect({ backToBack, record: underlay.view()?.record }).toMatchObject({
      backToBack: [[], [], []],
      record: { opacity: 70, locked: true },
    });
    const refusals = [
      await underlay.edit({ x: 1280 }),
      await underlay.edit({ distanceMm: 8000 }),
      await underlay.edit({}, ANNEX),
      await underlay.remove(),
    ];
    expect(refusals).toEqual(refusals.map(() => [{ path: "underlay", message: LOCKED }]));
    expect(await underlay.edit({ opacity: 80 })).toEqual([]);
    expect(await underlay.edit({ locked: false })).toEqual([]);
    expect(await underlay.edit({ x: 1280 }, ANNEX)).toEqual([]);
    expect({ name: underlay.view()?.name, record: underlay.view()?.record }).toMatchObject({
      name: ANNEX.name,
      record: { x: 1280, opacity: 80, locked: false, distanceMm: 4000 },
    });
  });

  it("refuses an image that isn't PNG or JPEG, and an archive whose underlay image is missing", async () => {
    const { session, repository, underlay } = await sessionOnIndexedDb();
    const gif = { name: "plan.gif", bytes: new TextEncoder().encode("GIF89a") };
    expect(await underlay.edit(SCALED, gif)).toEqual([
      { path: "underlay.image", message: "plan.gif is not a PNG or JPEG image" },
    ]);
    expect(underlay.view()).toBeNull();

    expect(await session.importWorld(hallArchive(repository, []))).toBe(false);
    expect(session.view().fileError).toBe(
      `import failed: imports/${HALL_SHA256}: is the floor-plan underlay but missing`,
    );
  });
});
