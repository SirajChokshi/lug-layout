import {
  ASSET_FETCHER,
  BUNDLE_LODS,
  PART_BUNDLE_LOADER,
  type BricklinkPartCandidates,
  type CatalogCrosswalk,
  type CompiledPartGlb,
  type FetchPriority,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type ModelRecord,
  type PartAsset,
  type PartBundle,
  type PartFilter,
  type PartMesh,
  type PartShapeRecord,
  type StudPrimitiveAsset,
  type PackageAttribution,
  type ConnectorLoad,
  type PartConnectors,
} from "@brr/catalog";
import type {
  BundleIndex,
  BundleLod,
  BundleManifest,
  BundleModelEntry,
  CatalogPart,
  RollingDiagnosticsFile,
} from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  INSTANCE_MATRIX_FLOATS,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ChunkTier,
  type FarModelPlacement,
  type ISceneBackend,
  type LookSettings,
  type NeededMeshListener,
  type PaletteLevel,
  type PartMeshUpdate,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { STUD_LDU } from "@brr/math";
import type { Decoded } from "@brr/schema/decode";
import {
  shardEntry,
  shardName,
  worldManifest,
  type WorldArchive,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldShardV1,
} from "@brr/schema/world";
import {
  WORLD_LOCKS,
  WORLD_REPOSITORY,
  type IWorldLocks,
  type IWorldRepository,
  type WorldLease,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { commandEnabled, startPlay, type CommandId } from "../commands/editor-commands.ts";
import { toolHints } from "../commands/tool-hints.ts";
import type { ImportResult, PlacementListener, RollingDiagnosticsRows } from "@brr/import";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import {
  BOM_SERVICE,
  CONNECTOR_TABLES,
  EDITOR,
  MODEL_IMPORTER,
  PLACEMENT_SEARCH,
  PLAN_SERVICE,
  TRAIN_PLAY,
  PLACEABLE_CATALOG,
} from "../tokens.ts";
import type { BomScope } from "../bom/bom-service.ts";
import type { PlaceableConnectorTables } from "../connect/connector-tables.ts";
import { loadCatalogItem } from "../catalog/catalog-item.test-support.ts";
import { TRACK_ITEM_ID, type EditorSnapshot, type IEditor } from "./editor.ts";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import { meshesSettled } from "./mesh-progress.ts";
import { chosen, settledChoice } from "./editor-choice.test-support.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const PLACEABLE_SET = "7936-1";
const SET_WITHOUT_TRACK = "10185-1";
const RAY_HEIGHT_LDU = 10_000;
const STUDLESS_SET = "10016-1";
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};
const BASEPLATE = "ldraw:3811@2";

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class InFlightFetcher implements IAssetFetcher {
  inFlight = 0;
  maxInFlight = 0;
  requests = 0;
  readonly paths: string[] = [];

  constructor(
    private readonly files: IAssetFetcher,
    private readonly failing: (path: string) => boolean = () => false,
  ) {}

  private async track<T>(path: string, read: () => Promise<T>): Promise<T> {
    this.requests++;
    this.paths.push(path);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (this.failing(path)) throw new TypeError("Failed to fetch");
      return await read();
    } finally {
      this.inFlight--;
    }
  }

  bytes(path: string): Promise<ArrayBuffer> {
    return this.track(path, () => this.files.bytes(path));
  }

  text(path: string): Promise<string> {
    return this.track(path, () => this.files.text(path));
  }
}

function importedByUser(entry: BundleModelEntry): BundleModelEntry {
  return { ...entry, origin: "omr" };
}

class ModelSubsetLoader implements IPartBundleLoader {
  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly models: ReadonlyArray<string>,
    private readonly userModels: ReadonlyArray<string> = [],
    private readonly userLoader: IPartBundleLoader | null = null,
  ) {}

  loadManifestFile(): Promise<string> {
    return this.loader.loadManifestFile();
  }

  async loadIndex(lod: BundleLod): Promise<BundleIndex> {
    const index = await this.loader.loadIndex(lod);
    const imported = this.userLoader
      ? (await this.userLoader.loadIndex(lod)).models
          .filter((m) => this.userModels.includes(m.name))
          .map(importedByUser)
      : [];
    return {
      ...index,
      models: [...index.models.filter((m) => this.models.includes(m.name)), ...imported],
    };
  }

  loadStudPrimitives(lod: BundleLod): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    return this.loader.loadStudPrimitives(lod);
  }

  loadPartShape(lod: BundleLod, part: CatalogPart): Promise<PartShapeRecord> {
    return this.loader.loadPartShape(lod, part);
  }

  async loadModelRecord(lod: BundleLod, name: string): Promise<ModelRecord> {
    if (!this.userLoader || !this.userModels.includes(name)) {
      return this.loader.loadModelRecord(lod, name);
    }
    const record = await this.userLoader.loadModelRecord(lod, name);
    return { ...record, entry: importedByUser(record.entry) };
  }

  loadPartMesh(lod: BundleLod, file: string, priority: FetchPriority): Promise<PartMesh> {
    return this.loader.loadPartMesh(lod, file, priority);
  }

  setPartMeshPriority(lod: BundleLod, file: string, priority: FetchPriority): void {
    this.loader.setPartMeshPriority(lod, file, priority);
  }

  loadFarModelMesh(name: string, priority: FetchPriority): Promise<PartMesh | null> {
    return this.loader.loadFarModelMesh(name, priority);
  }

  loadPartFiles(lod: BundleLod): Promise<ReadonlyMap<string, string>> {
    return this.loader.loadPartFiles(lod);
  }

  loadManifest(lod: BundleLod): Promise<BundleManifest> {
    return this.loader.loadManifest(lod);
  }

  async load(lod: BundleLod, include: PartFilter): Promise<PartBundle> {
    const bundle = await this.loader.load(lod, include);
    return { ...bundle, models: bundle.models.filter((m) => this.models.includes(m.name)) };
  }

  loadModel(lod: BundleLod, name: string): Promise<ModelBundle> {
    return this.loader.loadModel(lod, name);
  }

  importContext(lod: BundleLod): Promise<ImportContext> {
    return this.loader.importContext(lod);
  }

  loadPartConnectors(lod: BundleLod, partId: string): Promise<PartConnectors | null> {
    return this.loader.loadPartConnectors(lod, partId);
  }

  readPartConnectors(lod: BundleLod, partId: string): Promise<ConnectorLoad> {
    return this.loader.readPartConnectors(lod, partId);
  }

  loadConnectivityAttribution(lod: BundleLod): Promise<PackageAttribution> {
    return this.loader.loadConnectivityAttribution(lod);
  }

  loadSectionVocabularyAttribution(lod: BundleLod): Promise<PackageAttribution | null> {
    return this.loader.loadSectionVocabularyAttribution(lod);
  }

  loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle> {
    return this.loader.loadPartSet(lod, partIds, compiled);
  }

  loadCrosswalk(lod: BundleLod): Promise<CatalogCrosswalk> {
    return this.loader.loadCrosswalk(lod);
  }

  loadBricklinkParts(lod: BundleLod): Promise<BricklinkPartCandidates> {
    return this.loader.loadBricklinkParts(lod);
  }

  loadRollingDiagnostics(lod: BundleLod): Promise<RollingDiagnosticsFile | null> {
    return this.loader.loadRollingDiagnostics(lod);
  }
}

interface AimedBackend {
  aim(x: number, z: number): void;
}

class HeadlessBackend implements ISceneBackend {
  async init(): Promise<BackendInfo> {
    return {
      requestedApi: "webgl2",
      activeApi: "webgl2",
      adapter: "none",
      backgroundSrgb: 0,
      look: NO_LOOK,
    };
  }
  readonly partIds: string[] = [];
  readonly chunks = new Map<number, ChunkInstances>();
  readonly farModels = new Map<number, FarModelPlacement>();
  private readonly detailedMeshes: PartMesh[] = [];
  setPalette(palette: PartPalette): void {
    this.partIds.splice(0, this.partIds.length, ...palette.detailed.parts.map((part) => part.id));
    this.detailedMeshes.splice(
      0,
      this.detailedMeshes.length,
      ...palette.detailed.parts.map((part) => part.mesh),
    );
  }
  addParts(parts: ReadonlyArray<PartAsset>): void {
    this.partIds.push(...parts.map((part) => part.id));
    this.detailedMeshes.push(...parts.map((part) => part.mesh));
  }
  setPartMeshes(updates: ReadonlyArray<PartMeshUpdate>): void {
    for (const { index, level, part } of updates) {
      if (level === "detailed") this.detailedMeshes[index] = part.mesh;
    }
  }
  trianglesOf(partId: string): number {
    const mesh = this.detailedMeshes[this.partIds.indexOf(partId)];
    return mesh?.groups.reduce((sum, group) => sum + group.indices.length / 3, 0) ?? 0;
  }
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
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
  private aimX = 0;
  private aimZ = 0;
  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
  }
  rayThrough(_ndcX: number, _ndcY: number, out: Float64Array): void {
    out.set([this.aimX, RAY_HEIGHT_LDU, this.aimZ, 0, -1, 0]);
  }
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  setFarModel(id: number, placement: FarModelPlacement | null): void {
    if (placement) this.farModels.set(id, placement);
    else this.farModels.delete(id);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startEditor(
  models: ReadonlyArray<string> | null = [PLACEABLE_SET, STUDLESS_SET],
  fetcher: IAssetFetcher = new BundleDirectoryFetcher(),
  userModels: ReadonlyArray<string> = [],
  importer: IModelImporter | null = null,
) {
  const backend = new HeadlessBackend();
  let scheduled: FrameRequestCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled = callback;
    return 1;
  });
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const realLoader = container.get(PART_BUNDLE_LOADER);
  if (models !== null) {
    container
      .rebind(PART_BUNDLE_LOADER)
      .toConstantValue(
        new ModelSubsetLoader(
          realLoader,
          models,
          userModels,
          userModels.length > 0 ? fixtureBundleLoader() : null,
        ),
      );
  }
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  if (importer !== null) container.rebind(MODEL_IMPORTER).toConstantValue(importer);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;

  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const frame = async (): Promise<void> => {
    const callback = scheduled;
    if (!callback) throw new Error("no frame is scheduled");
    scheduled = null;
    callback(performance.now());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    editor,
    backend,
    container,
    catalog: container.get(PLACEABLE_CATALOG),
    manifest: await realLoader.loadManifest("standard"),
    frame,
  };
}

