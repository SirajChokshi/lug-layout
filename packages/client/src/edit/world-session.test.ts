import { ASSET_FETCHER, LINK_PROGRESS_SHARE } from "@brr/catalog";
import {
  EditHistory,
  GroupTable,
  World,
  addShards,
  ungroupingChange,
  worldPlacements,
  type AppliedEdit,
  type AppliedGroupChange,
  type PlacementRef,
  type PlacementTarget,
} from "@brr/domain";
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
import { eventDraft } from "../event/event-details.ts";
import { EDITOR, EDITOR_CAMERA, EVENT_DETAILS, LAYER_SERVICE, WORLD_SESSION } from "../tokens.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import type { BomInput } from "../bom/bom-service.ts";
import type { PlanSheetShapes } from "../plan/plan-sheet-service.ts";
import type {
  IEditedWorld,
  IWorldSession,
  MemberRecords,
  ModelFileOutcome,
  PlanContents,
  StoredContents,
  WorldContents,
} from "./world-session.ts";
import { silentPeers } from "../catalog/silent-peers.test-support.ts";
import { fixtureBundleFetcher } from "./fixture-model.test-support.ts";
import { MemoryKits } from "./memory-kits.test-support.ts";

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
  setNoteShapes(): void {}
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
  private placed: PlacementRef[] = [];
  groups = GroupTable.empty;
  readonly heldKits: Array<{ name: string; shards: ReadonlyArray<WorldShardV2> }> = [];

  get placements(): number {
    return this.world.size;
  }

  place(column: number): AppliedEdit {
    const x = column * BASEPLATE_LDU;
    const edit = this.history.place({
      refId: 0,
      colorId: 2,
      x,
      z: 0,
      yPlates: 0,
      rot: 0,
      layer: 0,
      group: null,
    });
    this.placed.push(...edit.changes.map((change) => change.placement));
    return edit;
  }

  ungroup(outermost: number): AppliedGroupChange {
    const placements = this.placed.flatMap((member) => {
      const { handle } = member;
      const group = handle?.live ? handle.group : null;
      return handle && group !== null && this.groups.outermost(group) === outermost
        ? [{ member, layer: handle.layer, group }]
        : [];
    });
    const change = ungroupingChange(this.groups, { placements, pieces: [] });
    if (!change.ok) throw new Error(`group ${outermost} wasn't ungrouped`);
    const applied = this.history.regroup(change.value).groups;
    if (!applied) throw new Error("the group edit carried no group change");
    this.groups = applied.after;
    return applied;
  }

  contents(): WorldContents {
    return {
      world: this.world,
      refs: [BASEPLATE],
      track: [],
      consists: [],
      notes: [],
      groups: this.groups,
    };
  }

  placedCredits(): ReadonlyArray<ModelCredit> {
    return [];
  }

  validate({ shards }: StoredContents): ReadonlyArray<Issue> {
    const handles = addShards(new World(), shards, baseplateTarget);
    return handles.ok ? [] : handles.issues;
  }

  async load({ shards, groups }: StoredContents): Promise<ReadonlyArray<Issue>> {
    const world = new World();
    const handles = addShards(world, shards, baseplateTarget);
    if (!handles.ok) return handles.issues;
    this.world = world;
    this.history = new EditHistory(world);
    this.placed = handles.value.map((handle) => this.history.adopt(handle));
    this.groups = groups;
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

  selectionContents(): Decoded<MemberRecords> {
    const placements = worldPlacements(this.world, [BASEPLATE]);
    return { ok: true, value: { placements, track: [], placed: [] } };
  }

  async holdKit(name: string, shards: ReadonlyArray<WorldShardV2>): Promise<ReadonlyArray<Issue>> {
    this.heldKits.push({ name, shards });
    return [];
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

class FailingSaveRepository extends MemoryKits implements IWorldRepository {
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
  container.rebind(ASSET_FETCHER).toConstantValue(fixtureBundleFetcher());
  const session = container.get(WORLD_SESSION);
  const repository = container.get(WORLD_REPOSITORY);
  const layers = container.get(LAYER_SERVICE);
  const edited = new BaseplateWorld();
  await session.start(edited, "test");
  return { session, repository, layers, edited, container };
}

const SHOW: WorldHeader = {
  name: "Show",
  bundleVersion: "test",
  view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0, pitch: 0.75 },
  disclaimer: "disclaimer",
  layers: [
    { id: 1, name: "Labels", kind: "notes", visible: true, locked: false, opacity: 80 },
    { ...BASE_LAYER, name: "Plates", locked: true },
    { id: 2, name: "Scenery", kind: "parts", visible: false, locked: false, opacity: 60 },
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

describe("schema v2 document data", () => {
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

  it("opens a world whose placements are on layers, keeps each one's layer when its shard is rewritten, and saves a layer edit", async () => {
    const { session, repository, layers, edited } = await sessionOnIndexedDb();
    const scenic = { ...PLATE, x: BASEPLATE_LDU * 2, layer: 2 };
    expect(await session.importWorld(showArchive(repository, [PLATE, scenic]))).toBe(true);
    const id = session.view().world?.id ?? "";
    expect(layers.table().layers).toEqual(SHOW.layers);

    session.placementsEdited(edited.place(1));
    expect(layers.setLocked(2, true)).toEqual([]);
    session.documentEdited();
    await vi.waitFor(() => expect(session.view().world?.placements).toBe(3));
    const stored = await repository.read(id);
    if (!stored.ok) throw new Error("the edited world didn't reopen");

    expect(stored.value.manifest.layers.find((layer) => layer.id === 2)?.locked).toBe(true);
    expect(
      stored.value.shards.flatMap((shard) => shard.placements.map(({ x, layer }) => [x, layer])),
    ).toEqual([
      [0, undefined],
      [BASEPLATE_LDU, undefined],
      [BASEPLATE_LDU * 2, 2],
    ]);
  });

  it("saves plans in a world with no plan layer onto the Tables layer they add, beside a layer created this session", async () => {
    const { session, repository, layers } = await sessionOnIndexedDb();
    const id = session.view().world?.id ?? "";
    const scenery = layers.create("Scenery", "parts");
    if (!scenery.ok) throw new Error("the layer wasn't created");
    session.documentEdited();
    session.plansEdited({
      regions: [
        {
          id: "plan-1",
          name: "Show floor",
          originChunkX: 0,
          originChunkZ: 0,
          maxOverhangMm: 0,
          maxReachMm: 700,
          footprint: {
            roomWidthMm: 4800,
            roomDepthMm: 3000,
            tables: [],
            obstacles: [],
            aisles: [],
            rooms: [],
          },
        },
      ],
      activePlanId: "plan-1",
      tableTypes: [],
    });
    const storedPlans = async () => {
      const stored = await repository.read(id);
      return stored.ok ? (stored.value.manifest.plans ?? []) : [];
    };
    await vi.waitFor(async () => expect(await storedPlans()).toHaveLength(1));
    const stored = await repository.read(id);
    if (!stored.ok) throw new Error("the planned world didn't reopen");

    const { layers: saved, plans } = stored.value.manifest;
    expect({
      layers: saved.map(({ name, kind }) => [name, kind]),
      planLayer: saved.find((layer) => layer.id === plans?.[0]?.layer)?.name,
      fileError: session.view().fileError,
    }).toEqual({
      layers: [
        ["Tables", "plan"],
        ["Parts", "parts"],
        ["Scenery", "parts"],
      ],
      planLayer: "Tables",
      fileError: null,
    });
  });

  it("opens a world whose placements are in nested groups, keeps each one's group when its shard is rewritten, saves an ungroup and leaves the group list out once it's empty", async () => {
    const { session, repository, edited } = await sessionOnIndexedDb();
    const station = { id: 0, name: "Station" };
    const platform = { id: 1, name: "Platform", parent: 0 };
    const grouped = { ...SHOW, groups: [station, platform] };
    const shards = worldShards(
      [
        { ...PLATE, group: 1 },
        { ...PLATE, x: BASEPLATE_LDU * 2, group: 0 },
      ],
      [],
    );
    const archive = repository.packArchive({
      manifest: worldManifest(grouped, shards.map(shardEntry), LABELS.map(noteShardEntry)),
      shards,
      notes: LABELS,
      credits: "credits",
      imports: [],
    });
    expect(await session.importWorld(archive)).toBe(true);
    const id = session.view().world?.id ?? "";
    const opened = edited.groups.groups;
    const ungroup = (outermost: number) => session.groupsEdited(edited.ungroup(outermost));
    const saved = async () => {
      const stored = await repository.read(id);
      if (!stored.ok) throw new Error("the edited world didn't reopen");
      const tags = stored.value.shards.flatMap((shard) =>
        shard.placements.map(({ x, group }) => [x, group]),
      );
      return { groups: stored.value.manifest.groups, tags };
    };

    session.placementsEdited(edited.place(1));
    await vi.waitFor(() => expect(session.view().world?.placements).toBe(3));
    const rewritten = await saved();
    ungroup(0);
    await vi.waitFor(async () => expect((await saved()).groups).toHaveLength(1));
    const ungrouped = await saved();
    ungroup(1);
    await vi.waitFor(async () => expect((await saved()).groups).toBeUndefined());

    expect({ opened, rewritten, ungrouped, emptied: await saved() }).toEqual({
      opened: [station, platform],
      rewritten: {
        groups: [station, platform],
        tags: [
          [0, 1],
          [BASEPLATE_LDU, undefined],
          [BASEPLATE_LDU * 2, 0],
        ],
      },
      ungrouped: {
        groups: [{ id: 1, name: "Platform" }],
        tags: [
          [0, 1],
          [BASEPLATE_LDU, undefined],
          [BASEPLATE_LDU * 2, undefined],
        ],
      },
      emptied: {
        groups: undefined,
        tags: [
          [0, undefined],
          [BASEPLATE_LDU, undefined],
          [BASEPLATE_LDU * 2, undefined],
        ],
      },
    });
  });

  it("refuses a world whose placements carry an owner, rather than dropping it on the next save", async () => {
    const { session, repository } = await sessionOnIndexedDb();
    const before = await repository.list();

    expect(await session.importWorld(showArchive(repository, [{ ...PLATE, owner: 3 }]))).toBe(
      false,
    );
    expect(session.view().fileError).toBe(
      "import failed: shard 0_0.placements.0: is owned by a contributor, which this editor can't keep yet",
    );
    expect(await repository.list()).toEqual(before);
  });
});

function placementXs(shards: ReadonlyArray<WorldShardV2>): ReadonlyArray<number> {
  return shards.flatMap((shard) => shard.placements.map(({ x }) => x));
}

describe("kits", () => {
  it("saves the selected parts as a world archive in the personal or club library, places a kit from its stored archive, takes a kit file into the club library and drops a removed kit", async () => {
    const { session, repository, edited } = await sessionOnIndexedDb();
    edited.place(0);
    edited.place(1);
    const blank = await session.saveKit("  ", "personal");
    const blankError = session.view().fileError;
    const pair = await session.saveKit(" Two plates ", "personal");
    edited.place(2);
    const row = await session.saveKit("Three plates", "club");
    const saved = session.view().kits;
    const rowKit = saved.find((kit) => kit.library === "club");
    if (!pair || !row || !rowKit) throw new Error("the kits weren't saved");
    const opened = await repository.readArchive(row.bytes);
    expect(await session.placeKit(rowKit.id)).toBe(true);
    const downloaded = await session.exportKit(rowKit.id);
    const shards = worldShards([PLATE], []);
    const plain = repository.packArchive({
      manifest: worldManifest(SHOW, shards.map(shardEntry)),
      shards,
      notes: [],
      credits: "credits",
      imports: [],
    });
    const withNotes = await session.addKitFile(showArchive(repository, [PLATE]));
    const notesError = session.view().fileError;
    expect(await session.addKitFile(plain)).toBe(true);
    const added = session.view().kits;
    expect(await session.removeKit(rowKit.id)).toBe(true);

    expect({ blank, blankError, files: [pair.fileName, row.fileName] }).toEqual({
      blank: null,
      blankError: "saving the kit failed: kit name: must be 1 to 200 characters, not all spaces",
      files: ["Two-plates.brr.zip", "Three-plates.brr.zip"],
    });
    expect(
      saved.map(({ name, library, placements, track }) => [name, library, placements, track]),
    ).toEqual([
      ["Three plates", "club", 3, 0],
      ["Two plates", "personal", 2, 0],
    ]);
    expect(opened.ok && [opened.value.manifest.name, placementXs(opened.value.shards)]).toEqual([
      "Three plates",
      [0, BASEPLATE_LDU, BASEPLATE_LDU * 2],
    ]);
    expect(edited.heldKits.map(({ name, shards: held }) => [name, placementXs(held)])).toEqual([
      ["Three plates", [0, BASEPLATE_LDU, BASEPLATE_LDU * 2]],
    ]);
    expect(downloaded).toEqual(row);
    expect({ withNotes, notesError }).toEqual({
      withNotes: false,
      notesError:
        "adding the kit failed: a kit holds parts and track only, and the file also holds trains or notes",
    });
    expect(added.map(({ name, library }) => [name, library])).toEqual([
      ["Show", "club"],
      ["Three plates", "club"],
      ["Two plates", "personal"],
    ]);
    expect(session.view().kits.map(({ name }) => name)).toEqual(["Show", "Two plates"]);
    expect((await repository.kits()).map(({ name }) => name)).toEqual(["Show", "Two plates"]);
  });
});