function farTierSettled(editor: IEditor): Promise<EditorSnapshot> {
  return new Promise((resolve) => {
    const check = (): void => {
      const snapshot = editor.snapshot();
      if (snapshot.farTier === "loading") return;
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = editor.subscribe(check);
    check();
  });
}

async function studPrimitivePaths(): Promise<ReadonlySet<string>> {
  const files = new BundleDirectoryFetcher();
  const paths = await Promise.all(
    BUNDLE_LODS.map(async (lod) => {
      const index: { studPrimitives: ReadonlyArray<{ file: string }> } = JSON.parse(
        await files.text(`${lod}/manifest.json`),
      );
      return index.studPrimitives.map((primitive) => `${lod}/${primitive.file}`);
    }),
  );
  return new Set(paths.flat());
}

async function partMeshes(paths: ReadonlyArray<string>, lod: BundleLod): Promise<string[]> {
  const studs = await studPrimitivePaths();
  return paths.filter(
    (path) => path.startsWith(`${lod}/`) && path.endsWith(".glb") && !studs.has(path),
  );
}

it("starts from the index and part shapes, fetching no model record and no part mesh, and at most 16 files at once", async () => {
  const fetcher = new InFlightFetcher(new BundleDirectoryFetcher());
  const { editor, manifest } = await startEditor(null, fetcher);

  expect(editor.snapshot().error).toBeNull();
  expect(editor.snapshot().status).toBe("ready");
  const settled = await farTierSettled(editor);
  expect(settled.farTier).toBe("ready");
  expect(settled.farTierError).toBeNull();
  expect(await partMeshes(fetcher.paths, "standard")).toEqual([]);
  expect(await partMeshes(fetcher.paths, "far")).toEqual([]);
  expect(fetcher.paths.filter((path) => path.startsWith("standard/shape-"))).toHaveLength(
    manifest.catalogParts.length,
  );
  const fetchedModels = manifest.models.filter((model) =>
    fetcher.paths.includes(`standard/${model.file}`),
  );
  expect(fetchedModels.map((model) => model.name)).toEqual([]);
  expect(fetcher.maxInFlight).toBeLessThanOrEqual(16);
}, 300_000);

it("loads a set's record only once it is picked, places a click made while it loads once it has loaded, and fetches its meshes once placed", async () => {
  const fetcher = new InFlightFetcher(new BundleDirectoryFetcher());
  const { editor, backend, manifest } = await startEditor([PLACEABLE_SET], fetcher);
  const set = `omr:${PLACEABLE_SET}`;
  const record = `standard/${manifest.models.find((model) => model.name === PLACEABLE_SET)?.file}`;
  const placeNow = placerNow(editor, backend);

  expect(fetcher.paths).not.toContain(record);
  const whileLoading = { ...placeNow(set, 640, 640), ...queuedOf(editor) };
  await settledChoice(editor);
  expect(fetcher.paths).toContain(record);

  expect({ whileLoading, loaded: editor.snapshot() }).toMatchObject({
    whileLoading: { placements: 0, refusedClicks: 0, queuedPlacement: { item: set } },
    loaded: { placements: 1, refusedClicks: 0, queuedPlacement: null },
  });
  await vi.waitFor(() => {
    const { detailedPartMeshes } = editor.snapshot().meshes;
    expect(detailedPartMeshes.wanted).toBeGreaterThan(0);
    expect(detailedPartMeshes.loaded).toBe(detailedPartMeshes.wanted);
  });
  expect(await partMeshes(fetcher.paths, "standard")).toHaveLength(
    editor.snapshot().meshes.detailedPartMeshes.wanted,
  );
}, 120_000);

it("starts without the far tier when its files cannot be fetched", async () => {
  const fetcher = new InFlightFetcher(new BundleDirectoryFetcher(), (path) =>
    path.startsWith("far/"),
  );
  const { editor } = await startEditor([PLACEABLE_SET], fetcher);

  expect(editor.snapshot().status).toBe("ready");
  const snapshot = await farTierSettled(editor);
  expect(snapshot.error).toBeNull();
  expect(snapshot.farTier).toBe("unavailable");
  expect(snapshot.farTierError).toContain("Failed to fetch");
  expect(snapshot.catalog.map((item) => item.id)).toContain(`omr:${PLACEABLE_SET}`);
}, 120_000);

it("starts with a stud-less set in the bundle, leaving it out of the catalog and reporting it as skipped", async () => {
  const { editor } = await startEditor();

  const snapshot = editor.snapshot();
  expect(snapshot.error).toBeNull();
  expect(snapshot.status).toBe("ready");
  const ids = snapshot.catalog.map((item) => item.id);
  expect(ids).toContain(`omr:${PLACEABLE_SET}`);
  expect(ids).not.toContain(`omr:${STUDLESS_SET}`);
  expect(snapshot.catalogSkipped).toEqual([
    { name: STUDLESS_SET, reason: "no stud lattice from the bake" },
  ]);
  expect(snapshot.credits?.models.map((credit) => credit.name)).toContain(STUDLESS_SET);
}, 120_000);

it("offers exactly the placed models with running gear as trains under their palette labels, after every place, delete and undo, and Play takes its train from them when it opens", async () => {
  const { editor, backend, container, catalog } = await startEditor([
    SET_WITHOUT_TRACK,
    "10205-1",
    "10133-1",
  ]);
  const play = container.get(TRAIN_PLAY);
  const place = placer(editor, backend);
  const set = `omr:${SET_WITHOUT_TRACK}`;
  const myOwnTrain = "omr:10205-1";
  const locomotive = "omr:10133-1";
  const trains = () => editor.playSetup()?.models.map((model) => model.name);
  const openPlay = async () => {
    startPlay(editor, play);
    await vi.waitFor(() => expect(play.snapshot().status).toBe("error"));
    return play.snapshot().error;
  };
  const noTrack = expect.stringContaining("Lay some track first");

  const nothingPlaced = { trains: trains(), play: await openPlay() };
  for (const item of [set, myOwnTrain, locomotive]) await loadCatalogItem(catalog, item);
  await place(set, 0, 0);
  const setPlaced = trains();
  await place(myOwnTrain, 1600, 0);
  const myOwnTrainPlaced = trains();
  await place(locomotive, 0, 1600);
  await place(myOwnTrain, 1600, 1600);
  const allPlaced = trains();
  const locomotiveLabel = editor.playSetup()?.models[0]?.label;
  play.chooseTrain("10133-1");
  selectAt(editor, backend, 0, 1600);
  editor.deleteSelection(0);
  const locomotiveDeleted = trains();
  const playAfterDelete = await openPlay();
  editor.undo(0);
  const deleteUndone = trains();

  expect({
    nothingPlaced,
    setPlaced,
    myOwnTrainPlaced,
    allPlaced,
    locomotiveLabel,
    locomotiveDeleted,
    playAfterDelete,
    deleteUndone,
  }).toEqual({
    nothingPlaced: { trains: [], play: "No train is placed on the layout." },
    setPlaced: [],
    myOwnTrainPlaced: ["10205-1"],
    allPlaced: ["10133-1", "10205-1"],
    locomotiveLabel: "10133-1 Burlington Northern Santa Fe Locomotive (2004)",
    locomotiveDeleted: ["10205-1"],
    playAfterDelete: noTrack,
    deleteUndone: ["10133-1", "10205-1"],
  });
}, 120_000);

it("runs Play on the track inside a placed set, with the placed train", async () => {
  const { editor, backend, container, catalog } = await startEditor([PLACEABLE_SET, "10205-1"]);
  const play = container.get(TRAIN_PLAY);
  const place = placer(editor, backend);
  for (const item of [`omr:${PLACEABLE_SET}`, "omr:10205-1"]) {
    await loadCatalogItem(catalog, item);
  }
  await place(`omr:${PLACEABLE_SET}`, 0, 0);
  await place("omr:10205-1", 1600, 0);
  const setTrack = editor.snapshot().track?.modelPieces ?? 0;

  startPlay(editor, play);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const started = play.snapshot();
  play.stop();

  expect(setTrack).toBeGreaterThan(0);
  expect(editor.playSetup()?.track.layout.count).toBe(setTrack);
  expect(editor.playSetup()?.models.map((model) => model.name)).toEqual(["10205-1"]);
  expect(started).toMatchObject({ status: "loading", error: null });
}, 120_000);

const TRACK_STRAIGHT = "ldraw:74746";
const STRAIGHTS_IN_RUN = 4;

it.each([
  { scope: "world", regionStraights: null, straights: STRAIGHTS_IN_RUN, brick: 1 },
  { scope: "region", regionStraights: 2, straights: 2, brick: 0 },
] as const)(
  "counts each drawn track piece once in the $scope parts list, beside a user's model, by its part origin",
  async ({ regionStraights, straights, brick }) => {
    const userModel = "brick-2x4";
    const { editor, backend, container, catalog, manifest } = await startEditor(
      [],
      new BundleDirectoryFetcher(),
      [userModel],
    );
    const straight = manifest.catalogParts.find((part) => part.id === TRACK_STRAIGHT);
    const straightLdu = (straight?.trackEnds?.[1]?.xStuds ?? 0) * STUD_LDU;
    await loadCatalogItem(catalog, `omr:${userModel}`);
    expect((await placer(editor, backend)(`omr:${userModel}`, 1600, 1600)).placements).toBe(1);
    editor.chooseItem(TRACK_ITEM_ID);
    backend.aim(0, 0);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    backend.aim(STRAIGHTS_IN_RUN * straightLdu, 0);
    editor.dragMove(0, 0);
    editor.dragEnd(0, 0, 0);
    const scope: BomScope =
      regionStraights === null
        ? { kind: "world" }
        : {
            kind: "region",
            region: {
              minX: 0,
              minZ: -straightLdu,
              maxX: regionStraights * straightLdu,
              maxZ: straightLdu,
            },
          };

    const bom = await container.get(BOM_SERVICE).billOfMaterials(editor, scope);

    expect(editor.snapshot().track?.pieces).toBe(STRAIGHTS_IN_RUN);
    expect({ placements: bom.placements, parts: bom.parts, ldraw: bom.ldraw }).toEqual({
      placements: straights + brick,
      parts: straights + brick,
      ldraw: [
        ...(brick > 0 ? [{ part: "ldraw:3001", ldrawColor: 16, quantity: brick }] : []),
        { part: TRACK_STRAIGHT, ldrawColor: straight?.displayColor?.ldraw, quantity: straights },
      ],
    });
  },
  120_000,
);

it("offers every baseplate and road plate in exactly the produced colours the bundle lists", async () => {
  const { editor, manifest } = await startEditor();

  const { catalog } = editor.snapshot();
  const catalogParts = manifest.parts.filter((p) => p.role === "ground" || p.role === "road");
  expect(catalogParts.length).toBeGreaterThan(0);
  const offered = catalogParts.map((part) => [
    part.id,
    catalog.filter((item) => item.group === part.id).map((item) => item.color?.code),
  ]);
  const produced = catalogParts.map((part) => [
    part.id,
    part.producedColors?.colors.map((color) => color.ldraw),
  ]);
  expect(offered).toEqual(produced);
}, 120_000);

interface MemoryWorld {
  header: WorldHeader;
  readonly shards: Map<string, WorldShardV1>;
}

class MemoryRepository implements IWorldRepository {
  private readonly worlds = new Map<string, MemoryWorld>();
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

  async shardFiles(): Promise<never[]> {
    return [];
  }

  packArchive(): Uint8Array {
    return new Uint8Array();
  }

  async readArchive(): Promise<Decoded<WorldArchive>> {
    return { ok: false, issues: [{ path: "archive", message: "is not read in this test" }] };
  }

  async putImportedFile(): Promise<void> {}

  async importedFile(): Promise<undefined> {
    return undefined;
  }
}

function placerNow(editor: IEditor, backend: AimedBackend) {
  return (item: string, x: number, z: number) => {
    editor.chooseItem(item);
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    const { placements, refusedClicks, lastRefusal } = editor.snapshot();
    return { placements, refusedClicks, reason: lastRefusal?.reason ?? null };
  };
}

function queuedOf(editor: IEditor) {
  return { queuedPlacement: editor.snapshot().queuedPlacement };
}

function placer(editor: IEditor, backend: AimedBackend) {
  const now = placerNow(editor, backend);
  return async (item: string, x: number, z: number) => {
    await chosen(editor, item);
    return now(item, x, z);
  };
}

it("R cycles the fitting turns of a road curve at a road straight's open end, and the click lays the turn the ghost shows", async () => {
  const { editor, backend } = await startEditor([]);
  await chosen(editor, "ldraw:44336p04@72");
  backend.aim(320, 320);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  await chosen(editor, "ldraw:44342p02@72");
  backend.aim(320, 960);
  editor.pointerMove(0, 0);
  const shown = () => {
    const { ghostRot, snap } = editor.snapshot();
    return { ghostRot, fit: snap?.state === "snapped" ? ghostRot : null };
  };
  for (const direction of [1, -1] as const) {
    const turns = [shown()];
    for (let press = 0; press < 4; press++) {
      editor.rotate(0, direction);
      const turned = shown();
      editor.pointerMove(0, 0);
      expect(shown()).toEqual(turned);
      turns.push(turned);
    }
    for (const turn of turns) expect(turn.fit).toBe(turn.ghostRot);
    const rots = turns.map((turn) => turn.ghostRot);
    expect(new Set(rots).size).toBe(2);
    expect(rots.filter((rot, i) => i > 0 && rot === rots[i - 1])).toEqual([]);
  }
  const shownRot = shown().ghostRot;
  editor.click(0, 0, 0);
  const { placements } = editor.dump();
  expect(placements.rot.at(-1)).toBe(shownRot);
}, 120_000);

function selectAt(editor: IEditor, backend: AimedBackend, x: number, z: number) {
  editor.chooseItem(null);
  backend.aim(x, z);
  editor.click(0, 0, 0);
  return editor.snapshot().selection;
}

function turnOutcome(editor: IEditor, direction: 1 | -1) {
  editor.rotate(0, direction);
  const { selection, selectionRefusal, lastRefusal } = editor.snapshot();
  return {
    rot: selection?.rot ?? null,
    yPlates: selection?.yPlates ?? null,
    refusal: selectionRefusal,
    roadCells: lastRefusal ? lastRefusal.mismatchedCells + lastRefusal.overlappingCells : null,
  };
}

it("refuses to turn a baseplate while a set rests on it, turns the set itself, and turns the baseplate once the set is gone", async () => {
  const { editor, backend, catalog } = await startEditor([PLACEABLE_SET]);
  const place = placer(editor, backend);
  const set = `omr:${PLACEABLE_SET}`;
  await loadCatalogItem(catalog, set);
  await place(BASEPLATE, 0, 0);
  await place(set, 0, 0);
  const corner = 300;

  expect(selectAt(editor, backend, corner, corner)?.item).toBe(BASEPLATE);
  const baseplateUnderSet = turnOutcome(editor, 1);
  const baseplateUnderSetBack = turnOutcome(editor, -1);
  expect(selectAt(editor, backend, 0, 0)?.item).toBe(set);
  const setOnBaseplate = turnOutcome(editor, -1);
  editor.deleteSelection(0);
  expect(selectAt(editor, backend, corner, corner)?.item).toBe(BASEPLATE);
  const bareBaseplate = turnOutcome(editor, -1);

  const refused = {
    rot: 0,
    yPlates: 0,
    refusal: expect.stringContaining(`rests on it`),
    roadCells: 0,
  };
  expect({ baseplateUnderSet, baseplateUnderSetBack, setOnBaseplate, bareBaseplate }).toEqual({
    baseplateUnderSet: refused,
    baseplateUnderSetBack: refused,
    setOnBaseplate: { rot: 3, yPlates: 0, refusal: null, roadCells: 0 },
    bareBaseplate: { rot: 3, yPlates: 0, refusal: null, roadCells: 0 },
  });
}, 120_000);

it("refuses to turn a placed road plate into a mismatch with its neighbour, the same as placing it there, unless road snap is off", async () => {
  const { editor, backend } = await startEditor([]);
  const place = placer(editor, backend);
  const straight = "ldraw:44336p04@72";
  await place(straight, 320, 320);
  await place(straight, 320, 960);
  expect(editor.snapshot().roads.mismatchedCells).toBe(0);

  expect(selectAt(editor, backend, 320, 960)?.item).toBe(straight);
  const turned = turnOutcome(editor, 1);
  const turnedBack = turnOutcome(editor, -1);
  const mismatchedWhileRefused = editor.snapshot().roads.mismatchedCells;
  editor.setSnapRoads(false);
  const unsnapped = turnOutcome(editor, 1);

  expect({ turned, turnedBack, mismatchedWhileRefused, unsnapped }).toEqual({
    turned: {
      rot: 0,
      yPlates: 0,
      refusal: expect.stringContaining("road edges would mismatch"),
      roadCells: expect.any(Number),
    },
    turnedBack: expect.objectContaining({ rot: 0 }),
    mismatchedWhileRefused: 0,
    unsnapped: expect.objectContaining({ rot: 1, refusal: null }),
  });
  expect(turned.roadCells).toBeGreaterThan(0);
}, 120_000);

class OtherTabLocks implements IWorldLocks {
  readonly heldElsewhere = new Set<string>();

  async hold(id: string): Promise<WorldLease> {
    return {
      exclusive: !this.heldElsewhere.has(id),
      whenExclusive: new Promise<void>(() => undefined),
      release: () => undefined,
    };
  }
}

it("leaves road mode when the world turns read-only, and refuses road draw and erase strokes there", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, []));
  const backend = new HeadlessBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const repository = new MemoryRepository();
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const locks = new OtherTabLocks();
  container.rebind(WORLD_LOCKS).toConstantValue(locks);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const kit = editor.snapshot().roadKits.find((k) => k.label.startsWith("Dark Bluish Grey"));
  if (!kit) throw new Error("no Dark Bluish Grey road kit");
  const tile = 640;
  const stroke = (row: number) => {
    backend.aim(tile / 2, row * tile + tile / 2);
    editor.dragStart(0, 0);
    for (const column of [1, 2]) {
      backend.aim(column * tile + tile / 2, row * tile + tile / 2);
      editor.dragMove(0, 0);
    }
    editor.dragEnd(0, 0, 0);
  };

  editor.chooseItem(kit.id);
  stroke(0);
  expect(editor.snapshot().placements).toBe(3);
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(3));
  const first = editor.snapshot().world?.id;
  if (!first) throw new Error("no current world");
  expect(await editor.newWorld("Second")).toBe(true);
  editor.chooseItem(kit.id);
  expect(editor.snapshot().mode).toBe("road");

  locks.heldElsewhere.add(first);
  expect(await editor.openWorld(first)).toBe(true);
  const readOnly = editor.snapshot();
  expect([readOnly.readOnly, readOnly.mode, readOnly.placements]).toEqual([true, "select", 3]);
  expect(commandEnabled("draw-road", readOnly)).toBe(false);
  editor.chooseItem(kit.id);
  expect(editor.snapshot().mode).toBe("select");
  stroke(1);
  editor.setRoadErase(true);
  stroke(0);
  expect(editor.snapshot().placements).toBe(3);
  expect(editor.snapshot().unsavedEdits).toBe(false);
}, 120_000);

const READ_ONLY_REFUSED: ReadonlyArray<CommandId> = [
  "rotate",
  "delete",
  "duplicate",
  "draw-track",
  "undo",
];

function editsOffered(snapshot: ReturnType<IEditor["snapshot"]>) {
  return {
    selected: snapshot.selection !== null,
    offered: READ_ONLY_REFUSED.filter((id) => commandEnabled(id, snapshot)),
  };
}

class HeldElsewhereLocks implements IWorldLocks {
  readonly held = new Set<string>();

  async hold(id: string): Promise<WorldLease> {
    return {
      exclusive: !this.held.has(id),
      whenExclusive: new Promise<void>(() => undefined),
      release: () => undefined,
    };
  }
}

it("offers none of the world's editing commands in a world another tab holds, but draws a table and undoes it, as plans aren't in the world", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, []));
  const backend = new HeadlessBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const repository = new MemoryRepository();
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const locks = new HeldElsewhereLocks();
  container.rebind(WORLD_LOCKS).toConstantValue(locks);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const selectBaseplate = () => {
    editor.chooseItem(null);
    editor.click(0, 0, 0);
    return editor.snapshot();
  };

  await chosen(editor, BASEPLATE);
  editor.click(0, 0, 0);
  expect(editsOffered(selectBaseplate())).toEqual({ selected: true, offered: READ_ONLY_REFUSED });
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(1));
  const first = editor.snapshot().world?.id;
  if (!first) throw new Error("no current world");
  expect(await editor.newWorld("Second")).toBe(true);

  locks.held.add(first);
  expect(await editor.openWorld(first)).toBe(true);
  const readOnly = selectBaseplate();
  expect(readOnly.readOnly).toBe(true);
  expect(editsOffered(readOnly)).toEqual({ selected: true, offered: [] });

  const plans = container.get(PLAN_SERVICE);
  const tablesAndUndo = () => ({
    tables: plans.plans().flatMap((plan) => plan.footprint.tables).length,
    undo: commandEnabled("undo", editor.snapshot()),
  });
  editor.setTableTool(true);
  backend.aim(0, 0);
  editor.dragStart(0, 0);
  backend.aim(640, 640);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
  const drawn = tablesAndUndo();
  editor.undo(0);
  expect({ drawn, undone: tablesAndUndo() }).toEqual({
    drawn: { tables: 1, undo: true },
    undone: { tables: 0, undo: false },
  });
}, 120_000);

const NO_LATTICE_REASON = "no stud lattice from the bake";

function importReport(
  fileName: string,
  instanceCount: number,
  bakeIssue: string | null,
): ImportResult["report"] {
  return {
    fileName,
    mirror: { repo: "", commit: "", root: "" },
    lod: "standard",
    sections: [],
    instanceCount,
    drawnInstanceCount: instanceCount,
    parts: [],
    inlineParts: [],
    looseGeometry: [],
    unknownColors: [],
    directColors: [],
    compileRounds: 0,
    withoutConnectorRecords: [],
    refusedConnectorRecords: [],
    bakeRounds: 1,
    bakeIssue,
    bakeHelpersFailed: 0,
    fetched: { requests: 0, found: 0, notFound: 0, bytes: 0 },
    records: null,
    timings: {
      readMs: 0,
      resolveMs: 0,
      bakeMs: 0,
      totalMs: 0,
      placementMs: 0,
      recordFetchMs: 0,
      compileMs: 0,
      ldrawFetchMs: 0,
      bakePhases: null,
      coverPhases: null,
    },
  };
}

function refusedBake(fileName: string): ImportResult {
  return {
    report: importReport(fileName, 0, NO_LATTICE_REASON),
    partIds: [],
    instanceCount: 0,
    partIndex: new Uint32Array(),
    ldrawColor: new Uint32Array(),
    matrices: new Float32Array(),
    partTransforms: new Float64Array(),
    submodels: {
      count: 0,
      parent: new Int32Array(),
      matrices: new Float64Array(),
      ofPart: new Int32Array(),
    },
    compiled: [],
    connectors: [],
    bake: null,
  };
}

class RefusingModelImporter implements IModelImporter {
  async importText(fileName: string): Promise<ImportResult> {
    return refusedBake(fileName);
  }

  async importStudio(fileName: string): Promise<ImportResult> {
    return refusedBake(fileName);
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return {};
  }
}

it("resolves a model file the bake refuses as not imported and keeps the chosen item, so a drop places nothing", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, []));
  container.rebind(SCENE_BACKEND).toConstantValue(new HeadlessBackend());
  container.rebind(WORLD_REPOSITORY).toConstantValue(new MemoryRepository());
  container.rebind(MODEL_IMPORTER).toConstantValue(new RefusingModelImporter());
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  await chosen(editor, BASEPLATE);

  const imported = await editor.importModelFile({
    name: "no-studs.ldr",
    bytes: new TextEncoder().encode("0 A model with no studs\n"),
  });

  const { activeItem, modelImport, catalog } = editor.snapshot();
  expect({
    imported,
    activeItem,
    status: modelImport?.status,
    reason: modelImport?.reason,
    listed: catalog.some((item) => item.id.startsWith("import:")),
  }).toEqual({
    imported: false,
    activeItem: BASEPLATE,
    status: "refused",
    reason: NO_LATTICE_REASON,
    listed: false,
  });
}, 120_000);

function importedRecord(fileName: string, record: ModelRecord): ImportResult {
  const { model, parts } = record;
  const refused = refusedBake(fileName);
  const partIds = parts.map((part) => part.id);
  return {
    ...refused,
    report: { ...refused.report, sections: model.sections, bakeIssue: null },
    partIds,
    instanceCount: model.instanceCount,
    partIndex: Uint32Array.from(model.partIndex),
    ldrawColor: model.ldrawColor,
    matrices: model.matrices,
    partTransforms: model.partTransforms,
    submodels: model.submodels,
    connectors: partIds.map(() => null),
    bake: {
      lattice: model.lattice,
      latticeIssue: null,
      studCover: model.studCover,
      cells: model.cells,
      vehicles: model.vehicles,
      vehicleIssue: null,
    },
  };
}

class GatedModelImporter implements IModelImporter {
  private result: ImportResult | null = null;
  private open: () => void = () => undefined;
  private readonly opened = new Promise<void>((resolve) => {
    this.open = resolve;
  });

  serve(result: ImportResult): void {
    this.result = result;
  }

  release(): void {
    this.open();
  }

  async importText(
    _fileName: string,
    _text: string,
    _lod?: BundleLod,
    onPlaced?: PlacementListener,
  ): Promise<ImportResult> {
    const { result } = this;
    if (!result?.bake) throw new Error("the gated importer was given no baked result");
    const { bake, report, studio: _studio, ...shape } = result;
    const { studCover: _studCover, ...placement } = bake;
    onPlaced?.({
      ...shape,
      sections: report.sections,
      refusedConnectorRecords: report.refusedConnectorRecords,
      bake: placement,
    });
    await this.opened;
    return result;
  }

  importStudio(
    fileName: string,
    _bytes: Uint8Array,
    lod?: BundleLod,
    onPlaced?: PlacementListener,
  ): Promise<ImportResult> {
    return this.importText(fileName, "", lod, onPlaced);
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return {};
  }
}

it("places an import while its studs are checked, offers none of them to the stats or Play meanwhile, and gives every placed copy exactly the checked studs when they land", async () => {
  const importer = new GatedModelImporter();
  const { editor, backend, container } = await startEditor(
    [],
    new BundleDirectoryFetcher(),
    [],
    importer,
  );
  const record = await container.get(PART_BUNDLE_LOADER).loadModelRecord("standard", PLACEABLE_SET);
  const { covered } = record.model.studCover;
  importer.serve(importedRecord("checking.mpd", record));
  const imported = await editor.importModelFile({
    name: "checking.mpd",
    bytes: new TextEncoder().encode("0 checked while placed\n"),
  });
  const item = editor.snapshot().modelImport?.item ?? "";
  const place = placer(editor, backend);
  const copies = [await place(item, 0, 0), await place(item, 2_000, 0)];
  const coverOf = () => editor.dump().covers.find((cover) => cover.id === item);
  const readiness = () => {
    const { modelImport, studChecks, studs, placements } = editor.snapshot();
    const cover = coverOf();
    return {
      status: modelImport?.status,
      reported: modelImport?.report !== null,
      studChecks,
      placements,
      culledInsideModels: studs?.culledInsideModels,
      pending: cover?.studsPending,
      culledAtBake: cover?.studsCulledAtBake,
      play: editor.playSetup() === null ? "waits" : "runs",
    };
  };
  const pending = readiness();
  const drawnPending = editor.snapshot().studs?.drawn ?? 0;
  const posesPending = posesOf(editor);

  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));

  expect(covered).toBeGreaterThan(0);
  expect({ imported, copies: copies.map((copy) => copy.refusedClicks) }).toEqual({
    imported: true,
    copies: [0, 0],
  });
  expect(pending).toEqual({
    status: "checking",
    reported: false,
    studChecks: 1,
    placements: 2,
    culledInsideModels: null,
    pending: true,
    culledAtBake: null,
    play: "waits",
  });
  expect(readiness()).toEqual({
    status: "placeable",
    reported: true,
    studChecks: 0,
    placements: 2,
    culledInsideModels: 2 * covered,
    pending: false,
    culledAtBake: covered,
    play: "runs",
  });
  expect(drawnPending - (editor.snapshot().studs?.drawn ?? 0)).toBe(2 * covered);
  expect(posesOf(editor)).toEqual(posesPending);
}, 120_000);

async function checkingImport(fetcher: IAssetFetcher = new BundleDirectoryFetcher()) {
  const importer = new GatedModelImporter();
  const started = await startEditor([], fetcher, [], importer);
  const { container, editor } = started;
  const record = await container.get(PART_BUNDLE_LOADER).loadModelRecord("standard", PLACEABLE_SET);
  importer.serve(importedRecord("checking.mpd", record));
  const catalog = container.get(PLACEABLE_CATALOG);
  const importedPlaceable = () => {
    const item = editor.snapshot().modelImport?.item ?? null;
    const refId = item === null ? null : catalog.itemRefId(item);
    return refId === null ? null : (catalog.placeables()[refId] ?? null);
  };
  return { ...started, importer, importedPlaceable, tables: container.get(CONNECTOR_TABLES) };
}

async function importChecking(editor: IEditor): Promise<string> {
  await editor.importModelFile({
    name: "checking.mpd",
    bytes: new TextEncoder().encode("0 checked while placed\n"),
  });
  return editor.snapshot().modelImport?.item ?? "";
}

it("has an import's connector tables before it is announced placeable, and keeps the same tables, never unloaded, through the studs-landed swap", async () => {
  const { editor, importer, importedPlaceable, tables } = await checkingImport();
  const seen: Array<boolean> = [];
  editor.subscribe(() => {
    const placeable = importedPlaceable();
    if (placeable) seen.push(tables.loaded(placeable) !== null);
  });

  await importChecking(editor);
  const pending = importedPlaceable();
  const announced = pending === null ? null : tables.loaded(pending);
  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  const checked = importedPlaceable();

  expect({
    status: editor.snapshot().modelImport?.status,
    swapped: checked !== null && checked !== pending && checked.id === pending?.id,
    announced: announced !== null,
    sameTables: checked !== null && tables.loaded(checked) === announced,
    everUnloaded: seen.includes(false),
  }).toEqual({
    status: "placeable",
    swapped: true,
    announced: true,
    sameTables: true,
    everUnloaded: false,
  });
}, 120_000);

it("resolves clicks queued while the held item's tables load, over an import whose studs are being checked, exactly as clicks made once they have loaded, refusal included", async () => {
  const outcome = async (queued: boolean) => {
    const roadPlateGate = new HeldText(new BundleDirectoryFetcher(), (path) =>
      path.includes("/connectivity-44336p01."),
    );
    const baseplateGate = new HeldText(roadPlateGate, (path) =>
      path.includes("/connectivity-3811."),
    );
    const { editor, backend } = await checkingImport(baseplateGate);
    const item = await importChecking(editor);
    await placer(editor, backend)(item, 0, 0);
    const clicks: Array<[string, HeldText]> = [
      [BASEPLATE, baseplateGate],
      [ROAD_PLATE, roadPlateGate],
    ];
    for (const [held, gate] of clicks) {
      if (queued) {
        placerNow(editor, backend)(held, 0, 0);
        gate.open();
        await settledChoice(editor);
      } else {
        gate.open();
        await placer(editor, backend)(held, 0, 0);
      }
    }
    const { placements, refusedClicks, lastRefusal, studChecks, queuedPlacement } =
      editor.snapshot();
    return {
      placements,
      refusedClicks,
      reason: lastRefusal?.reason ?? null,
      studChecks,
      queuedPlacement,
      poses: posesOf(editor),
    };
  };

  const [queued, direct] = [await outcome(true), await outcome(false)];

  expect(queued).toEqual(direct);
  expect(queued).toMatchObject({
    placements: 2,
    refusedClicks: 1,
    studChecks: 1,
    queuedPlacement: null,
  });
  expect(queued.poses).toContain(`${BASEPLATE} 0,0 y32`);
}, 120_000);

it("keeps a click queued while the held item's tables load through another import's studs landing, then places it", async () => {
  const gate = heldConnectivity();
  const { editor, backend, importer } = await checkingImport(gate);
  const item = await importChecking(editor);
  await placer(editor, backend)(item, 0, 0);

  placerNow(editor, backend)(BASEPLATE, 2_560, 0);
  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  const afterLanding = editor.snapshot().queuedPlacement;
  gate.open();
  await settledChoice(editor);

  expect({ afterLanding, placed: posesOf(editor) }).toEqual({
    afterLanding: { item: BASEPLATE, x: 2_560, z: 0, rot: 0 },
    placed: expect.arrayContaining([`${BASEPLATE} 2560,0 y0`]),
  });
  expect(editor.snapshot().placements).toBe(2);
}, 120_000);

class BakedRecordImporter implements IModelImporter {
  constructor(private readonly record: ModelRecord) {}

  private imported(fileName: string): ImportResult {
    const { model, parts } = this.record;
    return {
      report: importReport(fileName, model.instanceCount, null),
      partIds: parts.map((part) => part.id),
      instanceCount: model.instanceCount,
      partIndex: Uint32Array.from(model.partIndex),
      ldrawColor: model.ldrawColor,
      matrices: model.matrices,
      partTransforms: model.partTransforms,
      submodels: model.submodels,
      compiled: [],
      connectors: [],
      bake: {
        lattice: model.lattice,
        latticeIssue: null,
        studCover: model.studCover,
        cells: model.cells,
        vehicles: model.vehicles,
        vehicleIssue: null,
      },
    };
  }

  async importText(fileName: string): Promise<ImportResult> {
    return this.imported(fileName);
  }

  async importStudio(fileName: string): Promise<ImportResult> {
    return this.imported(fileName);
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return {};
  }
}

it("draws nothing in place of a part whose mesh fails to load and names it, and counts a part an import brings with its mesh as loaded", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const baseplatePart = BASEPLATE.split("@")[0] ?? "";
  const baseplateMesh = (await partMeshPaths("standard")).get(baseplatePart);
  const userModel = "brick-2x4";
  const record = await fixtureBundleLoader().loadModelRecord("standard", userModel);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container
    .rebind(ASSET_FETCHER)
    .toConstantValue(
      new InFlightFetcher(new BundleDirectoryFetcher(), (path) => path === baseplateMesh),
    );
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, []));
  const backend = new HeadlessBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(WORLD_REPOSITORY).toConstantValue(new MemoryRepository());
  container.rebind(MODEL_IMPORTER).toConstantValue(new BakedRecordImporter(record));
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  const imported = await editor.importModelFile({
    name: `${userModel}.ldr`,
    bytes: new TextEncoder().encode(`0 ${userModel}\n`),
  });
  const brick = editor.snapshot().modelImport?.item;
  if (!imported || !brick) throw new Error(`${userModel} was not imported`);
  const place = placer(editor, backend);

  expect((await place(BASEPLATE, 0, 0)).placements).toBe(1);
  expect((await place(brick, 1600, 1600)).placements).toBe(2);
  await vi.waitFor(() => expect(meshesSettled(editor.snapshot().meshes)).toBe(true));

  const { detailedPartMeshes, undrawnParts } = editor.snapshot().meshes;
  expect({
    detailedPartMeshes,
    undrawnParts,
    baseplateTriangles: backend.trianglesOf(baseplatePart),
    brickDrawn: record.parts.map((part) => backend.trianglesOf(part.id) > 0),
  }).toEqual({
    detailedPartMeshes: {
      wanted: 1 + record.parts.length,
      loaded: record.parts.length,
      failed: 1,
      absent: 0,
    },
    undrawnParts: [{ part: baseplatePart, reason: "failed" }],
    baseplateTriangles: 0,
    brickDrawn: record.parts.map(() => true),
  });
}, 120_000);

it("shows only the world that is open: no studs or far models after New World, the placed ones again on reopening", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container
    .rebind(PART_BUNDLE_LOADER)
    .toConstantValue(new ModelSubsetLoader(realLoader, [PLACEABLE_SET]));
  const backend = new HeadlessBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const repository = new MemoryRepository();
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  expect((await farTierSettled(editor)).farTier).toBe("ready");
  const set = `omr:${PLACEABLE_SET}`;
  await loadCatalogItem(container.get(PLACEABLE_CATALOG), set);
  const shown = () => ({
    studs: editor.snapshot().studs,
    farModels: [...backend.farModels.values()],
  });

  const place = placer(editor, backend);
  await place(BASEPLATE, 0, 0);
  await place(set, 1280, 0);
  await vi.waitFor(() => expect(backend.farModels.size).toBe(1));
  const placed = shown();
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(2));
  const first = editor.snapshot().world?.id;
  if (!first) throw new Error("no current world");
  expect(await editor.newWorld("Second")).toBe(true);
  const fresh = shown();
  expect(await editor.openWorld(first)).toBe(true);

  expect(placed.studs?.drawn).toBeGreaterThan(0);
  expect({ fresh, reopened: shown() }).toEqual({
    fresh: { studs: { drawn: 0, culledInsideModels: 0, culledUnderFootprints: 0 }, farModels: [] },
    reopened: placed,
  });
}, 120_000);

const SET = `omr:${PLACEABLE_SET}`;
const PLAIN_MODULE = "generated:mils-plain";
const OVERLAP = "would overlap";

function posesOf(editor: IEditor) {
  const { refs, placements } = editor.dump();
  return placements.refId
    .map((ref, i) => `${refs[ref]} ${placements.x[i]},${placements.z[i]} y${placements.yPlates[i]}`)
    .toSorted();
}

const OVERLAP_REFUSED = {
  outcome: {
    placements: 1,
    refusedClicks: 1,
    reason: expect.stringContaining(`${OVERLAP} 3811 Baseplate 32 x 32`),
  },
  ghostRefusal: expect.stringContaining(OVERLAP),
};
const PLACED_BESIDE = {
  outcome: { placements: 2, refusedClicks: 0, reason: null },
  ghostRefusal: null,
};

it.each([
  {
    name: "a second 3811 five studs over the first",
    held: BASEPLATE,
    at: [100, 0],
    expected: OVERLAP_REFUSED,
  },
  {
    name: "a road plate across a 3811",
    held: "ldraw:44336p04@72",
    at: [320, 0],
    expected: OVERLAP_REFUSED,
  },
  {
    name: "a MILS module over a 3811",
    held: PLAIN_MODULE,
    at: [320, 320],
    expected: OVERLAP_REFUSED,
  },
  { name: "a 3811 flush beside the first", held: BASEPLATE, at: [640, 0], expected: PLACED_BESIDE },
  { name: "a set on the 3811", held: SET, at: [0, 0], expected: PLACED_BESIDE },
] as const)(
  "with a 3811 placed, $name is refused only where two baseplates would share space",
  async ({ held, at, expected }) => {
    const { editor, backend, catalog } = await startEditor(["mils-plain", PLACEABLE_SET]);
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await loadCatalogItem(catalog, SET);
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    await chosen(editor, held);
    backend.aim(at[0], at[1]);
    editor.pointerMove(0, 0);
    const ghostRefusal = editor.snapshot().hover?.refusal ?? null;
    const outcome = await place(held, at[0], at[1]);

    expect({ outcome, ghostRefusal }).toEqual(expected);
  },
  120_000,
);

it.each([
  {
    name: "a set built on its own baseplates, 10185-1",
    model: "10185-1",
    userModels: [],
    besideX: 640,
  },
  {
    name: "10190-1, its one-stud overhang and tilted hinge reaching over the 3811 from beside it,",
    model: "10190-1",
    userModels: [],
    besideX: -640,
  },
  {
    name: "a user's model of a 3811 beside a road baseplate",
    model: "baseplate-row",
    userModels: ["baseplate-row"],
    besideX: 640,
  },
] as const)(
  "$name lies in the baseplate layer: refused across a 3811 and taken flush beside it",
  async ({ model, userModels, besideX }) => {
    const { editor, backend, catalog } = await startEditor(
      [model],
      new BundleDirectoryFetcher(),
      userModels,
    );
    const held = `omr:${model}`;
    await loadCatalogItem(catalog, held);
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    const across = await place(held, 0, 0);
    const beside = await place(held, besideX, 0);

    expect({ across, placements: beside.placements, poses: posesOf(editor) }).toEqual({
      across: OVERLAP_REFUSED.outcome,
      placements: 2,
      poses: [`${BASEPLATE} 0,0 y0`, `${held} ${besideX},0 y0`],
    });
  },
  120_000,
);

it("measures in studs and cm: a user's model reads its size held and selected, a drag lays a ruler, a click lays none, and Delete or Escape drops a ruler mid-drag before lifting a laid one", async () => {
  const { editor, backend, catalog } = await startEditor(
    ["baseplate-row"],
    new BundleDirectoryFetcher(),
    ["baseplate-row"],
  );
  const held = "omr:baseplate-row";
  await loadCatalogItem(catalog, held);
  const labels = () => editor.snapshot().labels.map((label) => `${label.kind}: ${label.text}`);
  await placer(editor, backend)(held, 0, 0);
  const whileHeld = labels();
  const ghost = editor.snapshot().labels.find((label) => label.kind === "ghost");
  editor.chooseItem(null);
  backend.aim(ghost?.x ?? Number.NaN, ghost?.z ?? Number.NaN);
  editor.click(0, 0, 0);
  const whileSelected = labels();
  editor.setMeasuring(true);
  const ruler = (from: readonly [number, number], to: readonly [number, number]): void => {
    backend.aim(...from);
    editor.dragStart(0, 0);
    backend.aim(...to);
    editor.dragMove(0, 0);
    editor.dragEnd(0, 0, 0);
  };
  const startDraft = (to: readonly [number, number]): void => {
    backend.aim(0, 0);
    editor.dragStart(0, 0);
    backend.aim(...to);
    editor.dragMove(0, 0);
  };
  startDraft([200, 0]);
  const firstDraftDeletable = commandEnabled("delete", editor.snapshot());
  editor.deleteSelection(0);
  const firstDraftDeleted = labels();
  ruler([0, 0], [60, 80]);
  ruler([100, 100], [100, 100]);
  ruler([-320, -200], [320, -200]);
  const measured = labels();
  startDraft([200, 0]);
  const drafting = labels();
  editor.deleteSelection(0);
  const deletedMidDrag = labels();
  editor.deleteSelection(0);
  const afterDelete = { rulers: editor.snapshot().rulers, labels: labels() };
  startDraft([0, 200]);
  editor.chooseItem(null);
  const escapedMidDrag = { mode: editor.snapshot().mode, labels: labels() };
  editor.chooseItem(held);

  expect({
    whileHeld,
    whileSelected,
    firstDraftDeletable,
    firstDraftDeleted,
    measured,
    drafting,
    deletedMidDrag,
    afterDelete,
    escapedMidDrag,
    after: { mode: editor.snapshot().mode, rulers: editor.snapshot().rulers },
  }).toEqual({
    whileHeld: ["ghost: 32 × 64 studs · 25.6 × 51.2 cm"],
    whileSelected: ["selection: 32 × 64 studs · 25.6 × 51.2 cm"],
    firstDraftDeletable: true,
    firstDraftDeleted: [],
    measured: ["ruler: 5 studs · 4 cm (3 × 4)", "ruler: 32 studs · 25.6 cm"],
    drafting: [
      "ruler: 5 studs · 4 cm (3 × 4)",
      "ruler: 32 studs · 25.6 cm",
      "draft: 10 studs · 8 cm",
    ],
    deletedMidDrag: ["ruler: 5 studs · 4 cm (3 × 4)", "ruler: 32 studs · 25.6 cm"],
    afterDelete: { rulers: 1, labels: ["ruler: 5 studs · 4 cm (3 × 4)"] },
    escapedMidDrag: { mode: "select", labels: ["ruler: 5 studs · 4 cm (3 × 4)"] },
    after: { mode: "place", rulers: 1 },
  });
}, 120_000);

it("clears the rulers when another world opens", async () => {
  const { editor, backend } = await startStreamingEditor({ models: [], tier: null });
  editor.setMeasuring(true);
  backend.aim(0, 0);
  editor.dragStart(0, 0);
  backend.aim(640, 0);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
  const laid = editor.snapshot().rulers;
  expect(await editor.newWorld("Second")).toBe(true);

  expect({ laid, rulers: editor.snapshot().rulers, labels: editor.snapshot().labels }).toEqual({
    laid: 1,
    rulers: 0,
    labels: [],
  });
}, 120_000);

it("draws and resizes a table on the 8-stud grid, checks a user's model against it, and undo and redo walk table, plan-field and placement edits in one order", async () => {
  const userModel = "brick-2x4";
  const { editor, backend, catalog, container } = await startEditor(
    [],
    new BundleDirectoryFetcher(),
    [userModel],
  );
  const plans = container.get(PLAN_SERVICE);
  const brick = `omr:${userModel}`;
  await loadCatalogItem(catalog, brick);
  const place = placer(editor, backend);
  const drag = (from: readonly [number, number], to: readonly [number, number]): void => {
    backend.aim(...from);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    backend.aim(...to);
    editor.dragMove(0, 0);
    editor.dragEnd(0, 0, 0);
  };
  const state = () => {
    const planId = plans.activePlanId();
    const view = planId === null ? null : plans.regionView(planId);
    return {
      placements: editor.snapshot().placements,
      tables: (view?.tables ?? []).map(({ surface, heightMm }) => ({ ...surface, heightMm })),
      issues: planId === null ? [] : plans.issues(planId).map((issue) => issue.rule),
    };
  };

  await place(brick, 1600, 1600);
  editor.setTableTool(true);
  drag([1290, 1300], [2250, 2090]);
  const drawn = {
    ...state(),
    labels: editor.snapshot().labels.map((label) => `${label.kind}: ${label.text}`),
  };
  drag([1285, 1700], [1700, 1700]);
  const resized = state();
  const planId = plans.activePlanId() ?? "";
  plans.updateTable(planId, plans.regionView(planId).tables[0]?.id ?? "", { heightMm: 900 });
  await place(brick, 2000, 1600);
  editor.setTableTool(true);
  backend.aim(2100, 1500);
  editor.pointerMove(0, 0);
  editor.pointerLeave();
  const deletableOffCanvas = commandEnabled("delete", editor.snapshot());
  editor.pointerMove(0, 0);
  plans.activatePlan(null);
  const deletableInNoPlan = commandEnabled("delete", editor.snapshot());
  plans.activatePlan(planId);
  editor.pointerMove(0, 0);
  const deletable = commandEnabled("delete", editor.snapshot());
  editor.deleteSelection(0);
  const removed = state();
  const undone = [];
  for (let step = 0; step < 6; step++) {
    undone.push({ undo: editor.snapshot().history.undo, ...state() });
    editor.undo(0);
  }
  const start = { ...state(), plans: plans.plans().length };
  for (let step = 0; step < 6; step++) editor.redo(0);

  const table = { minX: 1280, minZ: 1280, maxX: 2240, maxZ: 2080, heightMm: 750 };
  const narrowed = { ...table, minX: 1760 };
  const raised = { ...narrowed, heightMm: 900 };
  expect({ drawn, resized, deletableOffCanvas, deletableInNoPlan, deletable, removed }).toEqual({
    drawn: {
      placements: 1,
      tables: [table],
      issues: [],
      labels: ["table: 48 studs · 38.4 cm", "table: 40 studs · 32 cm"],
    },
    resized: { placements: 1, tables: [narrowed], issues: ["fit"] },
    deletableOffCanvas: false,
    deletableInNoPlan: false,
    deletable: true,
    removed: { placements: 2, tables: [], issues: ["fit", "fit"] },
  });
  expect(undone).toEqual([
    { undo: "plan", placements: 2, tables: [], issues: ["fit", "fit"] },
    { undo: "place", placements: 2, tables: [raised], issues: ["fit"] },
    { undo: "plan", placements: 1, tables: [raised], issues: ["fit"] },
    { undo: "plan", placements: 1, tables: [narrowed], issues: ["fit"] },
    { undo: "plan", placements: 1, tables: [table], issues: [] },
    { undo: "place", placements: 1, tables: [], issues: [] },
  ]);
  expect(start).toEqual({ placements: 0, tables: [], issues: [], plans: 0 });
  expect({ ...state(), redo: editor.snapshot().history.redo }).toEqual({ ...removed, redo: null });
}, 120_000);

function placedHeights(backend: HeadlessBackend, partId: string) {
  const heights = new Set<number>();
  let instances = 0;
  for (const chunk of backend.chunks.values()) {
    for (let i = 0; i < chunk.count; i++) {
      if (backend.partIds[chunk.partIndex[i] ?? -1] !== partId) continue;
      instances++;
      heights.add(chunk.matrices[i * INSTANCE_MATRIX_FLOATS + 7] ?? Number.NaN);
    }
  }
  return { instances, heights: [...heights] };
}

it.each([
  {
    name: "a 3811 and a user's model of a 3811 beside a road baseplate: both lie on the table, top face at 0",
    part: "ldraw:3811",
    model: "baseplate-row",
    topFace: 0,
  },
  {
    name: "a 30225b road baseplate and a user's model of road baseplates: both lie on the table, top face at 0",
    part: "ldraw:30225b",
    model: "road-baseplates",
    topFace: 0,
  },
  {
    name: "a 69958 road plate and a user's model of road plates: studs a plate above the underside keep both on the plate lattice, top face at 16",
    part: "ldraw:69958",
    model: "road-plates",
    topFace: 16,
  },
] as const)(
  "$name",
  async ({ part, model, topFace }) => {
    const { editor, backend, catalog } = await startEditor([model], new BundleDirectoryFetcher(), [
      model,
    ]);
    const held = `omr:${model}`;
    await loadCatalogItem(catalog, held);
    const loose = editor.snapshot().catalog.find((item) => item.group === part)?.id;
    if (!loose) throw new Error(`${part} is not in the catalog`);
    const place = placer(editor, backend);
    await place(loose, -1280, 0);
    await place(held, 1280, 0);

    expect({ placements: editor.snapshot().placements, ...placedHeights(backend, part) }).toEqual({
      placements: 2,
      instances: 2,
      heights: [topFace],
    });
  },
  120_000,
);

it("refuses to turn a 16 x 32 baseplate into the 3811 beside it", async () => {
  const { editor, backend } = await startEditor([]);
  const place = placer(editor, backend);
  const narrow = "ldraw:3857@2";
  const item = editor.snapshot().catalog.find((entry) => entry.id === narrow);
  if (!item) throw new Error(`${narrow} is not in the catalog`);
  await chosen(editor, narrow);
  if (item.studsWide > item.studsDeep) editor.rotate(0);
  const halfWidth = (Math.min(item.studsWide, item.studsDeep) * 20) / 2;
  await place(BASEPLATE, 0, 0);
  const flush = await place(narrow, 320 + halfWidth, 0);
  expect(selectAt(editor, backend, 320 + halfWidth, 0)?.item).toBe(narrow);
  const before = posesOf(editor);
  editor.rotate(0);

  expect({ flush, poses: posesOf(editor), reason: editor.snapshot().lastRefusal?.reason }).toEqual({
    flush: { placements: 2, refusedClicks: 0, reason: null },
    poses: before,
    reason: expect.stringContaining(OVERLAP),
  });
}, 120_000);

it("refuses to delete a MILS module while a set rests on it, names the set, and deletes it once the set is gone", async () => {
  const { editor, backend, catalog } = await startEditor(["mils-plain", PLACEABLE_SET]);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await place(SET, 320, 320);
  const raised = posesOf(editor);
  expect(selectAt(editor, backend, 20, 20)?.item).toBe(PLAIN_MODULE);
  editor.deleteSelection(0);
  const refused = {
    poses: posesOf(editor),
    refusal: editor.snapshot().selectionRefusal,
    tone: toolHints(editor.snapshot()).tone,
  };
  expect(selectAt(editor, backend, 320, 320)?.item).toBe(SET);
  editor.deleteSelection(0);
  expect(selectAt(editor, backend, 20, 20)?.item).toBe(PLAIN_MODULE);
  editor.deleteSelection(0);

  expect(raised.some((pose) => pose.startsWith(SET) && !pose.endsWith(" y0"))).toBe(true);
  expect({ refused, left: editor.snapshot().placements }).toEqual({
    refused: {
      poses: raised,
      refusal: expect.stringContaining(`${PLACEABLE_SET} Level Crossing (2010) rests on it`),
      tone: "warn",
    },
    left: 0,
  });
}, 120_000);

it.each([
  {
    name: "a set straddling two MILS modules loses one of them",
    lay: [
      [PLAIN_MODULE, 320, 320],
      [PLAIN_MODULE, 960, 320],
      [SET, 640, 320],
    ],
    remove: [20, 20],
  },
  {
    name: "a 3811 under a set at the ground plane is deleted",
    lay: [
      [BASEPLATE, 0, 0],
      [SET, 0, 0],
    ],
    remove: [300, 300],
  },
] as const)(
  "deletes the support when $name, since the set keeps its resting height",
  async ({ lay, remove }) => {
    const { editor, backend, catalog } = await startEditor(["mils-plain", PLACEABLE_SET]);
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await loadCatalogItem(catalog, SET);
    const place = placer(editor, backend);
    for (const [item, x, z] of lay) await place(item, x, z);
    const setPose = () => posesOf(editor).find((pose) => pose.startsWith(SET));
    const before = setPose();
    selectAt(editor, backend, remove[0], remove[1]);
    editor.deleteSelection(0);

    expect({ placements: editor.snapshot().placements, set: setPose() }).toEqual({
      placements: lay.length - 1,
      set: before,
    });
  },
  120_000,
);

const STREAMED_SET = "10185-1";
const ROAD_PLATE = "ldraw:44336p01@2";

async function partMeshPaths(lod: BundleLod): Promise<ReadonlyMap<string, string>> {
  const files = new BundleDirectoryFetcher();
  const index: { partTable: { file: string } } = JSON.parse(
    await files.text(`${lod}/manifest.json`),
  );
  const table: { parts: ReadonlyArray<{ id: string; file: string }> } = JSON.parse(
    await files.text(`${lod}/${index.partTable.file}`),
  );
  return new Map(table.parts.map((part) => [part.id, `${lod}/${part.file}`]));
}

function isFarModelMesh(path: string): boolean {
  return path.startsWith("far/model-") && path.endsWith(".glb");
}

class PathGate implements IAssetFetcher {
  readonly started: string[] = [];
  readonly finishedAt = new Map<string, number>();
  private shut: (path: string) => boolean = () => false;
  private waiting: Array<{ readonly path: string; readonly go: () => void }> = [];

  constructor(
    private readonly files: IAssetFetcher,
    private readonly watched: ReadonlySet<string>,
  ) {}

  close(shut: (path: string) => boolean): void {
    this.shut = shut;
    const go = this.waiting.filter((fetch) => !shut(fetch.path));
    this.waiting = this.waiting.filter((fetch) => shut(fetch.path));
    for (const fetch of go) fetch.go();
  }

  open(): void {
    this.close(() => false);
  }

  releaseOldest(): boolean {
    const oldest = this.waiting.shift();
    oldest?.go();
    return oldest !== undefined;
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    if (this.watched.has(path)) this.started.push(path);
    if (this.shut(path)) await new Promise<void>((go) => this.waiting.push({ path, go }));
    const bytes = await this.files.bytes(path);
    if (this.watched.has(path)) this.finishedAt.set(path, performance.now());
    return bytes;
  }

  text(path: string): Promise<string> {
    return this.files.text(path);
  }
}

class StreamingBackend implements ISceneBackend, AimedBackend {
  private readonly partIds: string[] = [];
  private readonly holdCounts: Record<PaletteLevel, Map<number, number>> = {
    detailed: new Map(),
    far: new Map(),
  };
  private aimX = 0;
  private aimZ = 0;
  readonly published: Array<{ readonly at: number; readonly meshes: ReadonlySet<string> }> = [];

  constructor(private readonly three: ISceneBackend) {}

  heldMeshPaths(
    detailedPaths: ReadonlyMap<string, string>,
    farPaths: ReadonlyMap<string, string>,
  ): ReadonlyMap<string, string> {
    const held = new Map<string, string>();
    for (const [level, paths] of [
      ["detailed", detailedPaths],
      ["far", farPaths],
    ] as const) {
      for (const [index, count] of this.holdCounts[level]) {
        const path = paths.get(this.partIds[index] ?? "");
        if (count > 0 && path !== undefined) held.set(`${level} ${index}`, path);
      }
    }
    return held;
  }

  heldPaths(level: PaletteLevel, paths: ReadonlyMap<string, string>): ReadonlySet<string> {
    const held = new Set<string>();
    for (const [index, count] of this.holdCounts[level]) {
      const path = paths.get(this.partIds[index] ?? "");
      if (count > 0 && path !== undefined) held.add(path);
    }
    return held;
  }

  private count(level: PaletteLevel, indices: Uint32Array, step: number): void {
    const counts = this.holdCounts[level];
    for (const index of indices) counts.set(index, (counts.get(index) ?? 0) + step);
  }

  async init(): Promise<BackendInfo> {
    return {
      requestedApi: "webgl2",
      activeApi: "webgl2",
      adapter: "none",
      backgroundSrgb: 0,
      look: NO_LOOK,
    };
  }

  setPalette(palette: PartPalette): void {
    this.partIds.length = 0;
    this.partIds.push(...palette.detailed.parts.map((part) => part.id));
    this.three.setPalette(palette);
  }

  addParts(parts: ReadonlyArray<PartAsset>): void {
    this.partIds.push(...parts.map((part) => part.id));
    this.three.addParts(parts);
  }

  setNeededMeshListener(listener: NeededMeshListener | null): void {
    this.three.setNeededMeshListener(
      listener && {
        hold: (detailed, far) => {
          this.count("detailed", detailed, 1);
          this.count("far", far, 1);
          listener.hold(detailed, far);
        },
        release: (detailed, far) => {
          this.count("detailed", detailed, -1);
          this.count("far", far, -1);
          listener.release(detailed, far);
        },
      },
    );
  }

  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
  }

  rayThrough(_ndcX: number, _ndcY: number, out: Float64Array): void {
    out.set([this.aimX, RAY_HEIGHT_LDU, this.aimZ, 0, -1, 0]);
  }

  renderFrame(): void {}

  needsFrame(): boolean {
    return true;
  }

  async waitForGpu(): Promise<void> {}

  setPartMeshes(updates: ReadonlyArray<PartMeshUpdate>): void {
    this.published.push({
      at: performance.now(),
      meshes: new Set(updates.map(({ level, index }) => `${level} ${index}`)),
    });
    this.three.setPartMeshes(updates);
  }
  setFarStuds(...args: Parameters<ISceneBackend["setFarStuds"]>): void {
    this.three.setFarStuds(...args);
  }
  setFarModelMesh(...args: Parameters<ISceneBackend["setFarModelMesh"]>): void {
    this.three.setFarModelMesh(...args);
  }
  setColors(...args: Parameters<ISceneBackend["setColors"]>): void {
    this.three.setColors(...args);
  }
  setChunk(...args: Parameters<ISceneBackend["setChunk"]>): void {
    this.three.setChunk(...args);
  }
  deleteChunk(...args: Parameters<ISceneBackend["deleteChunk"]>): void {
    this.three.deleteChunk(...args);
  }
  setGhost(...args: Parameters<ISceneBackend["setGhost"]>): void {
    this.three.setGhost(...args);
  }
  placeGhost(...args: Parameters<ISceneBackend["placeGhost"]>): void {
    this.three.placeGhost(...args);
  }
  setSelectionBox(...args: Parameters<ISceneBackend["setSelectionBox"]>): void {
    this.three.setSelectionBox(...args);
  }
  setMarkers(...args: Parameters<ISceneBackend["setMarkers"]>): void {
    this.three.setMarkers(...args);
  }
  setTrackEnds(...args: Parameters<ISceneBackend["setTrackEnds"]>): void {
    this.three.setTrackEnds(...args);
  }
  setGround(...args: Parameters<ISceneBackend["setGround"]>): void {
    this.three.setGround(...args);
  }
  setPlanOverlays(...args: Parameters<ISceneBackend["setPlanOverlays"]>): void {
    this.three.setPlanOverlays(...args);
  }
  setIssueBoxes(...args: Parameters<ISceneBackend["setIssueBoxes"]>): void {
    this.three.setIssueBoxes(...args);
  }
  setGuides(...args: Parameters<ISceneBackend["setGuides"]>): void {
    this.three.setGuides(...args);
  }
  projectToNdc(...args: Parameters<ISceneBackend["projectToNdc"]>): void {
    this.three.projectToNdc(...args);
  }
  setVehicle(...args: Parameters<ISceneBackend["setVehicle"]>): void {
    this.three.setVehicle(...args);
  }
  setVehiclePose(...args: Parameters<ISceneBackend["setVehiclePose"]>): void {
    this.three.setVehiclePose(...args);
  }
  deleteVehicle(...args: Parameters<ISceneBackend["deleteVehicle"]>): void {
    this.three.deleteVehicle(...args);
  }
  setView(...args: Parameters<ISceneBackend["setView"]>): void {
    this.three.setView(...args);
  }
  resize(...args: Parameters<ISceneBackend["resize"]>): void {
    this.three.resize(...args);
  }
  bufferMemory(): BufferMemory {
    return this.three.bufferMemory();
  }
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return this.three.rebaseLog();
  }
  forceTier(...args: Parameters<ISceneBackend["forceTier"]>): void {
    this.three.forceTier(...args);
  }
  setFarModel(...args: Parameters<ISceneBackend["setFarModel"]>): void {
    this.three.setFarModel(...args);
  }
}

class FarIndexGapLoader extends ModelSubsetLoader {
  constructor(
    loader: IPartBundleLoader,
    models: ReadonlyArray<string>,
    private readonly missingPart: string,
    private readonly missingModel: string,
  ) {
    super(loader, models);
  }

  override async loadPartFiles(lod: BundleLod): Promise<ReadonlyMap<string, string>> {
    const files = await super.loadPartFiles(lod);
    if (lod !== "far") return files;
    return new Map([...files].filter(([id]) => id !== this.missingPart));
  }

  override loadFarModelMesh(name: string, priority: FetchPriority): Promise<PartMesh | null> {
    if (name === this.missingModel) return Promise.resolve(null);
    return super.loadFarModelMesh(name, priority);
  }
}

class PriorityRecordingLoader extends ModelSubsetLoader {
  readonly firstPriority = new Map<string, FetchPriority>();

  override loadPartMesh(lod: BundleLod, file: string, priority: FetchPriority): Promise<PartMesh> {
    const path = `${lod}/${file}`;
    if (!this.firstPriority.has(path)) this.firstPriority.set(path, priority);
    return super.loadPartMesh(lod, file, priority);
  }
}

class Gate {
  private release = (): void => undefined;
  readonly opened = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  open(): void {
    this.release();
  }
}

class HeldFarLoader extends ModelSubsetLoader {
  readonly farFiles = new Gate();
  readonly farModelMesh = new Gate();

  override async loadPartFiles(lod: BundleLod): Promise<ReadonlyMap<string, string>> {
    if (lod === "far") await this.farFiles.opened;
    return super.loadPartFiles(lod);
  }

  override async loadFarModelMesh(name: string, priority: FetchPriority): Promise<PartMesh | null> {
    await this.farModelMesh.opened;
    return super.loadFarModelMesh(name, priority);
  }
}

class FarModelRecordingBackend extends HeadlessBackend {
  farModelMeshLoads = 0;
  readonly farModelUses: number[] = [];

  override setFarModelMesh(): void {
    this.farModelMeshLoads += 1;
  }

  override setFarModel(id: number, placement: FarModelPlacement | null): void {
    if (placement !== null) this.farModelUses.push(id);
  }
}

interface StreamingEditorOptions {
  readonly models: ReadonlyArray<string>;
  readonly tier: ChunkTier | null;
  readonly fetcher?: IAssetFetcher;
  readonly repository?: IWorldRepository;
  readonly loader?: (real: IPartBundleLoader) => IPartBundleLoader;
}

async function startStreamingEditor({
  models,
  tier,
  fetcher = new BundleDirectoryFetcher(),
  repository = new MemoryRepository(),
  loader = (real) => new ModelSubsetLoader(real, models),
}: StreamingEditorOptions) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(loader(realLoader));
  const three = container.get(SCENE_BACKEND);
  const backend = new StreamingBackend(three);
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier });
  expect(editor.snapshot().status).toBe("ready");
  return { editor, backend, catalog: container.get(PLACEABLE_CATALOG) };
}

async function streamingEditor(options: StreamingEditorOptions) {
  const started = await startStreamingEditor(options);
  expect((await farTierSettled(started.editor)).farTier).toBe("ready");
  return started;
}

async function storedWorld(models: ReadonlyArray<string>, item: string) {
  const repository = new MemoryRepository();
  const { editor, backend, catalog } = await streamingEditor({ models, tier: null, repository });
  const empty = editor.snapshot().world?.id;
  expect(await editor.newWorld("Built")).toBe(true);
  const built = editor.snapshot().world?.id;
  if (!empty || !built) throw new Error("the fixture editor has no world");
  await loadCatalogItem(catalog, item);
  expect((await placer(editor, backend)(item, 640, 640)).placements).toBe(1);
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(1), STREAM_WAIT);
  return { repository, empty, built };
}

const STREAM_WAIT = { timeout: 60_000 };
const RELEASE_PAUSE_MS = 5;
const MIN_HELD_STALL_MS = 1_000;

function meshesOf(editor: IEditor) {
  return editor.snapshot().meshes;
}

async function expectHeldFarFirst(
  editor: IEditor,
  backend: StreamingBackend,
  gate: PathGate,
  detailedPaths: ReadonlyMap<string, string>,
  farPaths: ReadonlyMap<string, string>,
) {
  const startedBefore = gate.started.length;
  const heldFar = backend.heldPaths("far", farPaths);
  const heldDetailed = backend.heldPaths("detailed", detailedPaths);
  gate.open();
  await vi.waitFor(() => expect(meshesSettled(meshesOf(editor))).toBe(true), STREAM_WAIT);

  const order = gate.started
    .slice(startedBefore)
    .flatMap((path) =>
      heldFar.has(path)
        ? ["held far"]
        : path.startsWith("standard/") && !heldDetailed.has(path)
          ? ["unheld detailed"]
          : [],
    );
  const firstUnheldDetailed = order.indexOf("unheld detailed");
  expect({
    heldFarStarted: order.includes("held far"),
    unheldDetailedStarted: firstUnheldDetailed >= 0,
    heldFarAfterUnheldDetailed: order.slice(firstUnheldDetailed).includes("held far"),
  }).toEqual({
    heldFarStarted: true,
    unheldDetailedStarted: true,
    heldFarAfterUnheldDetailed: false,
  });
}

async function placeWithOneHeldMeshGated() {
  const detailedPaths = await partMeshPaths("standard");
  const farPaths = await partMeshPaths("far");
  const meshPaths = new Set([...detailedPaths.values(), ...farPaths.values()]);
  const gate = new PathGate(new BundleDirectoryFetcher(), meshPaths);
  const { editor, backend, catalog } = await streamingEditor({
    models: [STREAMED_SET],
    tier: "mid",
    fetcher: gate,
  });
  const set = `omr:${STREAMED_SET}`;
  await loadCatalogItem(catalog, set);
  gate.close((path) => meshPaths.has(path));
  expect((await placer(editor, backend)(set, 640, 640)).placements).toBe(1);
  editor.chooseItem(null);
  const heldMeshes = backend.heldMeshPaths(detailedPaths, farPaths);
  const [lastMesh, lastPath] = [...heldMeshes].at(-1) ?? ["", ""];
  gate.close((path) => path === lastPath);
  const otherPaths = [...heldMeshes.values()].filter((path) => path !== lastPath);
  await vi.waitFor(
    () => expect(otherPaths.filter((path) => !gate.finishedAt.has(path))).toEqual([]),
    STREAM_WAIT,
  );
  const lastLanding = Math.max(...otherPaths.map((path) => gate.finishedAt.get(path) ?? 0));
  return { backend, gate, heldMeshes, lastMesh, lastLanding };
}

async function waitForHeldMeshPublishes(
  backend: StreamingBackend,
  heldMeshes: ReadonlyMap<string, string>,
) {
  const isHeld = ({ meshes }: { readonly meshes: ReadonlySet<string> }) =>
    [...heldMeshes.keys()].some((mesh) => meshes.has(mesh));
  await vi.waitFor(() => expect(backend.published.some(isHeld)).toBe(true), STREAM_WAIT);
  return backend.published.filter(isHeld);
}

describe("part mesh streaming", () => {
  it("keeps mesh progress unsettled until far-level part meshes and far model meshes have arrived", async () => {
    const farParts = new Set((await partMeshPaths("far")).values());
    const gate = new PathGate(new BundleDirectoryFetcher(), new Set());
    gate.close((path) => farParts.has(path) || isFarModelMesh(path));
    const { editor, backend, catalog } = await streamingEditor({
      models: [PLACEABLE_SET],
      tier: "near",
      fetcher: gate,
    });
    await loadCatalogItem(catalog, SET);
    expect((await placer(editor, backend)(SET, 640, 640)).placements).toBe(1);

    await vi.waitFor(() => {
      const { detailedPartMeshes } = meshesOf(editor);
      expect(detailedPartMeshes.loaded).toBe(detailedPartMeshes.wanted);
    }, STREAM_WAIT);
    const detailedLoaded = meshesOf(editor);
    gate.close(isFarModelMesh);
    await vi.waitFor(() => {
      const { farPartMeshes } = meshesOf(editor);
      expect(farPartMeshes.loaded).toBe(farPartMeshes.wanted);
    }, STREAM_WAIT);
    const farPartsLoaded = meshesOf(editor);
    gate.open();
    await vi.waitFor(() => expect(meshesSettled(meshesOf(editor))).toBe(true), STREAM_WAIT);

    expect({
      detailedLoaded: meshesSettled(detailedLoaded),
      farPartsWanted: detailedLoaded.farPartMeshes.wanted,
      farPartsLoaded: meshesSettled(farPartsLoaded),
      farModels: meshesOf(editor).farModelMeshes,
    }).toEqual({
      detailedLoaded: false,
      farPartsWanted: detailedLoaded.detailedPartMeshes.wanted,
      farPartsLoaded: false,
      farModels: { wanted: 1, loaded: 1, failed: 0, absent: 0 },
    });
  }, 120_000);

  it("settles with a part missing from the far part table as absent, a failed far fetch as failed, and a model with no far mesh as absent", async () => {
    const roadPlateFar = (await partMeshPaths("far")).get(ROAD_PLATE.split("@")[0] ?? "");
    const models = [PLACEABLE_SET];
    const { editor, backend, catalog } = await streamingEditor({
      models,
      tier: "near",
      fetcher: new InFlightFetcher(new BundleDirectoryFetcher(), (path) => path === roadPlateFar),
      loader: (real) =>
        new FarIndexGapLoader(real, models, BASEPLATE.split("@")[0] ?? "", PLACEABLE_SET),
    });
    await loadCatalogItem(catalog, SET);
    const place = placer(editor, backend);
    expect((await place(BASEPLATE, 320, 320)).placements).toBe(1);
    expect((await place(ROAD_PLATE, 960, 320)).placements).toBe(2);
    expect((await place(SET, 320, 1600)).placements).toBe(3);

    await vi.waitFor(() => expect(meshesSettled(meshesOf(editor))).toBe(true), STREAM_WAIT);
    const { detailedPartMeshes, farPartMeshes, farModelMeshes } = meshesOf(editor);
    expect({
      detailed: detailedPartMeshes.loaded === detailedPartMeshes.wanted,
      farFailed: farPartMeshes.failed,
      farAbsent: farPartMeshes.absent,
      farModelMeshes,
    }).toEqual({
      detailed: true,
      farFailed: 1,
      farAbsent: 1,
      farModelMeshes: { wanted: 1, loaded: 0, failed: 0, absent: 1 },
    });
  }, 120_000);

  it.each([
    {
      holder: "a stored world opened at the near tier, then switched to mid",
      tier: "near" as const,
      setUp: async (editor: IEditor, _backend: AimedBackend, built: string) => {
        expect(await editor.openWorld(built)).toBe(true);
        editor.cycleTier();
        expect(editor.snapshot().tier).toBe("mid");
      },
    },
    {
      holder: "two ghosts shown and cleared at the mid tier, one of them placed",
      tier: "mid" as const,
      setUp: async (editor: IEditor, backend: AimedBackend) => {
        await chosen(editor, SET);
        backend.aim(640, 640);
        editor.pointerMove(0, 0);
        editor.chooseItem(null);
        expect((await placer(editor, backend)(`omr:${STREAMED_SET}`, 640, 640)).placements).toBe(1);
        editor.chooseItem(null);
      },
    },
  ])(
    "starts every far mesh the mid tier holds before any detailed mesh nothing holds, after $holder",
    async ({ tier, setUp }) => {
      const models = [PLACEABLE_SET, STREAMED_SET];
      const { repository, built } = await storedWorld(models, `omr:${STREAMED_SET}`);
      const detailedPaths = await partMeshPaths("standard");
      const farPaths = await partMeshPaths("far");
      const meshPaths = new Set([...detailedPaths.values(), ...farPaths.values()]);
      const gate = new PathGate(new BundleDirectoryFetcher(), meshPaths);
      const { editor, backend, catalog } = await streamingEditor({
        models,
        tier,
        fetcher: gate,
        repository,
      });
      const loaded = [
        await loadCatalogItem(catalog, SET),
        await loadCatalogItem(catalog, `omr:${STREAMED_SET}`),
      ];
      expect(loaded.map((placeable) => placeable.id)).toEqual([SET, `omr:${STREAMED_SET}`]);
      gate.close((path) => meshPaths.has(path));

      await setUp(editor, backend, built);
      await expectHeldFarFirst(editor, backend, gate, detailedPaths, farPaths);
    },
    240_000,
  );

  it("loads the far tier ahead of the detailed meshes of a world opened at startup, then starts every far mesh the mid tier holds before any detailed mesh nothing holds", async () => {
    const models = [PLACEABLE_SET, STREAMED_SET];
    const { repository, empty } = await storedWorld(models, `omr:${STREAMED_SET}`);
    await repository.remove(empty);
    const detailedPaths = await partMeshPaths("standard");
    const farPaths = await partMeshPaths("far");
    const meshPaths = new Set([...detailedPaths.values(), ...farPaths.values()]);
    const gate = new PathGate(new BundleDirectoryFetcher(), meshPaths);
    gate.close((path) => meshPaths.has(path));
    const { editor, backend } = await startStreamingEditor({
      models,
      tier: "mid",
      fetcher: gate,
      repository,
    });

    while (editor.snapshot().farTier === "loading" && gate.releaseOldest()) {
      await new Promise((resolve) => setTimeout(resolve, RELEASE_PAUSE_MS));
    }
    await vi.waitFor(() => expect(editor.snapshot().farTier).toBe("ready"), STREAM_WAIT);

    await expectHeldFarFirst(editor, backend, gate, detailedPaths, farPaths);
  }, 240_000);

  it("publishes every mesh the scene holds in one flush once the last of them lands", async () => {
    const { backend, gate, heldMeshes, lastMesh } = await placeWithOneHeldMeshGated();
    gate.open();
    const published = await waitForHeldMeshPublishes(backend, heldMeshes);

    expect({
      flushes: published.length,
      held: [...heldMeshes.keys()].filter((mesh) => published[0]?.meshes.has(mesh)).length,
      lastIncluded: published[0]?.meshes.has(lastMesh),
    }).toEqual({ flushes: 1, held: heldMeshes.size, lastIncluded: true });
  }, 240_000);

  it("publishes the meshes the scene holds once they stop landing, without the one still loading", async () => {
    const { backend, gate, heldMeshes, lastMesh, lastLanding } = await placeWithOneHeldMeshGated();
    const published = await waitForHeldMeshPublishes(backend, heldMeshes);

    expect({
      flushes: published.length,
      held: [...heldMeshes.keys()].filter((mesh) => published[0]?.meshes.has(mesh)).length,
      lastIncluded: published[0]?.meshes.has(lastMesh),
      waitedForAStall: (published[0]?.at ?? 0) - lastLanding >= MIN_HELD_STALL_MS,
    }).toEqual({
      flushes: 1,
      held: heldMeshes.size - 1,
      lastIncluded: false,
      waitedForAStall: true,
    });
    gate.open();
  }, 240_000);

  it("first asks for every far mesh the mid tier holds at high priority when a stored world opens before tiers turn on", async () => {
    const models = [PLACEABLE_SET, STREAMED_SET];
    const { repository, empty } = await storedWorld(models, `omr:${STREAMED_SET}`);
    await repository.remove(empty);
    const recorded: { loader?: PriorityRecordingLoader } = {};
    const { backend } = await streamingEditor({
      models,
      tier: "mid",
      repository,
      loader: (real) => (recorded.loader = new PriorityRecordingLoader(real, models)),
    });
    const heldFar = [...backend.heldPaths("far", await partMeshPaths("far"))];

    expect(heldFar.length).toBeGreaterThan(0);
    expect(heldFar.filter((path) => recorded.loader?.firstPriority.get(path) !== "high")).toEqual(
      [],
    );
  }, 240_000);
});

it("loads and applies a placed set's far model once, however often the set is placed, even while its far mesh is still loading", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loader = new HeldFarLoader(container.get(PART_BUNDLE_LOADER), [PLACEABLE_SET]);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(loader);
  const backend = new FarModelRecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  await loadCatalogItem(container.get(PLACEABLE_CATALOG), SET);
  const place = placer(editor, backend);
  const farModels = () => ({
    meshLoads: backend.farModelMeshLoads,
    uses: backend.farModelUses.length,
    placementsUsing: new Set(backend.farModelUses).size,
    counts: editor.snapshot().meshes.farModelMeshes,
  });

  expect((await place(SET, 0, 0)).placements).toBe(1);
  loader.farFiles.open();
  expect((await farTierSettled(editor)).farTier).toBe("ready");
  expect((await place(SET, 2560, 0)).placements).toBe(2);
  loader.farModelMesh.open();
  await vi.waitFor(() => expect(backend.farModelUses).toHaveLength(2));
  const settled = farModels();
  expect((await place(SET, 5120, 0)).placements).toBe(3);

  expect({ settled, placedAgain: farModels() }).toEqual({
    settled: {
      meshLoads: 1,
      uses: 2,
      placementsUsing: 2,
      counts: { wanted: 1, loaded: 1, failed: 0, absent: 0 },
    },
    placedAgain: {
      meshLoads: 1,
      uses: 3,
      placementsUsing: 3,
      counts: { wanted: 1, loaded: 1, failed: 0, absent: 0 },
    },
  });
}, 120_000);

describe("frame loop in the editor's snapshot", () => {
  it("the snapshot carries the frame loop's tier and first-frame time", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { editor, frame } = await startEditor([]);
    const beforeFirstFrame = editor.snapshot().coldStartMs;

    await frame();
    const firstFramePresentedMs = performance.now();
    editor.cycleTier();

    const { coldStartMs, tier } = editor.snapshot();
    expect({ beforeFirstFrame, coldStartMs, tier }).toEqual({
      beforeFirstFrame: null,
      coldStartMs: firstFramePresentedMs,
      tier: "near",
    });
  }, 120_000);

  it("an edit's latency sample takes its times from the frame that presented it", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { editor, backend, frame } = await startEditor([]);
    await frame();
    const queuedMs = 4;
    await chosen(editor, BASEPLATE);
    backend.aim(0, 0);
    editor.pointerMove(0, 0);

    editor.click(0, 0, performance.now());
    vi.advanceTimersByTime(queuedMs);
    await frame();

    expect(editor.snapshot().lastLatency).toMatchObject({
      step: "do",
      action: "place",
      item: BASEPLATE,
      x: 0,
      z: 0,
      ms: queuedMs,
      rebuildMs: 0,
      queueMs: queuedMs,
      submitMs: 0,
      gpuWaitMs: 0,
    });
  }, 120_000);
});

it("undoes, redoes and erases a road stroke laid from a 3811 that straddles a chunk edge, so its tiles share column chunks", async () => {
  const { editor, backend } = await startEditor([]);
  await placer(editor, backend)(BASEPLATE, 0, 320);
  const kit = editor.snapshot().roadKits.find((k) => k.label.startsWith("Dark Bluish Grey"));
  if (!kit) throw new Error("no Dark Bluish Grey road kit");
  const stroke = () => {
    backend.aim(0, 320);
    editor.dragStart(0, 0);
    for (const x of [640, 1280]) {
      backend.aim(x, 320);
      editor.dragMove(0, 0);
    }
    editor.dragEnd(0, 0, 0);
  };
  const xs = () => Array.from(editor.dump().placements.x).toSorted((a, b) => a - b);
  editor.chooseItem(kit.id);
  stroke();
  const laid = xs();
  editor.undo(0);
  const undone = xs();
  editor.redo(0);
  const redone = xs();
  editor.setRoadErase(true);
  stroke();
  const erased = xs();
  expect({ laid, undone, redone, erased }).toEqual({
    laid: [0, 640, 1280],
    undone: [0],
    redone: [0, 640, 1280],
    erased: [0],
  });
}, 120_000);

class WithoutConnectorRecordsFor implements IAssetFetcher {
  constructor(
    private readonly files: IAssetFetcher,
    private readonly partId: string,
  ) {}

  bytes(path: string): Promise<ArrayBuffer> {
    return this.files.bytes(path);
  }

  async text(path: string): Promise<string> {
    const text = await this.files.text(path);
    if (!/\/(connectivity|connector)-index\.[0-9a-f]+\.json$/u.test(path)) return text;
    const index = JSON.parse(text) as { parts: Record<string, unknown> };
    const { [this.partId]: _withdrawn, ...parts } = index.parts;
    return JSON.stringify({ ...index, parts });
  }
}

class HeldText implements IAssetFetcher {
  private release: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  held = 0;

  constructor(
    private readonly files: IAssetFetcher,
    private readonly holds: (path: string) => boolean,
  ) {}

  bytes(path: string): Promise<ArrayBuffer> {
    return this.files.bytes(path);
  }

  async text(path: string): Promise<string> {
    if (this.holds(path)) {
      this.held++;
      await this.released;
    }
    return this.files.text(path);
  }

  open(): void {
    this.release();
  }
}

function heldConnectivity(): HeldText {
  return new HeldText(new BundleDirectoryFetcher(), (path) => path.includes("/connectivity-3811."));
}

it("places nothing while an item's connector tables load, and places a click made meanwhile once they load", async () => {
  const gate = heldConnectivity();
  const { editor, backend } = await startEditor([], gate);

  const whileLoading = { ...placerNow(editor, backend)(BASEPLATE, 640, 640), ...queuedOf(editor) };
  backend.aim(646, 634);
  editor.pointerMove(0, 0);
  await vi.waitFor(() => expect(gate.held).toBe(1));
  const { pendingItem, placements } = editor.snapshot();
  gate.open();
  await settledChoice(editor);

  expect({ whileLoading, whileHeld: { pendingItem, placements }, placed: posesOf(editor) }).toEqual(
    {
      whileLoading: {
        placements: 0,
        refusedClicks: 0,
        reason: null,
        queuedPlacement: { item: BASEPLATE, x: 640, z: 640, rot: 0 },
      },
      whileHeld: { pendingItem: BASEPLATE, placements: 0 },
      placed: [expect.stringMatching(/ 640,640 y0$/u)],
    },
  );
}, 120_000);

it("lets go of a click made while an item loads once the pointer leaves that stud", async () => {
  const gate = heldConnectivity();
  const { editor, backend } = await startEditor([], gate);

  placerNow(editor, backend)(BASEPLATE, 640, 640);
  const queued = editor.snapshot().queuedPlacement;
  backend.aim(1280, 640);
  editor.pointerMove(0, 0);
  const afterMove = editor.snapshot().queuedPlacement;
  gate.open();
  await settledChoice(editor);

  expect({ queued: queued !== null, afterMove, placements: editor.snapshot().placements }).toEqual({
    queued: true,
    afterMove: null,
    placements: 0,
  });
}, 120_000);

it("lists the held item's parts that have no connector record, and why, and still places it", async () => {
  const { editor, backend } = await startEditor(
    [],
    new WithoutConnectorRecordsFor(new BundleDirectoryFetcher(), "ldraw:3811"),
  );

  await chosen(editor, BASEPLATE);
  const gaps = editor.snapshot().connectorGaps;
  const placed = await placer(editor, backend)(BASEPLATE, 0, 0);

  expect({ gaps, placements: placed.placements }).toEqual({
    gaps: [
      {
        partIndex: expect.any(Number),
        partId: "ldraw:3811",
        reason: "the bundle's connector packages don't list it",
      },
    ],
    placements: 1,
  });
}, 120_000);

const REFUSED_PART = "ldraw:3023";
const REFUSED_REASON = "the library's connector records can't be read: 503";

async function bundleSetAfterAnImport(withImport: boolean) {
  const importer = new GatedModelImporter();
  const { editor, container, catalog } = await startEditor(
    [PLACEABLE_SET],
    new BundleDirectoryFetcher(),
    [],
    importer,
  );
  const tables = container.get(CONNECTOR_TABLES);
  let imported: PlaceableConnectorTables | null = null;
  if (withImport) {
    const record = await container
      .get(PART_BUNDLE_LOADER)
      .loadModelRecord("standard", PLACEABLE_SET);
    const brought = importedRecord("brings-nulls.mpd", record);
    importer.serve({
      ...brought,
      report: {
        ...brought.report,
        refusedConnectorRecords: [{ partId: REFUSED_PART, reason: REFUSED_REASON }],
      },
    });
    const item = await importChecking(editor);
    const refId = catalog.itemRefId(item);
    const placeable = refId === null ? null : catalog.placeables()[refId];
    if (!placeable) throw new Error("the import was not announced placeable");
    imported = await tables.load(placeable);
  }
  const set = await loadCatalogItem(catalog, `omr:${PLACEABLE_SET}`);
  const loaded = await tables.load(set);
  const mates = container
    .get(PLACEMENT_SEARCH)
    .model(loaded.tables, set.partTransforms, []).internalMates;
  return { imported, set: { withoutRecords: loaded.withoutRecords, mates } };
}

it("keeps a bundle set's parts and mates when it loads after an import that brought no record for those parts", async () => {
  const alone = await bundleSetAfterAnImport(false);
  const afterImport = await bundleSetAfterAnImport(true);

  expect(alone.set.mates).toBeGreaterThan(0);
  expect(afterImport.set).toEqual(alone.set);
  expect(afterImport.set.withoutRecords).toEqual([]);
}, 120_000);

it("lists an import's own parts without records, with the import's reasons, while a bundle set loaded after it has them", async () => {
  const { imported, set } = await bundleSetAfterAnImport(true);
  const refused = imported?.withoutRecords.find((part) => part.partId === REFUSED_PART);
  const reasons = new Set(imported?.withoutRecords.map((part) => part.reason));

  expect({ refused: refused?.reason, reasons, setGaps: set.withoutRecords }).toEqual({
    refused: REFUSED_REASON,
    reasons: new Set([REFUSED_REASON, "the import found no connector record for it"]),
    setGaps: [],
  });
}, 120_000);

class ImporterBringing implements IModelImporter {
  constructor(
    private readonly partIds: ReadonlyArray<string>,
    private readonly connectors: ReadonlyArray<PartConnectors | null>,
  ) {}

  async importText(fileName: string): Promise<ImportResult> {
    return {
      ...refusedBake(fileName),
      partIds: [...this.partIds],
      connectors: [...this.connectors],
    };
  }

  async importStudio(fileName: string): Promise<ImportResult> {
    return this.importText(fileName);
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return {};
  }
}

it("gives a part the bundle's packages don't list the record an import brought for it", async () => {
  const hidden = new WithoutConnectorRecordsFor(new BundleDirectoryFetcher(), "ldraw:3811");
  const shipped = new BundleDirectoryFetcher();
  const { container: reader } = await startEditor([], shipped);
  const record = await reader.get(PART_BUNDLE_LOADER).loadPartConnectors("standard", "ldraw:3811");
  const { editor, container } = await startEditor(
    [],
    hidden,
    [],
    new ImporterBringing(["ldraw:3811"], [record]),
  );

  await editor.importModelFile({
    name: "brings-3811.ldr",
    bytes: new TextEncoder().encode("0 x\n"),
  });
  await chosen(editor, BASEPLATE);
  const catalog = container.get(PLACEABLE_CATALOG);
  const refId = catalog.itemRefId(BASEPLATE);
  const baseplate = refId === null ? null : catalog.placeables()[refId];
  const tables = baseplate ? container.get(CONNECTOR_TABLES).loaded(baseplate) : null;

  expect(record).not.toBeNull();
  expect({
    gaps: editor.snapshot().connectorGaps,
    tabled: tables?.tables.filter((table) => table !== null).length,
  }).toEqual({ gaps: [], tabled: 1 });
}, 120_000);
