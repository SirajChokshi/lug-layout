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
  type PartShapeAsset,
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
  LibraryPartsFile,
  RollingDiagnosticsFile,
} from "@brr/schema/bundle";
import {
  CAMERA_FOV_DEGREES,
  SCENE_BACKEND,
  INSTANCE_MATRIX_FLOATS,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ChunkTier,
  type FarModelPlacement,
  type GhostVerdict,
  type ISceneBackend,
  type LookSettings,
  type NeededMeshListener,
  type PaletteLevel,
  type PartMeshUpdate,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import {
  CandidatePoses,
  MateReport,
  ProposalProgress,
  RoadNetwork,
  levelCrossings,
  type CrossingTrack,
  type RampPart,
  type RoadPlacement,
} from "@brr/domain";
import { LevelCrossingFacts } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import crossingJson from "../../../../docs/verified-facts/level-crossing.json" with { type: "json" };
import { PLATE_LDU, STUD_LDU, pose16, zeta16 } from "@brr/math";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { CHUNK_LDU, ZETA16_ORDER } from "@brr/math";
import type { Decoded } from "@brr/schema/decode";
import type { PlanArchive } from "@brr/schema/plan";
import {
  shardEntry,
  shardName,
  worldManifest,
  type ConsistRecordV1,
  type ImportedFile,
  type WorldArchive,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldShardV1,
} from "@brr/schema/world";
import {
  WORLD_LOCKS,
  INDEXED_DB,
  WORLD_REPOSITORY,
  type IWorldLocks,
  type IWorldRepository,
  type WorldLease,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import {
  commandEnabled,
  commandForKey,
  runEditorAction,
  startPlay,
  type CommandId,
} from "../commands/editor-commands.ts";
import { toolHints } from "../commands/tool-hints.ts";
import type { ImportResult, PlacementListener, RollingDiagnosticsRows } from "@brr/import";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import {
  BOM_SERVICE,
  CONNECTION_SOLVER,
  CONNECTOR_TABLES,
  EDITOR,
  EDITOR_CAMERA,
  MODEL_IMPORTER,
  PLACEABLE_CATALOG,
  TRACK_WORLD,
  PLACEMENT_SEARCH,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
  RAIL_YARD,
  RUNNING_GEAR,
  RUNNING_GEAR_OVERRIDES,
  SIM_CLIENT,
  SNAP_SHAPES,
  SPARSE_CONNECTOR_FINDER,
  TRAIN_PLAY,
  WORLD_SESSION,
} from "../tokens.ts";
import { MemoryOverrideStore } from "../running-gear/memory-override-store.test-support.ts";
import type { IRunningGear } from "../running-gear/running-gear-editor.ts";
import {
  InThreadModelImporter,
  pinnedOmrModel,
} from "../import/in-thread-importer.test-support.ts";
import { InThreadSim } from "../sim/in-thread-sim.test-support.ts";
import { TRACK_SEGMENT, WRITE_ADD, type EditKind, type PlanDelta } from "@brr/domain";
import type { BomScope } from "../bom/bom-service.ts";
import type { PlaceableConnectorTables } from "../connect/connector-tables.ts";
import { loadCatalogItem } from "../catalog/catalog-item.test-support.ts";
import { chainedPoses, instancesAt } from "../connect/track-instances.test-support.ts";
import { rampChunkKey } from "./crossing-ramps.ts";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import type { EditorSnapshot, IEditor } from "./editor.ts";
import { TRACK_ITEM_ID, TRACK_PIECE_PREFIX } from "./track-edit-session.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import type { TrackRouteView } from "./track-drawing.ts";
import type { ExtensionTurn } from "./track-extension.ts";
import { meshesSettled } from "./mesh-progress.ts";
import { chosen, settledChoice } from "./editor-choice.test-support.ts";
import { typedArraysConstructedDuring } from "../connect/typed-arrays.test-support.ts";
import { mateCounts } from "./placement-hover-view.ts";
import type { PlacementHover } from "./placement-hover.ts";
import { placementModeSwitchEnabled } from "./placement-mode.ts";
import type { PlaySnapshot } from "../play/train-play.ts";
import { ViewCamera } from "../camera/view-camera.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const PLACEABLE_SET = "7936-1";
const PLAIN_MODULE_MODEL = "mils-plain";
const OPEN_TABLE_X = 2_560;
const RAY_HEIGHT_LDU = 10_000;
const NDC_SPAN_LDU = 4_000;
const STUD = 20;
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
const USER_BRICK = "brick-2x4";
const HELD_BRICK = `omr:${USER_BRICK}`;
const DUAL_CARRIAGEWAY = "ldraw:30225b@72";

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

  prefetchPartConnectors(lod: BundleLod): Promise<void> {
    return this.loader.prefetchPartConnectors(lod);
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

  loadLibraryParts(lod: BundleLod): Promise<LibraryPartsFile | null> {
    return this.loader.loadLibraryParts(lod);
  }
}

interface AimedBackend {
  aim(x: number, z: number, slope?: number): void;
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
  readonly chunksSet: number[] = [];
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
    this.chunksSet.push(key);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setNeededMeshListener(): void {}
  ghostInstances = 0;
  ghost: { readonly x: number; readonly z: number; readonly rot: number } | null = null;
  readonly ghostPose: number[] = [];
  setGhost(model: ChunkInstances | null): void {
    this.ghostInstances = model?.count ?? 0;
    this.ghost = null;
  }
  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    this.ghost = { x, z, rot };
    this.ghostPose.splice(0, this.ghostPose.length, x, yLdu, z, rot);
  }
  selectionBoxes = 0;
  setSelectionBoxes(boxes: ReadonlyArray<unknown>): void {
    this.selectionBoxes = boxes.length;
  }
  verdict: GhostVerdict | null = null;
  setGhostVerdict(verdict: GhostVerdict | null): void {
    this.verdict = verdict;
  }
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  readonly vehicles = new Map<number, ReadonlyArray<number>>();
  readonly vehicleModels = new Map<number, ChunkInstances>();
  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.vehicles.set(vehicle, []);
    this.vehicleModels.set(vehicle, model);
  }
  setVehiclePose(vehicle: number, x: number, y: number, z: number, yaw: number): void {
    this.vehicles.set(vehicle, [x, y, z, yaw]);
  }
  deleteVehicle(vehicle: number): void {
    this.vehicles.delete(vehicle);
    this.vehicleModels.delete(vehicle);
  }
  setIssueBoxes(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
  private aimX = 0;
  private aimZ = 0;
  private aimSlope = 0;
  viewHalfWidthLdu = NDC_SPAN_LDU;
  aim(x: number, z: number, slope = 0): void {
    this.aimX = x;
    this.aimZ = z;
    this.aimSlope = slope;
  }
  camera: ViewCamera | null = null;
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    if (this.camera) {
      this.camera.rayThrough(ndcX, ndcY, out);
      return;
    }
    const back = this.aimSlope * RAY_HEIGHT_LDU;
    out.set([
      this.aimX + ndcX * this.viewHalfWidthLdu,
      RAY_HEIGHT_LDU,
      this.aimZ - ndcY * NDC_SPAN_LDU + back,
      0,
      -1,
      -this.aimSlope,
    ]);
  }
  setView(): void {}
  resize(): void {}
  onRender: (() => void) | null = null;
  renderFrame(): void {
    this.onRender?.();
  }
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
  rebind: (container: Container) => void = () => undefined,
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
  rebind(container);
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

const LOCOMOTIVE = "omr:10133-1";
const LOCOMOTIVE_LABEL = "10133-1 Burlington Northern Santa Fe Locomotive (2004)";
const CABOOSE = "omr:10014-1";
const CABOOSE_LABEL = "10014-1 Caboose (2001)";
const MY_OWN_TRAIN = "omr:10205-1";
const DRAG_STEPS = 8;
const TRAIN_SPEED_LDU_PER_S = 200;
const RUN_TICKS = 180;
const SAME_POSE_LDU = 1e-9;
const PIVOT_SHIFT_LDU = 8;

function onLattice(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU;
}

function drawOval(editor: IEditor, backend: AimedBackend, tool = TRACK_ITEM_ID): void {
  editor.chooseItem(tool);
  const drag = (from: { x: number; z: number }, to: { x: number; z: number }) => {
    backend.aim(from.x, from.z);
    editor.dragStart(0, 0);
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const t = step / DRAG_STEPS;
      backend.aim(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t);
      editor.dragMove(0, 0);
    }
    editor.dragEnd(0, 0, 0);
  };
  drag({ x: -400, z: 0 }, { x: 400, z: 0 });
  const ends = editor.dump().trackEnds;
  const east = ends.find((end) => end.heading === 0);
  const west = ends.find((end) => end.heading === ZETA16_ORDER / 2);
  if (!east || !west) throw new Error(`a straight run has two ends: ${JSON.stringify(ends)}`);
  drag(
    { x: onLattice(east.xLdu), z: onLattice(east.zLdu) },
    { x: onLattice(west.xLdu), z: onLattice(west.zLdu) },
  );
  if (editor.dump().trackEnds.length > 0) throw new Error("the oval did not close");
  editor.chooseItem(null);
}

const PLASTIC_TRACK = "track:lego-plastic";

it("draws an oval of 6-wide plastic track with its own tool, every end joined exactly, warns in the plan that its curves' connector poses are unverified, and lays 9V again with the 9V tool", async () => {
  const { editor, backend, container } = await startEditor([]);
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: 4000,
    roomDepthMm: 4000,
    originChunkX: -2,
    originChunkZ: -2,
  });
  const tools = editor
    .snapshot()
    .catalog.filter((item) => item.kind === "track" && item.listedUnder === null)
    .map((item) => [item.id, item.label]);
  drawOval(editor, backend, PLASTIC_TRACK);
  const plastic = editor.dump().laidTrack;
  const counts = editor.snapshot().track;
  const toolStates = editor.snapshot().trackTools;
  const warnings = plans
    .issues(planId)
    .filter((issue) => issue.rule === "trackUnverified")
    .map((issue) => issue.message);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-24 * STUD, 120 * STUD], [24 * STUD, 120 * STUD]);
  const nineVolt = editor.dump().laidTrack.slice(plastic.length);
  const curves = plastic.filter((piece) => piece.ref === "ldraw:53400").length;

  expect(tools).toEqual([
    [TRACK_ITEM_ID, "Track: 9V straights and R40 curves"],
    [PLASTIC_TRACK, "Track: 6 Studs Wide straights and R40 curves"],
  ]);
  expect(new Set(plastic.map((piece) => piece.ref))).toEqual(
    new Set(["ldraw:53401", "ldraw:53400"]),
  );
  expect({ openEnds: counts?.openEnds, joins: counts?.joins }).toEqual({
    openEnds: 0,
    joins: plastic.length,
  });
  expect(toolStates).toEqual([
    { item: TRACK_ITEM_ID, status: "certified", active: false },
    { item: PLASTIC_TRACK, status: "unverified", active: true },
  ]);
  expect(warnings).toEqual([
    expect.stringMatching(
      new RegExp(
        `^${curves} × 53400 Train Track 6 Studs Wide Curved laid as .*, whose connector poses are unverified: they're derived from the part file but not certified`,
        "u",
      ),
    ),
  ]);
  expect(nineVolt.length).toBeGreaterThan(0);
  expect(new Set(nineVolt.map((piece) => piece.ref))).toEqual(new Set(["ldraw:74746"]));
}, 120_000);

const MY_WAGONS = new URL(
  "../../../import/test-data/my-container-and-tank-wagons.ldr",
  import.meta.url,
);

function isCurve(route: TrackRouteView): boolean {
  return (route.to.heading - route.from.heading + ZETA16_ORDER) % ZETA16_ORDER !== ZETA16_ORDER / 2;
}

function curveFarthestFrom(
  editor: IEditor,
  taken: ReadonlyArray<{ readonly x: number; readonly z: number }>,
): { readonly x: number; readonly z: number } {
  const curves = editor
    .trackRoutes()
    .filter(isCurve)
    .map((route) => ({
      x: (route.from.xLdu + route.to.xLdu) / 2,
      z: (route.from.zLdu + route.to.zLdu) / 2,
    }));
  const clearance = (point: { readonly x: number; readonly z: number }) =>
    Math.min(...taken.map((other) => Math.hypot(point.x - other.x, point.z - other.z)));
  const farthest = curves.toSorted((a, b) => clearance(b) - clearance(a))[0];
  if (!farthest) throw new Error("the oval has no curve");
  return farthest;
}

async function myBlueCaboose(): Promise<Uint8Array> {
  const official = await pinnedOmrModel("10014-1.mpd");
  const custom = official
    .replaceAll("10014 - ", "my blue caboose - ")
    .split("\n")
    .map((line) => line.replace(/^1 0 /u, "1 1 "))
    .join("\n");
  return new TextEncoder().encode(custom);
}

function trainsOf(editor: IEditor) {
  return editor.snapshot().trains.map((train) => [train.item, train.onRails]);
}

function standingPoses(backend: HeadlessBackend): ReadonlyArray<ReadonlyArray<number>> {
  return [...backend.vehicles.values()].toSorted(
    (a, b) =>
      (a[0] ?? 0) - (b[0] ?? 0) ||
      (a[2] ?? 0) - (b[2] ?? 0) ||
      (a[1] ?? 0) - (b[1] ?? 0) ||
      (a[3] ?? 0) - (b[3] ?? 0),
  );
}

function sameStanding(
  a: ReadonlyArray<ReadonlyArray<number>>,
  b: ReadonlyArray<ReadonlyArray<number>>,
): boolean {
  return (
    a.length === b.length &&
    a.every((pose, i) =>
      pose.every((value, k) => Math.abs(value - (b[i]?.[k] ?? NaN)) < SAME_POSE_LDU),
    )
  );
}

it("seats a held train on the rails of a hand-drawn oval where the cursor points at them, places it as a model away from them, and couples a second train held on track a train already stands on", async () => {
  const { editor, backend, catalog } = await startEditor(
    [LOCOMOTIVE, CABOOSE].map((id) => id.slice(4)),
  );
  drawOval(editor, backend);
  for (const item of [LOCOMOTIVE, CABOOSE]) await loadCatalogItem(catalog, item);
  const place = placer(editor, backend);

  const onRails = await place(LOCOMOTIVE, 0, 0);
  const onRailsVehicles = backend.vehicles.size;
  const sameTrack = await place(CABOOSE, 100, 0);
  const farSide = await place(CABOOSE, -100, 1600);
  const awayFromRails = await place(LOCOMOTIVE, 0, 4000);

  expect(onRails).toMatchObject({ placements: 0, refusedClicks: 0 });
  expect(onRailsVehicles).toBeGreaterThan(0);
  expect(sameTrack).toMatchObject({ placements: 0, refusedClicks: 0 });
  expect(farSide).toMatchObject({ placements: 0, refusedClicks: 0 });
  expect(awayFromRails).toMatchObject({ placements: 1, refusedClicks: 0 });
  expect(editor.snapshot().trains.map((train) => [train.label, train.onRails])).toEqual([
    [`${CABOOSE_LABEL} + ${LOCOMOTIVE_LABEL}`, true],
    [CABOOSE_LABEL, true],
  ]);
}, 120_000);

interface DrawnVehicle {
  readonly instances: number;
  readonly pose: ReadonlyArray<number>;
  readonly lowestLdu: number;
}

function lowestPointOf(
  model: ChunkInstances,
  poseY: number,
  parts: ReadonlyArray<PartShapeAsset>,
): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (let k = 0; k < model.count; k++) {
    const part = parts[model.partIndex[k] ?? 0];
    if (!part) continue;
    const o = k * INSTANCE_MATRIX_FLOATS;
    const m = model.matrices;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? part.boundsMax[0] : part.boundsMin[0];
      const y = corner & 2 ? part.boundsMax[1] : part.boundsMin[1];
      const z = corner & 4 ? part.boundsMax[2] : part.boundsMin[2];
      const height =
        (m[o + 4] ?? 0) * x + (m[o + 5] ?? 0) * y + (m[o + 6] ?? 0) * z + (m[o + 7] ?? 0);
      lowest = Math.min(lowest, poseY + height);
    }
  }
  return lowest;
}

function drawnVehicles(
  backend: HeadlessBackend,
  parts: ReadonlyArray<PartShapeAsset>,
): ReadonlyArray<DrawnVehicle> {
  return [...backend.vehicleModels].map(([id, model]) => {
    const pose = backend.vehicles.get(id) ?? [];
    return { instances: model.count, pose, lowestLdu: lowestPointOf(model, pose[1] ?? 0, parts) };
  });
}

it("draws every part of a train standing on the rails, the figures that ride none of its cars standing on the ground beside it, where they stay while Play runs", async () => {
  const sim = new InThreadSim();
  const { editor, backend, container, catalog } = await startEditor(
    [LOCOMOTIVE.slice(4)],
    new BundleDirectoryFetcher(),
    [],
    (bound) => {
      bound.rebind(SIM_CLIENT).toConstantValue(sim);
    },
  );
  drawOval(editor, backend);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  await placer(editor, backend)(LOCOMOTIVE, 0, 0);
  editor.chooseItem(null);
  const { model } = await container
    .get(PART_BUNDLE_LOADER)
    .loadModel("standard", LOCOMOTIVE.slice(4));
  const laidAtLdu = Math.min(...editor.dump().laidTrack.map((piece) => piece.yPlates)) * PLATE_LDU;
  const parts = catalog.parts();
  const standing = drawnVehicles(backend, parts);
  const play = container.get(TRAIN_PLAY);

  await play.start();
  const playing = drawnVehicles(backend, parts);
  play.stop();
  const stoodBack = drawnVehicles(backend, parts);

  const onTheGround = (drawn: ReadonlyArray<DrawnVehicle>) =>
    drawn.filter((vehicle) => vehicle.lowestLdu === laidAtLdu);
  expect(standing.reduce((sum, vehicle) => sum + vehicle.instances, 0)).toBe(model.instanceCount);
  expect(Math.min(...standing.map((vehicle) => vehicle.lowestLdu))).toBe(laidAtLdu);
  expect(onTheGround(standing)).toHaveLength(1);
  expect(onTheGround(playing)).toEqual(onTheGround(standing));
  expect(onTheGround(stoodBack)).toEqual(onTheGround(standing));
}, 120_000);

it("couples a user's own caboose behind a set's locomotive and a user's two wagons turned round behind that, runs them as one train, undoes and redoes each coupling, and reopens the world with the train coupled", async () => {
  const sim = new InThreadSim();
  const repository = new MemoryRepository();
  const { editor, backend, container, catalog } = await startEditor(
    [LOCOMOTIVE.slice(4)],
    new BundleDirectoryFetcher(),
    [],
    (bound) => {
      bound
        .rebind(MODEL_IMPORTER)
        .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
      bound.rebind(SIM_CLIENT).toConstantValue(sim);
      bound.rebind(WORLD_REPOSITORY).toConstantValue(repository);
    },
  );
  drawOval(editor, backend);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  await editor.importModelFile({ name: "my-blue-caboose.mpd", bytes: await myBlueCaboose() });
  const caboose = editor.snapshot().modelImport?.item ?? "";
  await editor.importModelFile({
    name: "my-container-and-tank-wagons.ldr",
    bytes: await readFile(MY_WAGONS),
  });
  const wagons = editor.snapshot().modelImport?.item ?? "";
  const labels = () => editor.snapshot().trains.map((train) => train.label);
  const hold = async (item: string, x: number, z: number, turned: boolean) => {
    await chosen(editor, item);
    if (turned) editor.rotate(0, 1);
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    const couples = editor.snapshot().hover?.couples ?? null;
    editor.click(0, 0, 0);
    return { couples, refused: editor.snapshot().lastRefusal?.reason ?? null };
  };
  await placer(editor, backend)(LOCOMOTIVE, 0, 0);
  const behindLoco = await hold(caboose, -500, 0, false);
  const behindCaboose = await hold(wagons, -550, 0, true);
  editor.chooseItem(null);
  const coupled = labels();
  const play = container.get(TRAIN_PLAY);
  await play.start();
  const running = play.snapshot().trains.map((train) => [train.label, train.vehicles]);
  play.stop();
  editor.undo(0);
  const undoneOnce = labels();
  editor.undo(0);
  const undoneTwice = labels();
  editor.redo(0);
  editor.redo(0);
  const redone = labels();
  const saved = () =>
    repository.storedConsistRecords().map((consist) => ({
      ref: consist.ref,
      coupled: consist.coupled?.map((vehicle) => [vehicle.ref, vehicle.reversed]),
    }));
  await vi.waitFor(() => expect(saved()[0]?.coupled).toHaveLength(2));
  const first = editor.snapshot().world?.id ?? "";
  await editor.newWorld("Second");
  await editor.openWorld(first);

  const whole = `${LOCOMOTIVE_LABEL} + my-blue-caboose.mpd + my-container-and-tank-wagons.ldr`;
  expect({ behindLoco, behindCaboose }).toEqual({
    behindLoco: { couples: { end: "rear", train: LOCOMOTIVE_LABEL }, refused: null },
    behindCaboose: {
      couples: { end: "rear", train: `${LOCOMOTIVE_LABEL} + my-blue-caboose.mpd` },
      refused: null,
    },
  });
  expect({ coupled, running, undoneOnce, undoneTwice, redone }).toEqual({
    coupled: [whole],
    running: [[whole, 4]],
    undoneOnce: [`${LOCOMOTIVE_LABEL} + my-blue-caboose.mpd`],
    undoneTwice: [LOCOMOTIVE_LABEL],
    redone: [whole],
  });
  expect(saved()).toEqual([
    {
      ref: LOCOMOTIVE,
      coupled: [
        [caboose, false],
        [wagons, true],
      ],
    },
  ]);
  expect(labels()).toEqual([whole]);
}, 240_000);

async function saveShiftedPivot(gear: IRunningGear, model: string): Promise<string | null> {
  gear.select(model, 0);
  const pivot = gear.snapshot().view?.pivots[0];
  if (!pivot) throw new Error(`${model} has no bogie pivot`);
  gear.setPivot(0, pivot[0] + PIVOT_SHIFT_LDU, pivot[2]);
  await gear.save();
  return gear.snapshot().error;
}

it("runs every train on the rails, imported ones included, from exactly where each stands on its saved running gear, two cars of one file as one coupled consist, and stands them back there when Play stops", async () => {
  const sim = new InThreadSim();
  const overrides = new MemoryOverrideStore();
  const { editor, backend, container, catalog } = await startEditor(
    [LOCOMOTIVE.slice(4)],
    new BundleDirectoryFetcher(),
    [],
    (bound) => {
      bound
        .rebind(MODEL_IMPORTER)
        .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
      bound.rebind(SIM_CLIENT).toConstantValue(sim);
      bound.rebind(RUNNING_GEAR_OVERRIDES).toConstantValue(overrides);
    },
  );
  drawOval(editor, backend);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  const imported = await editor.importModelFile({
    name: "my-blue-caboose.mpd",
    bytes: await myBlueCaboose(),
  });
  const custom = editor.snapshot().modelImport?.item ?? "";
  const importedWagons = await editor.importModelFile({
    name: "my-container-and-tank-wagons.ldr",
    bytes: await readFile(MY_WAGONS),
  });
  const wagons = editor.snapshot().modelImport?.item ?? "";
  const place = placer(editor, backend);
  await place(LOCOMOTIVE, 0, 0);
  await place(custom, -100, 1600);
  const curve = curveFarthestFrom(editor, [
    { x: 0, z: 0 },
    { x: -100, z: 1600 },
  ]);
  const wagonsPlaced = await place(wagons, curve.x, curve.z);
  editor.chooseItem(null);
  const gear = container.get(RUNNING_GEAR);
  await vi.waitFor(() => expect(gear.snapshot().models).toHaveLength(3));
  const detected = standingPoses(backend);
  const saveError = await saveShiftedPivot(gear, LOCOMOTIVE.slice(4));
  await vi.waitFor(() => expect(sameStanding(standingPoses(backend), detected)).toBe(false));
  const parked = standingPoses(backend);
  const play = container.get(TRAIN_PLAY);

  await play.start();
  const started = play.snapshot();
  const playing = standingPoses(backend);
  const trainAt = () => {
    const data = sim.latestFrame()?.data ?? new Float64Array(0);
    const { trainEdgeStart, trainOffsetStart } = sim.frameLayout();
    return [0, 1, 2].map((t) => [data[trainEdgeStart + t], data[trainOffsetStart + t]]);
  };
  const before = trainAt();
  play.drive(TRAIN_SPEED_LDU_PER_S);
  play.chooseDriven(1);
  play.drive(-TRAIN_SPEED_LDU_PER_S);
  play.chooseDriven(2);
  play.drive(TRAIN_SPEED_LDU_PER_S);
  sim.advance(RUN_TICKS);
  const after = trainAt();
  play.stop();

  expect(saveError).toBeNull();
  expect([imported, importedWagons]).toEqual([true, true]);
  expect([custom, wagons]).toEqual([
    expect.stringMatching(/^import:/u),
    expect.stringMatching(/^import:/u),
  ]);
  expect(wagonsPlaced).toMatchObject({ placements: 0, refusedClicks: 0 });
  expect(started).toMatchObject({ status: "running", error: null });
  expect(started.trains.map((train) => [train.label, train.vehicles])).toEqual([
    ["10133-1 Burlington Northern Santa Fe Locomotive (2004)", 1],
    ["my-blue-caboose.mpd", 1],
    ["my-container-and-tank-wagons.ldr", 2],
  ]);
  expect(parked.length).toBeGreaterThan(0);
  expect(sameStanding(playing, parked)).toBe(true);
  expect(after.every((position, t) => JSON.stringify(position) !== JSON.stringify(before[t]))).toBe(
    true,
  );
  expect(sameStanding(standingPoses(backend), parked)).toBe(true);
}, 240_000);

const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";

function userFileWithOwnPart(name: string, partLicense: string | null): Uint8Array {
  return new TextEncoder().encode(
    [
      `0 FILE ${name}`,
      `0 ${name}, a user's own model`,
      `0 Name: ${name}`,
      "0 Author: lug-layout test",
      `0 !LICENSE ${CC_BY_4}`,
      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 my-brick.dat",
      "0 NOFILE",
      "0 FILE my-brick.dat",
      "0 My brick, the user's own part",
      "0 Name: my-brick.dat",
      "0 Author: lug-layout test [James Jessiman]",
      "0 !LDRAW_ORG Unofficial_Part",
      ...(partLicense === null ? [] : [`0 !LICENSE ${partLicense}`]),
      "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "0 NOFILE",
      "",
    ].join("\n"),
  );
}

async function importUserFile(editor: IEditor, name: string, bytes: Uint8Array): Promise<string> {
  expect(await editor.importModelFile({ name, bytes })).toBe(true);
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0), { timeout: 60_000 });
  const item = editor.snapshot().modelImport?.item;
  if (!item) throw new Error(`${name} didn't import`);
  return item;
}

function planWithoutIds(plans: IPlanService) {
  return plans.plans().map(({ id: _plan, footprint, ...region }) => ({
    ...region,
    tables: footprint.tables.map(({ id: _table, ...table }) => table),
    obstacles: footprint.obstacles.map(({ id: _obstacle, ...obstacle }) => obstacle),
    room: [footprint.roomWidthMm, footprint.roomDepthMm],
  }));
}

function startImportingEditor(
  repository: (archives: IWorldRepository) => IWorldRepository = (archives) =>
    new MemoryRepository(archives),
  models: ReadonlyArray<string> = [],
) {
  return startEditor([...models], new BundleDirectoryFetcher(), [], (bound) => {
    bound
      .rebind(MODEL_IMPORTER)
      .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
    const archives = bound.get(WORLD_REPOSITORY);
    bound.rebind(WORLD_REPOSITORY).toConstantValue(repository(archives));
  });
}

it("lists a user's own file in the catalog by its name when a fresh editor reopens the world that places it", async () => {
  const repository = new MemoryRepository();
  const saving = await startImportingEditor(() => repository);
  const cottage = await importUserFile(
    saving.editor,
    "my-cottage.mpd",
    userFileWithOwnPart("my-cottage.mpd", CC_BY_4),
  );
  await placer(saving.editor, saving.backend)(cottage, 0, 0);
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(1));

  const reopened = await startImportingEditor(() => repository);

  expect(posesOf(reopened.editor)).toEqual(posesOf(saving.editor));
  expect(
    reopened.editor
      .snapshot()
      .catalog.filter((item) => item.id === cottage)
      .map((item) => item.label),
  ).toEqual(["my-cottage.mpd"]);
}, 240_000);

it("saves a plan's tables, placements, laid track and every user file it places, whatever its own parts' licences, and a fresh editor reopens them exactly as one undo step", async () => {
  const saving = await startImportingEditor();
  const cottageFile = userFileWithOwnPart("my-cottage.mpd", CC_BY_4);
  const shedFile = userFileWithOwnPart("my-shed.mpd", null);
  const cottage = await importUserFile(saving.editor, "my-cottage.mpd", cottageFile);
  const shed = await importUserFile(saving.editor, "my-shed.mpd", shedFile);
  drawOval(saving.editor, saving.backend);
  const place = placer(saving.editor, saving.backend);
  await place(BASEPLATE, 1600, 1600);
  await place(cottage, 1600, 1600);
  await place(shed, -1600, 1600);
  const inPlan = { poses: posesOf(saving.editor), track: saving.editor.dump().laidTrack };
  await place(BASEPLATE, 19_200, 19_200);
  saving.editor.chooseItem(null);
  const savingPlans = saving.container.get(PLAN_SERVICE);
  const { planId } = savingPlans.drawTable({ minX: -2560, minZ: -2560, maxX: 2560, maxZ: 2560 });
  savingPlans.updatePlan(planId, { maxOverhangMm: 16 });
  const savedPlan = planWithoutIds(savingPlans);
  await vi.waitFor(() => expect(savingPlans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
  const saved = await saving.editor.exportPlan(planId);
  if (!saved) throw new Error(`the plan wasn't saved: ${saving.editor.snapshot().fileError}`);
  const archive = await saving.container.get(WORLD_REPOSITORY).readPlanArchive(saved.bytes);
  const printable = saving.container.get(PLAN_SHEET_SERVICE).printable(saving.editor, planId);
  const partsList = await saving.container
    .get(BOM_SERVICE)
    .billOfMaterials(saving.editor, { kind: "plan", planId });
  const reopenedOnItself = await saving.editor.openPlan(saved.bytes);

  const fresh = await startImportingEditor();
  const opened = await fresh.editor.openPlan(saved.bytes);
  const errorAfterOpen = fresh.editor.snapshot().fileError;
  const freshPlans = fresh.container.get(PLAN_SERVICE);
  const reopened = {
    poses: posesOf(fresh.editor),
    track: fresh.editor.dump().laidTrack,
    plan: planWithoutIds(freshPlans),
  };
  const freshPlanId = freshPlans.activePlanId() ?? "";
  await vi.waitFor(() => expect(freshPlans.unmeasuredCount(freshPlanId)).toBe(0), {
    timeout: 60_000,
  });
  const resaved = await fresh.editor.exportPlan(freshPlanId);
  const reread =
    resaved && (await fresh.container.get(WORLD_REPOSITORY).readPlanArchive(resaved.bytes));
  const undoLabel = fresh.editor.snapshot().history.undoLabel;
  fresh.editor.undo(0);
  const undone = { poses: posesOf(fresh.editor), track: fresh.editor.dump().laidTrack };
  const undonePlans = freshPlans.plans().length;
  fresh.editor.redo(0);

  expect(saved.fileName).toBe("Plan-1.brrplan.zip");
  expect(
    archive.ok && new Map(archive.value.imports.map((file) => [file.name, file.bytes])),
  ).toEqual(
    new Map([
      ["my-cottage.mpd", cottageFile],
      ["my-shed.mpd", shedFile],
    ]),
  );
  expect(archive.ok && archive.value.outputs).toEqual({
    "plan.svg": printable,
    "parts.csv": partsList.files.plainCsv,
    "bricklink.xml": partsList.files.brickLinkXml,
    "rebrickable.csv": partsList.files.rebrickableCsv,
  });
  expect(archive.ok && archive.value.credits).toContain(
    `my-brick.dat: My brick, the user's own part, by lug-layout test [James Jessiman], ${CC_BY_4}`,
  );
  expect(reopenedOnItself).toBe(false);
  expect(saving.editor.snapshot().fileError).toContain(OVERLAP);
  expect(opened).toBe(true);
  expect(errorAfterOpen).toBeNull();
  expect(reopened).toEqual({ ...inPlan, plan: savedPlan });
  const { outputs: savedOutputs, ...savedData } = archive.ok ? archive.value : { outputs: null };
  const { outputs: resavedOutputs, ...resavedData } = reread?.ok ? reread.value : { outputs: null };
  expect(resavedData).toEqual(savedData);
  expect(resavedOutputs?.["parts.csv"]).toBe(savedOutputs?.["parts.csv"]);
  expect(undoLabel).toBe(
    `open plan (${inPlan.poses.length} placements, ${inPlan.track.length} track pieces)`,
  );
  expect({ ...undone, plans: undonePlans }).toEqual({ poses: [], track: [], plans: 0 });
  expect({ poses: posesOf(fresh.editor), track: fresh.editor.dump().laidTrack }).toEqual(inPlan);
}, 240_000);

it.each([
  {
    held: "a brick on top resting on bricks outside the plan",
    clicks: [
      [580, 300],
      [580, 300],
      [620, 300],
    ],
    poses: [`${HELD_BRICK} 580,300 y0`, `${HELD_BRICK} 580,300 y3`, `${HELD_BRICK} 620,300 y6`],
    refusal:
      "brick-2x4: rests only on models outside the plan, so it wouldn't be held where the plan opens",
  },
  {
    held: "two bricks holding each other up off the table on a brick outside the plan",
    clicks: [
      [580, 300],
      [620, 300],
      [620, 300],
    ],
    poses: [`${HELD_BRICK} 580,300 y0`, `${HELD_BRICK} 620,300 y3`, `${HELD_BRICK} 620,300 y6`],
    refusal:
      "Plan 1: has no model standing on the table, so nothing would hold it up where it opens",
  },
])(
  "refuses to save a plan its own models and the table don't hold up, with $held, and saves it once the plan takes in what holds them",
  async ({ clicks, poses, refusal }) => {
    const { editor, backend, catalog, container } = await startEditor(
      [],
      new BundleDirectoryFetcher(),
      [USER_BRICK],
    );
    await loadCatalogItem(catalog, HELD_BRICK);
    editor.setPlacementMode("precise");
    const place = placer(editor, backend);
    for (const [x, z] of clicks) await place(HELD_BRICK, x ?? 0, z ?? 0);
    editor.chooseItem(null);
    const plans = container.get(PLAN_SERVICE);
    const { planId, tableId } = plans.drawTable({ minX: 640, minZ: 0, maxX: 1280, maxZ: 640 });
    await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
    const refused = await editor.exportPlan(planId);
    const refusalText = editor.snapshot().fileError;
    plans.placeTable(planId, tableId, { minX: 0, minZ: 0, maxX: 1280, maxZ: 640 });
    await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
    const saved = await editor.exportPlan(planId);

    expect(posesOf(editor)).toEqual(poses);
    expect(refused).toBeNull();
    expect(refusalText).toContain(refusal);
    expect(saved?.fileName).toBe("Plan-1.brrplan.zip");
    expect(editor.snapshot().fileError).toBeNull();
  },
  240_000,
);

it("keeps an opened plan open, and says so, when its carried model files can't be stored afterwards", async () => {
  const saving = await startImportingEditor();
  const cottage = await importUserFile(
    saving.editor,
    "my-cottage.mpd",
    userFileWithOwnPart("my-cottage.mpd", CC_BY_4),
  );
  await placer(saving.editor, saving.backend)(cottage, 0, 0);
  saving.editor.chooseItem(null);
  const plans = saving.container.get(PLAN_SERVICE);
  const { planId } = plans.drawTable({ minX: -640, minZ: -640, maxX: 640, maxZ: 640 });
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
  const saved = await saving.editor.exportPlan(planId);
  if (!saved) throw new Error(`the plan wasn't saved: ${saving.editor.snapshot().fileError}`);

  const opening = await startImportingEditor((archives) => new FileRefusingRepository(archives));
  const opened = await opening.editor.openPlan(saved.bytes);

  expect(opened).toBe(true);
  expect(opening.editor.snapshot().fileError).toMatch(
    /^the plan opened, but its model files couldn't be stored on this device \(QuotaExceededError\)/u,
  );
  expect(posesOf(opening.editor)).toEqual(posesOf(saving.editor));
  expect(opening.editor.snapshot().history.undo).toBe("open-plan");
}, 240_000);

it("keeps the trains on the rails in the one undo history and in the saved world: delete, undo and redo a train, and reopen the world", async () => {
  const repository = new MemoryRepository();
  const { editor, backend, catalog } = await startEditor(
    [LOCOMOTIVE.slice(4)],
    new BundleDirectoryFetcher(),
    [],
    (bound) => bound.rebind(WORLD_REPOSITORY).toConstantValue(repository),
  );
  drawOval(editor, backend);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  await placer(editor, backend)(LOCOMOTIVE, 0, 0);
  const selected = selectAt(editor, backend, 0, 0);
  editor.deleteSelection(0);
  const deleted = trainsOf(editor);
  const undoLabel = editor.snapshot().history.undo;
  editor.undo(0);
  const undone = trainsOf(editor);
  editor.redo(0);
  const redone = trainsOf(editor);
  editor.undo(0);
  await vi.waitFor(() => expect(repository.storedConsists()).toBe(1));
  const first = editor.snapshot().world?.id ?? "";
  const drawnBeforeSaving = drawnChunks(backend);
  await editor.newWorld("Second");
  const fresh = trainsOf(editor);
  await editor.openWorld(first);
  expect(drawnBeforeSaving).not.toBe("");
  expect(drawnChunks(backend)).toBe(drawnBeforeSaving);

  expect(selected?.kind).toBe("train");
  expect({ deleted, undoLabel, undone, redone, fresh }).toEqual({
    deleted: [],
    undoLabel: "remove",
    undone: [[LOCOMOTIVE, true]],
    redone: [],
    fresh: [],
  });
  expect(trainsOf(editor)).toEqual([[LOCOMOTIVE, true]]);
  expect(backend.vehicles.size).toBeGreaterThan(0);
}, 120_000);

it("selects a train rather than the track it stands on, and refuses to delete a track piece a train stands on", async () => {
  const { editor, backend, catalog } = await startEditor([LOCOMOTIVE.slice(4)]);
  drawOval(editor, backend);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  await placer(editor, backend)(LOCOMOTIVE, 0, 0);
  const laid = editor.snapshot().track?.pieces;
  const train = selectAt(editor, backend, 0, 0);
  let refusal: string | null = null;
  for (let x = -600; x <= 600 && refusal === null; x += STUD_LDU) {
    if (selectAt(editor, backend, x, 0)?.kind !== "track") continue;
    editor.deleteSelection(0);
    refusal = editor.snapshot().selectionRefusal;
    if (refusal === null) editor.undo(0);
  }

  expect(train?.kind).toBe("train");
  expect(refusal).toContain("stands on this track piece");
  expect(editor.snapshot().track?.pieces).toBe(laid);
  expect(trainsOf(editor)).toEqual([[LOCOMOTIVE, true]]);
}, 120_000);

const SET_LABEL = `${PLACEABLE_SET} Level Crossing (2010)`;
const MY_OWN_TRAIN_LABEL = "10205-1 Locomotive (2002)";
const STRAIGHT_CLEAR_OF_THE_CRANE = 2;

function halfway(route: TrackRouteView): { readonly x: number; readonly z: number } {
  return { x: (route.from.xLdu + route.to.xLdu) / 2, z: (route.from.zLdu + route.to.zLdu) / 2 };
}

it("sets a train on the track inside a placed set, and refuses to delete or turn the set while the train stands on that track", async () => {
  const { editor, backend, catalog } = await startEditor([
    PLACEABLE_SET,
    MY_OWN_TRAIN.slice(4),
    CABOOSE.slice(4),
  ]);
  const set = `omr:${PLACEABLE_SET}`;
  for (const item of [set, MY_OWN_TRAIN, CABOOSE]) await loadCatalogItem(catalog, item);
  const place = settledPlacer(editor, backend);
  await place(set, 0, 0);
  const routes = editor.trackRoutes();
  const middle = routes[0];
  const clear = routes[STRAIGHT_CLEAR_OF_THE_CRANE];
  if (!middle || !clear) throw new Error(`${set} carries no track`);
  const along = halfway(clear);
  const train = await place(CABOOSE, along.x, along.z);
  const standing = trainsOf(editor);
  const box = editor.dump().placements;
  const setAt = { x: (box.x[0] ?? 0) + 20, z: (box.z[0] ?? 0) + 20 };
  editor.chooseItem(null);
  const candidates = [-300, -100, 100, 300].flatMap((dx) =>
    [-300, -100, 100, 300].map((dz) => ({ x: setAt.x + dx, z: setAt.z + dz })),
  );
  const onSet = candidates.find(
    (point) => selectAt(editor, backend, point.x, point.z)?.item === set,
  );
  if (!onSet) throw new Error("no point selects the set");
  editor.deleteSelection(0);
  const deleteRefusal = editor.snapshot().selectionRefusal;
  editor.rotate(0);
  const turnRefusal = editor.snapshot().selectionRefusal;
  editor.undo(0);
  const refusedBefore = editor.snapshot().refusedClicks;
  const throughTheCrane = await place(MY_OWN_TRAIN, halfway(middle).x, halfway(middle).z);

  expect(train).toMatchObject({ placements: 1, refusedClicks: 0 });
  expect(standing).toEqual([[CABOOSE, true]]);
  expect(deleteRefusal).toContain("stands on its track");
  expect(turnRefusal).toContain("stands on its track");
  expect({
    refused: throughTheCrane.refusedClicks - refusedBefore,
    reason: throughTheCrane.reason,
  }).toEqual({
    refused: 1,
    reason: `${MY_OWN_TRAIN_LABEL} would run into ${SET_LABEL} there. Put it where it clears every model.`,
  });
  expect(trainsOf(editor)).toEqual([]);
  expect(editor.snapshot().placements).toBe(1);
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
  private readonly imports = new Map<string, ImportedFile>();
  private nextId = 1;

  constructor(private readonly archives: IWorldRepository | null = null) {}

  private planArchives(): IWorldRepository {
    if (!this.archives) throw new Error("this test packs and reads no plan files");
    return this.archives;
  }

  storedPlacements(): number {
    let count = 0;
    for (const world of this.worlds.values()) {
      for (const shard of world.shards.values()) count += shard.placements.length;
    }
    return count;
  }

  storedConsists(): number {
    return this.storedConsistRecords().length;
  }

  storedConsistRecords(): ReadonlyArray<ConsistRecordV1> {
    return [...this.worlds.values()].flatMap((world) => world.header.consists ?? []);
  }

  storedTrack(): number {
    let count = 0;
    for (const world of this.worlds.values()) {
      for (const shard of world.shards.values()) count += shard.track.length;
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

  async copyWith(
    id: string,
    name: string,
    extra: (placements: WorldShardV1["placements"]) => WorldShardV1["placements"],
  ): Promise<string> {
    const world = this.worlds.get(id);
    if (!world) throw new Error(`world ${id} is not stored`);
    const shards = [...world.shards.values()].map((shard) => ({
      ...shard,
      placements: [...shard.placements, ...extra(shard.placements)],
    }));
    return (await this.create({ ...world.header, name }, shards)).id;
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

  packPlanArchive(archive: PlanArchive): Uint8Array {
    return this.planArchives().packPlanArchive(archive);
  }

  readPlanArchive(bytes: Uint8Array): Promise<Decoded<PlanArchive>> {
    return this.planArchives().readPlanArchive(bytes);
  }

  async putImportedFile(file: ImportedFile): Promise<void> {
    this.imports.set(file.sha256, file);
  }

  async importedFile(sha256: string): Promise<ImportedFile | undefined> {
    return this.imports.get(sha256);
  }
}

class FileRefusingRepository extends MemoryRepository {
  override async putImportedFile(): Promise<void> {
    throw new Error("QuotaExceededError");
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

const SETTLE_FRAMES = 10_000;

function unsettled(placement: PlacementHover | null | undefined): boolean {
  return placement?.settled === false || placement?.turnSettled === false;
}

async function settledHover(editor: IEditor, frame: () => Promise<void>) {
  for (let frames = 0; unsettled(editor.snapshot().hover?.placement); frames++) {
    if (frames >= SETTLE_FRAMES) {
      throw new Error(`the hover is still unsettled after ${SETTLE_FRAMES} frames`);
    }
    await frame();
  }
  return editor.snapshot().hover;
}

function placer(editor: IEditor, backend: AimedBackend) {
  const now = placerNow(editor, backend);
  return async (item: string, x: number, z: number) => {
    await chosen(editor, item);
    return now(item, x, z);
  };
}

async function queueSettled(editor: IEditor): Promise<void> {
  while (editor.snapshot().queuedPlacement !== null) {
    await new Promise<void>((resolve) => {
      const stop = editor.subscribe(() => {
        stop();
        resolve();
      });
    });
  }
}

function settledPlacer(editor: IEditor, backend: AimedBackend) {
  const now = placerNow(editor, backend);
  return async (item: string, x: number, z: number) => {
    await chosen(editor, item);
    now(item, x, z);
    await queueSettled(editor);
    const { placements, refusedClicks, lastRefusal } = editor.snapshot();
    return { placements, refusedClicks, reason: lastRefusal?.reason ?? null };
  };
}

it("a road plate hovered at a road baseplate's sidewalk, from one stud onto it to a stud clear of it, settles mating the sidewalk's edge studs, and the click takes exactly the pose shown", async () => {
  const { editor, backend, frame } = await startEditor([]);
  await placer(editor, backend)("ldraw:44336p04@72", 320, 320);
  await chosen(editor, "ldraw:69958@72");
  const shown = [];
  const clicked = [];
  for (const [x, z] of [
    [770, 320],
    [780, 320],
    [790, 320],
    [800, 320],
    [810, 330],
    [820, 300],
  ] as const) {
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    const hover = await settledHover(editor, frame);
    const pose = hover?.placement?.pose;
    const offered = hover?.placement?.accepted === true && hover.refusal === null && pose;
    shown.push(offered ? [pose.x, pose.z, pose.yPlates] : "refused");
    const before = editor.snapshot().placements;
    editor.click(0, 0, 0);
    const placed = editor.snapshot().placements > before;
    const { x: xs, z: zs, yPlates } = editor.dump().placements;
    const last = xs.length - 1;
    clicked.push(placed ? [xs[last], zs[last], yPlates[last]] : "refused");
    if (placed) editor.undo(0);
  }
  expect(clicked).toEqual(shown);
  expect(shown).toEqual([
    [780, 320, 0],
    [780, 320, 0],
    [780, 320, 0],
    [780, 320, 0],
    [780, 340, 0],
    [780, 300, 0],
  ]);
}, 120_000);

const RECESSED_ROAD_PLATE = "ldraw:69958@72";
const BASEPLATE_32 = "ldraw:3811@2";

async function settledAt(
  editor: IEditor,
  backend: AimedBackend,
  frame: () => Promise<void>,
  x: number,
  z: number,
) {
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  const hover = await settledHover(editor, frame);
  const pose = hover?.placement?.pose;
  return { pose: pose ? [pose.x, pose.z] : null, snap: editor.snapshot().snap?.state ?? null };
}

it("snaps a road plate flush onto another on studded baseplates, from a stud short of or past each edge, since every lattice pose there mates the same studs", async () => {
  const { editor, backend, frame } = await startEditor([]);
  const place = placer(editor, backend);
  for (const [x, z] of [
    [320, 320],
    [960, 320],
    [320, 960],
    [960, 960],
  ] as const) {
    await place(BASEPLATE_32, x, z);
  }
  await place(RECESSED_ROAD_PLATE, 640, 640);
  await chosen(editor, RECESSED_ROAD_PLATE);
  const flush = [
    [960, 640],
    [320, 640],
    [640, 960],
    [640, 320],
  ] as const;
  const outcomes = [];
  for (const [x, z] of flush) {
    const normalX = Math.sign(x - 640);
    const normalZ = Math.sign(z - 640);
    for (const step of [-STUD, STUD]) {
      outcomes.push(
        await settledAt(editor, backend, frame, x + normalX * step, z + normalZ * step),
      );
    }
  }
  expect(outcomes).toEqual(
    flush.flatMap(([x, z]) => [
      { pose: [x, z], snap: "snapped" },
      { pose: [x, z], snap: "snapped" },
    ]),
  );
}, 120_000);

async function settledBesideAnOverhang(onBaseplate: boolean) {
  const { editor, backend, frame } = await startEditor([]);
  if (onBaseplate) await placer(editor, backend)(BASEPLATE_32, 320, 320);
  await placer(editor, backend)(RECESSED_ROAD_PLATE, 720, 320);
  await chosen(editor, RECESSED_ROAD_PLATE);
  return settledAt(editor, backend, frame, 660, 660);
}

it("never road-snaps a plate to a clean join that would mate fewer studs than where the assist settled, and does on the bare table", async () => {
  expect(await settledBesideAnOverhang(true)).toEqual({ pose: [660, 660], snap: "free" });
  expect(await settledBesideAnOverhang(false)).toEqual({ pose: [720, 640], snap: "snapped" });
}, 120_000);

it("never road-snaps a road module across laid track: a hover clear of the rails stays at the cursor where the flush join would cross them", async () => {
  const module = "generated:mils-road-straight";
  const { editor, backend, frame, catalog } = await startEditor(["mils-road-straight"]);
  await loadCatalogItem(catalog, module);
  await placer(editor, backend)(module, 320, 320);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [780, -320], [780, 960]);
  expect(editor.snapshot().track?.pieces).toBeGreaterThan(0);
  await chosen(editor, module);
  expect(await settledAt(editor, backend, frame, 1260, 320)).toEqual({
    pose: [1260, 320],
    snap: "free",
  });
  editor.setPlacementMode("precise");
  expect(await settledAt(editor, backend, frame, 960, 320)).toMatchObject({ pose: [960, 320] });
  expect(editor.snapshot().hover?.refusal).toMatch(/would cross the track laid there/u);
}, 120_000);

it("keeps a road-snapped plate where it snapped while the cursor jitters within its stud, starting no new search", async () => {
  const { editor, backend, frame, container } = await startEditor([]);
  await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 320);
  await chosen(editor, RECESSED_ROAD_PLATE);
  expect(await settledAt(editor, backend, frame, 650, 320)).toEqual({
    pose: [640, 320],
    snap: "snapped",
  });
  const begin = vi.spyOn(container.get(PLACEMENT_SEARCH), "begin");
  for (const x of [655, 661, 662]) {
    backend.aim(x, 320);
    editor.pointerMove(0, 0);
    const pose = editor.snapshot().hover?.placement?.pose;
    expect({ pose: pose && [pose.x, pose.z], snap: editor.snapshot().snap?.state }).toEqual({
      pose: [640, 320],
      snap: "snapped",
    });
  }
  expect(begin).not.toHaveBeenCalled();
}, 120_000);

it.each([
  ["the placement mode", (editor: IEditor) => editor.setPlacementMode("precise")],
  ["the held precise override", (editor: IEditor) => editor.setPlacementModeOverride(true)],
] as const)(
  "switching to precise through %s after a road snap shows the cursor's pose, and the click takes it",
  async (_, toPrecise) => {
    const { editor, backend, frame } = await startEditor([]);
    await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 320);
    await chosen(editor, RECESSED_ROAD_PLATE);
    expect(await settledAt(editor, backend, frame, 660, 320)).toEqual({
      pose: [640, 320],
      snap: "snapped",
    });
    toPrecise(editor);
    const hover = await settledHover(editor, frame);
    const pose = hover?.placement?.pose;
    editor.click(0, 0, 0);
    expect({
      shown: pose && [pose.x, pose.z],
      snap: editor.snapshot().snap?.state,
      placed: placedXs(editor),
    }).toEqual({ shown: [660, 320], snap: "free", placed: [320, 660] });
  },
  120_000,
);

it("a road-snapped plate whose pointer leaves the canvas and comes back to the same stud snaps again, and the click places it there", async () => {
  const { editor, backend, frame } = await startEditor([]);
  await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 320);
  await chosen(editor, RECESSED_ROAD_PLATE);
  expect(await settledAt(editor, backend, frame, 660, 320)).toEqual({
    pose: [640, 320],
    snap: "snapped",
  });
  editor.pointerLeave();
  expect(await settledAt(editor, backend, frame, 662, 320)).toEqual({
    pose: [640, 320],
    snap: "snapped",
  });
  editor.click(0, 0, 0);
  expect({ placed: placedXs(editor), refused: editor.snapshot().refusedClicks }).toEqual({
    placed: [320, 640],
    refused: 0,
  });
}, 120_000);

it("turning road snap off after a snap shows the cursor's pose, and the click takes it", async () => {
  const { editor, backend, frame } = await startEditor([]);
  await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 320);
  await chosen(editor, RECESSED_ROAD_PLATE);
  expect(await settledAt(editor, backend, frame, 660, 320)).toEqual({
    pose: [640, 320],
    snap: "snapped",
  });
  editor.setSnapRoads(false);
  const pose = (await settledHover(editor, frame))?.placement?.pose;
  editor.click(0, 0, 0);
  expect({ shown: pose && [pose.x, pose.z], placed: placedXs(editor) }).toEqual({
    shown: [660, 320],
    placed: [320, 660],
  });
}, 120_000);

it("never pulls or turns a road plate in precise mode: a hover just clear of a road end stays at the cursor", async () => {
  const { editor, backend, frame } = await startEditor([]);
  await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 320);
  await chosen(editor, RECESSED_ROAD_PLATE);
  editor.setPlacementMode("precise");
  expect(await settledAt(editor, backend, frame, 660, 320)).toEqual({
    pose: [660, 320],
    snap: "free",
  });
}, 120_000);

it.each([
  { mode: "assist", landsAt: 640 },
  { mode: "precise", landsAt: 660 },
] as const)(
  "drags a road plate a stud short of another's road end in $mode mode, and road snap follows the mode: it lands at $landsAt",
  async ({ mode, landsAt }) => {
    const { editor, backend } = await startEditor([]);
    await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 320);
    await placer(editor, backend)(RECESSED_ROAD_PLATE, 1300, 320);
    editor.setPlacementMode(mode);
    expect(selectAt(editor, backend, 1300, 320)?.item).toBe(RECESSED_ROAD_PLATE);
    dragGroup(editor, backend, [1300, 320], [660, 320]);
    expect(placedXs(editor)).toEqual([320, landsAt]);
  },
  120_000,
);

it("never road-snaps a dragged road plate into a user's brick standing at the flush pose: it lands where it was dropped", async () => {
  const { editor, backend } = await startImportingEditor();
  const place = placer(editor, backend);
  await place(RECESSED_ROAD_PLATE, 320, 320);
  const brick = userRoadFile("my-brick.ldr", ["1 4 0 0 0 0 0 1 0 1 0 -1 0 0 3001.dat"]);
  const brickItem = await importUserFile(editor, "my-brick.ldr", brick);
  await place(brickItem, 500, 320);
  await place(RECESSED_ROAD_PLATE, 1300, 320);
  editor.chooseItem(null);
  expect(posesOf(editor)).toEqual(
    [
      `${brickItem} 500,320 y0`,
      `${RECESSED_ROAD_PLATE} 320,320 y0`,
      `${RECESSED_ROAD_PLATE} 1300,320 y0`,
    ].toSorted(),
  );
  expect(selectAt(editor, backend, 1300, 320)?.item).toBe(RECESSED_ROAD_PLATE);
  dragGroup(editor, backend, [1300, 320], [680, 320]);
  expect(placedXs(editor)).toEqual([320, 500, 680]);
}, 120_000);

function startConnectingEditor() {
  return startEditor([], new BundleDirectoryFetcher(), [], (bound) => {
    const loader = bound.get(PART_BUNDLE_LOADER);
    const records = { read: (partId: string) => loader.readPartConnectors("standard", partId) };
    bound.rebind(MODEL_IMPORTER).toConstantValue(new InThreadModelImporter(loader, records));
  });
}

const OBSTACLES = [
  {
    obstacle: "stack of three 2×4 bricks",
    lines: [0, -24, -48].map((y) => `1 4 0 ${y} 0 0 0 1 0 1 0 -1 0 0 3001.dat`),
    at: [500, 320],
  },
  {
    obstacle: "1×6×5 brick",
    lines: ["1 4 0 0 0 0 0 1 0 1 0 -1 0 0 3754.dat"],
    at: [510, 320],
  },
] as const;

it.each(
  OBSTACLES.flatMap((entry) => [
    { ...entry, surface: "the bare table", onBaseplate: false },
    { ...entry, surface: "a user's own baseplate", onBaseplate: true },
  ]),
)(
  "road snap never moves a held plate into a non-road model, though the join would keep its joints: a user's $obstacle beside the flush pose, on $surface",
  async ({ lines, at: [x, z], onBaseplate }) => {
    const { editor, backend, frame } = await startConnectingEditor();
    const place = placer(editor, backend);
    if (onBaseplate) {
      const baseplate = userRoadFile("my-baseplate.ldr", ["1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat"]);
      await place(await importUserFile(editor, "my-baseplate.ldr", baseplate), 320, 320);
    }
    await place(RECESSED_ROAD_PLATE, 320, 320);
    const obstacle = await importUserFile(
      editor,
      "my-obstacle.ldr",
      userRoadFile("my-obstacle.ldr", lines),
    );
    await chosen(editor, RECESSED_ROAD_PLATE);
    const withoutObstacle = await settledAt(editor, backend, frame, 680, 320);
    await place(obstacle, x, z);
    await chosen(editor, RECESSED_ROAD_PLATE);
    const settled = await settledAt(editor, backend, frame, 680, 320);
    const joints = editor.snapshot().hover?.placement?.joints ?? 0;
    expect({ withoutObstacle, withObstacle: settled, mated: joints > 0 }).toEqual({
      withoutObstacle: { pose: [640, 320], snap: "snapped" },
      withObstacle: { pose: [680, 320], snap: expect.not.stringMatching(/^snapped$/u) },
      mated: onBaseplate,
    });
  },
  120_000,
);

it("road snap checks a join at the height the held plate rests at: beside a road plate on a user's raised platform, it snaps flush on the platform", async () => {
  const { editor, backend, frame } = await startConnectingEditor();
  const place = placer(editor, backend);
  const legs = [-280, 280].flatMap((x) =>
    [-280, 280].map((z) => `1 4 ${x} 0 ${z} 1 0 0 0 1 0 0 0 1 3001.dat`),
  );
  const platform = userRoadFile("my-platform.ldr", [
    "1 2 0 -8 0 1 0 0 0 1 0 0 0 1 3811.dat",
    ...legs,
  ]);
  await place(await importUserFile(editor, "my-platform.ldr", platform), 320, 320);
  await place(RECESSED_ROAD_PLATE, 160, 320);
  const { refs, placements } = editor.dump();
  const roadPlateRow = placements.refId.findIndex((ref) => refs[ref] === RECESSED_ROAD_PLATE);
  const platformTop = placements.yPlates[roadPlateRow];
  await chosen(editor, RECESSED_ROAD_PLATE);
  const outcomes = [];
  for (const x of [500, 520]) {
    const settled = await settledAt(editor, backend, frame, x, 320);
    outcomes.push({ ...settled, yPlates: editor.snapshot().hover?.placement?.pose.yPlates });
  }
  expect(platformTop).toBeGreaterThan(0);
  expect(outcomes).toEqual(
    [500, 520].map(() => ({ pose: [480, 320], snap: "snapped", yPlates: platformTop })),
  );
}, 120_000);

it("road snap never moves a held plate beside a placement still reading its connectors, and snaps there once they load", async () => {
  const gate = heldPartConnectivity("44336p04");
  const { editor, backend, frame } = await startEditor([], gate);
  await placer(editor, backend)(RECESSED_ROAD_PLATE, 320, 160);
  roadStrokeResult(editor, backend, [320, -320], [960, -320]);
  await chosen(editor, RECESSED_ROAD_PLATE);
  const hovered = async () => {
    const settled = await settledAt(editor, backend, frame, 660, 260);
    return { ...settled, waitingOn: editor.snapshot().hover?.placement?.waitingOn ?? null };
  };
  const whileReading = await hovered();
  await vi.waitFor(() => expect(gate.held).toBe(1));
  gate.open();
  await vi.waitFor(async () => {
    await settledAt(editor, backend, frame, 1280, 1280);
    expect(await hovered()).toEqual({ pose: [640, 160], snap: "snapped", waitingOn: null });
  });
  expect(whileReading).toEqual({ pose: [660, 260], snap: "free", waitingOn: null });
}, 120_000);

it.each([
  {
    surface: "a user's own baseplate",
    onBaseplate: true,
    settles: { pose: [660, 660], snap: "free" },
  },
  {
    surface: "the bare table",
    onBaseplate: false,
    settles: { pose: [720, 640], snap: "snapped" },
  },
] as const)(
  "road snap never moves a held user's road plate to a join mating fewer studs than where the assist settled, and does where it settled with none: on $surface",
  async ({ onBaseplate, settles }) => {
    const { editor, backend, frame } = await startConnectingEditor();
    const place = placer(editor, backend);
    if (onBaseplate) {
      const baseplate = userRoadFile("my-baseplate.ldr", ["1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat"]);
      await place(await importUserFile(editor, "my-baseplate.ldr", baseplate), 320, 320);
    }
    const road = userRoadFile("my-road-plate.ldr", ["1 72 0 0 0 1 0 0 0 1 0 0 0 1 69958.dat"]);
    const roadPlate = await importUserFile(editor, "my-road-plate.ldr", road);
    await place(roadPlate, 720, 320);
    await chosen(editor, roadPlate);
    expect(await settledAt(editor, backend, frame, 660, 660)).toEqual(settles);
  },
  120_000,
);

it.each([
  { baseplateZ: 320, landsAt: 160 },
  { baseplateZ: -20, landsAt: 140 },
])(
  "road-snaps a pasted or dragged road plate on baseplates only where the join mates at least the studs it had: baseplate at z $baseplateZ, lands at z $landsAt",
  async ({ baseplateZ, landsAt }) => {
    const { editor, backend } = await startEditor([]);
    const place = placer(editor, backend);
    await place(BASEPLATE_32, 320, 320);
    await place(BASEPLATE_32, 960, baseplateZ);
    await place(BASEPLATE_32, 960, 1600);
    await place(RECESSED_ROAD_PLATE, 480, 160);
    await place(RECESSED_ROAD_PLATE, 800, 1600);
    const roadPlates = () => posesOf(editor).filter((pose) => pose.startsWith(RECESSED_ROAD_PLATE));
    const onBaseplate = (x: number, z: number) => `${RECESSED_ROAD_PLATE} ${x},${z} y0`;
    expect(roadPlates()).toEqual([onBaseplate(480, 160), onBaseplate(800, 1600)]);
    editor.chooseItem(null);
    expect(selectAt(editor, backend, 800, 1600)?.item).toBe(RECESSED_ROAD_PLATE);
    editor.copySelection();
    editor.pasteClipboard();
    backend.aim(800, 140);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    const pasted = roadPlates();
    editor.undo(0);
    expect(selectAt(editor, backend, 800, 1600)?.item).toBe(RECESSED_ROAD_PLATE);
    dragGroup(editor, backend, [800, 1600], [800, 140]);
    expect({ pasted, dragged: roadPlates() }).toEqual({
      pasted: [onBaseplate(480, 160), onBaseplate(800, 1600), onBaseplate(800, landsAt)].toSorted(),
      dragged: [onBaseplate(480, 160), onBaseplate(800, landsAt)].toSorted(),
    });
  },
  120_000,
);

const L_OF_ROAD_PLATES = [
  [320, 320],
  [960, 320],
  [320, 960],
] as const;

async function cornerOfAnL(oneFile: boolean) {
  const { editor, backend, frame } = await startImportingEditor();
  const place = placer(editor, backend);
  if (oneFile) {
    const plates = L_OF_ROAD_PLATES.map(
      ([x, z]) => `1 72 ${x - 320} 0 ${320 - z} 1 0 0 0 1 0 0 0 1 44336p04.dat`,
    );
    const file = userRoadFile("l-of-road-plates.ldr", plates);
    await place(await importUserFile(editor, "l-of-road-plates.ldr", file), 640, 640);
  } else {
    for (const [x, z] of L_OF_ROAD_PLATES) await place("ldraw:44336p04@72", x, z);
  }
  await chosen(editor, "ldraw:44336p04@72");
  const hover = await settledAt(editor, backend, frame, 980, 980);
  const { joinedCells, mismatchedCells } = editor.snapshot().snap ?? {};
  editor.click(0, 0, 0);
  const { refusedClicks, roads } = editor.snapshot();
  return {
    hover,
    joinedCells,
    mismatchedCells,
    refusedClicks,
    mismatchedAfter: roads.mismatchedCells,
  };
}

it("road-snaps a plate into the empty corner of an L of road plates alike whether the L is one user's file or three plates", async () => {
  const threePlates = await cornerOfAnL(false);
  expect(threePlates).toMatchObject({
    hover: { pose: [960, 960], snap: "snapped" },
    mismatchedCells: 0,
  });
  expect(threePlates.joinedCells).toBeGreaterThan(0);
  expect(await cornerOfAnL(true)).toEqual(threePlates);
}, 240_000);

function roadStrokeResult(
  editor: IEditor,
  backend: AimedBackend,
  from: Ground,
  to: Ground,
  erase = false,
) {
  const kit = editor.snapshot().roadKits.find((k) => k.label.startsWith("Dark Bluish Grey"));
  if (!kit) throw new Error("no Dark Bluish Grey road kit");
  editor.chooseItem(kit.id);
  editor.setRoadErase(erase);
  backend.aim(...from);
  editor.dragStart(0, 0);
  backend.aim(...to);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
  const { lastRoadStroke } = editor.snapshot();
  editor.chooseItem(null);
  return lastRoadStroke?.result ?? null;
}

const towerAt = (x: number, z: number) =>
  [-24, -48, -72].map((y) => `1 4 ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 3005.dat`);

async function strokedToBothEnds(oneFile: boolean) {
  const { editor, backend } = await startImportingEditor();
  const place = placer(editor, backend);
  if (oneFile) {
    const both = userRoadFile("road-and-tower.ldr", [
      "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336.dat",
      ...towerAt(630, 630),
    ]);
    await place(await importUserFile(editor, "road-and-tower.ldr", both), 320, 320);
  } else {
    const road = userRoadFile("road.ldr", ["1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336.dat"]);
    await place(await importUserFile(editor, "road.ldr", road), 320, 320);
    const tower = userRoadFile("tower.ldr", towerAt(10, 10));
    await place(await importUserFile(editor, "tower.ldr", tower), 940, -300);
  }
  const laid = {
    strokes: [
      roadStrokeResult(editor, backend, [1600, -320], [960, -320]),
      roadStrokeResult(editor, backend, [320, -960], [320, -320]),
      roadStrokeResult(editor, backend, [320, 1600], [320, 960]),
    ],
  };
  const { joinedCells, mismatchedCells, overlaps } = editor.snapshot().roads;
  return {
    ...laid,
    joinedCells,
    mismatchedCells,
    overlaps,
    roadPlacements: editor.dump().roadPlacements.length,
  };
}

it("lays road to a user's road end alike whether a tower beside it is in the same file or its own, since only the bricks themselves block a stroke", async () => {
  const twoFiles = await strokedToBothEnds(false);
  expect(twoFiles).toEqual({
    strokes: ["refused", "laid", "laid"],
    joinedCells: expect.any(Number),
    mismatchedCells: 0,
    overlaps: 0,
    roadPlacements: 5,
  });
  expect(twoFiles.joinedCells).toBeGreaterThan(0);
  expect(await strokedToBothEnds(true)).toEqual(twoFiles);
}, 120_000);

it("continues a stroke that starts on a user's own road plate as it would from the palette's, and refuses one that would have to change the user's plate", async () => {
  const { editor, backend } = await startImportingEditor();
  const place = placer(editor, backend);
  const plate = userRoadFile("my-road-plate.ldr", ["1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336.dat"]);
  await place(await importUserFile(editor, "my-road-plate.ldr", plate), 320, 320);
  const along = roadStrokeResult(editor, backend, [320, 320], [320, 1600]);
  const placedAlong = editor.dump().roadPlacements.length;
  const across = roadStrokeResult(editor, backend, [320, 320], [1600, 320]);
  const { roads, lastRoadStroke } = editor.snapshot();
  const { mismatchedCells, overlaps } = roads;

  expect({
    along,
    placedAlong,
    across,
    acrossBlockers: lastRoadStroke?.stroke.issues.map((issue) => issue.blocker),
    placedAcross: editor.dump().roadPlacements.length,
    mismatchedCells,
    overlaps,
  }).toEqual({
    along: "laid",
    placedAlong: 3,
    across: "refused",
    acrossBlockers: ["my-road-plate.ldr"],
    placedAcross: 3,
    mismatchedCells: 0,
    overlaps: 0,
  });
}, 120_000);

const TILE_LDU = 640;
const ROAD_ROW_XS = [-2240, -1600, -960, -320, 320, 960];
const ROAD_ROW_Z = -320;
const BESIDE_ROAD_Z = -960;
const OFF_PLATE_GRID_X = -900;

async function roadRowAlongX(editor: IEditor, backend: AimedBackend): Promise<void> {
  await chosen(editor, "ldraw:44336p04@72");
  editor.rotate(0, 1);
  for (const x of ROAD_ROW_XS) {
    backend.aim(x, ROAD_ROW_Z);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
  }
  editor.chooseItem(null);
}

async function heldBesideRoad(
  editor: IEditor,
  backend: AimedBackend,
  frame: () => Promise<void>,
  item: string,
  x: number,
) {
  await chosen(editor, item);
  backend.aim(x, BESIDE_ROAD_Z);
  editor.pointerMove(0, 0);
  await settledHover(editor, frame);
  const { snap, hover } = editor.snapshot();
  return { snap: snap?.state, x: hover?.placement?.pose.x, refusal: hover?.refusal ?? null };
}

it("road-snaps buildings beside a road where the cursor holds them, so Market Street sits flush against the Pet Shop though its overhang puts its footprint's centre a stud off its pose", async () => {
  const { editor, backend, frame, catalog } = await startEditor(["10218-1", "10190-1"]);
  await roadRowAlongX(editor, backend);
  await loadCatalogItem(catalog, "omr:10218-1");
  await loadCatalogItem(catalog, "omr:10190-1");
  const petShop = await heldBesideRoad(editor, backend, frame, "omr:10218-1", -960);
  editor.click(0, 0, 0);
  const flush = (petShop.x ?? 0) + TILE_LDU;
  const market = await heldBesideRoad(editor, backend, frame, "omr:10190-1", flush);

  expect({ petShop, market }).toEqual({
    petShop: { snap: "snapped", x: -960, refusal: null },
    market: { snap: "snapped", x: flush, refusal: null },
  });
}, 120_000);

it("road-snaps a user's road plate with a brick hanging off one edge to the pose under the cursor, between the road plates' corners", async () => {
  const { editor, backend, frame } = await startImportingEditor();
  await roadRowAlongX(editor, backend);
  const plate = userRoadFile("my-awning-plate.ldr", [
    "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336p04.dat",
    "1 4 0 -24 320 0 0 1 0 1 0 -1 0 0 3001.dat",
  ]);
  const item = await importUserFile(editor, "my-awning-plate.ldr", plate);

  expect(await heldBesideRoad(editor, backend, frame, item, OFF_PLATE_GRID_X)).toEqual({
    snap: "snapped",
    x: OFF_PLATE_GRID_X,
    refusal: null,
  });
}, 120_000);

it("lays road to a user's street of a road plate, a grass baseplate and a parked car with a tile roof: the road joins, the grass edge refuses nothing and the car overlaps nothing", async () => {
  const { editor, backend } = await startImportingEditor();
  const street = userRoadFile("my-street-with-grass.ldr", [
    "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336p01.dat",
    "1 2 640 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 0 -32 0 1 0 0 0 1 0 0 0 1 87079.dat",
  ]);
  const place = placer(editor, backend);
  await place(await importUserFile(editor, "my-street-with-grass.ldr", street), 640, 320);
  expect(roadStrokeResult(editor, backend, [320, -1600], [320, -320])).toBe("laid");
  await place("ldraw:44336p04@72", 1600, 320);
  expect(editor.snapshot()).toMatchObject({
    placements: 5,
    refusedClicks: 0,
    roads: { joinedCells: 3 * 32, mismatchedCells: 0, overlaps: 0 },
  });
}, 120_000);

it("draws road across a user's own baseplate model, swapping it for road, and erasing that road gives the model back where it was", async () => {
  const { editor, backend } = await startImportingEditor();
  const baseplate = userRoadFile("my-baseplate.ldr", ["1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat"]);
  const item = await importUserFile(editor, "my-baseplate.ldr", baseplate);
  await placer(editor, backend)(item, 320, 320);
  const laidOut = posesOf(editor);
  expect(laidOut).toEqual([`${item} 320,320 y0`]);
  expect(roadStrokeResult(editor, backend, [320, 320], [1600, 320])).toBe("laid");
  expect({
    overGround: editor.snapshot().lastRoadStroke?.stroke.overGround,
    userModel: posesOf(editor).filter((pose) => pose.startsWith(item)),
    roadTiles: editor.dump().roadPlacements.length,
  }).toEqual({ overGround: 1, userModel: [], roadTiles: 3 });
  expect(roadStrokeResult(editor, backend, [320, 320], [1600, 320], true)).toBe("laid");
  expect(posesOf(editor)).toEqual(laidOut);
}, 120_000);

it.each(["320", "319.9999", "320.0001"])(
  "lays road past a user's brick column whose box edge, at %s LDU in the file, identifies to the stroke tile's edge",
  async (edge) => {
    const { editor, backend } = await startImportingEditor();
    const column = Number(edge) + 10;
    const street = userRoadFile("my-road-and-column.ldr", [
      "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336.dat",
      `1 4 ${column} -24 650 1 0 0 0 1 0 0 0 1 3005.dat`,
    ]);
    await placer(editor, backend)(
      await importUserFile(editor, "my-road-and-column.ldr", street),
      320,
      320,
    );
    expect(roadStrokeResult(editor, backend, [320, -1600], [320, -320])).toBe("laid");
    expect(editor.snapshot().roads).toMatchObject({ mismatchedCells: 0, overlaps: 0 });
  },
  120_000,
);

const PLATE_ON_BASEPLATE = [
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
  "1 72 -160 -16 160 1 0 0 0 1 0 0 0 1 69958.dat",
];

async function roadEndsOfAPlateOnABaseplate(oneFile: boolean) {
  const { editor, backend, frame } = await startImportingEditor();
  const place = placer(editor, backend);
  if (oneFile) {
    const scene = userRoadFile("my-corner.ldr", PLATE_ON_BASEPLATE);
    await place(await importUserFile(editor, "my-corner.ldr", scene), 320, 320);
  } else {
    const [baseplateLine = "", plateLine = ""] = PLATE_ON_BASEPLATE;
    const baseplate = userRoadFile("my-baseplate.ldr", [baseplateLine]);
    await place(await importUserFile(editor, "my-baseplate.ldr", baseplate), 320, 320);
    const plate = userRoadFile("my-road-plate.ldr", [plateLine.replace("-160 -16 160", "0 0 0")]);
    await place(await importUserFile(editor, "my-road-plate.ldr", plate), 160, 160);
  }
  const ends = editor.snapshot().roads.issues.filter((issue) => issue.status === "open");
  await chosen(editor, "ldraw:69958@72");
  const outcomes = [];
  for (const end of ends) {
    const middle = (end.from + end.to) / 2;
    const outward = end.side.startsWith("max") ? 1 : -1;
    const acrossX = end.side.endsWith("X");
    const flush = end.line + outward * 160;
    const short = flush + outward * STUD;
    const [x, z] = acrossX ? [short, middle] : [middle, short];
    outcomes.push({
      end: `${end.side} ${end.line}`,
      ...(await settledAt(editor, backend, frame, x, z)),
    });
  }
  return outcomes;
}

it("road-snaps a plate to each road end of a user's road plate on their own baseplate alike in one file or two, ends facing the baseplate included", async () => {
  const twoFiles = await roadEndsOfAPlateOnABaseplate(false);
  expect(twoFiles).toHaveLength(4);
  expect(twoFiles.every((outcome) => outcome.snap === "snapped")).toBe(true);
  expect(await roadEndsOfAPlateOnABaseplate(true)).toEqual(twoFiles);
}, 240_000);

it("refuses a road stroke over a user's car with a tile roof, by the car's own part boxes", async () => {
  const { editor, backend } = await startImportingEditor();
  const car = userRoadFile("my-car.ldr", [
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 0 -24 0 1 0 0 0 1 0 0 0 1 87079.dat",
  ]);
  await placer(editor, backend)(await importUserFile(editor, "my-car.ldr", car), 640, 300);
  const placed = () => editor.dump().placements.x.length;
  expect(roadStrokeResult(editor, backend, [320, 320], [1600, 320])).toBe("refused");
  expect(placed()).toBe(1);
  expect(roadStrokeResult(editor, backend, [320, 960], [1600, 960])).toBe("laid");
  expect(placed()).toBe(4);
}, 120_000);

it("places a user's car with a tile roof on a road and a road under a user's car alike, in either order", async () => {
  const car = userRoadFile("my-car.ldr", [
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 0 -24 0 1 0 0 0 1 0 0 0 1 87079.dat",
  ]);
  const placedInOrder = async (carFirst: boolean) => {
    const { editor, backend } = await startImportingEditor();
    const item = await importUserFile(editor, "my-car.ldr", car);
    const place = placer(editor, backend);
    const steps = [() => place(item, 100, 100), () => place("ldraw:44336p04@72", 320, 320)];
    for (const step of carFirst ? steps : steps.toReversed()) await step();
    const { placements, refusedClicks, roads } = editor.snapshot();
    return { placements, refusedClicks, overlaps: roads.overlaps };
  };
  const roadFirst = await placedInOrder(false);
  expect(roadFirst).toEqual({ placements: 2, refusedClicks: 0, overlaps: 0 });
  expect(await placedInOrder(true)).toEqual(roadFirst);
}, 120_000);

async function besideTheLevelCrossing() {
  const crossing = "omr:10128-1";
  const { editor, backend, frame, catalog } = await startEditor(["10128-1"]);
  await loadCatalogItem(catalog, crossing);
  await placer(editor, backend)(crossing, 100, 100);
  await chosen(editor, "ldraw:44336p04@72");
  editor.rotate(0);
  return { editor, backend, frame };
}

it("joins a road plate to the level-crossing set's road end: road snap brings an accepted hover clear of the set to the flush join, and the click places it (#150)", async () => {
  const { editor, backend, frame } = await besideTheLevelCrossing();
  expect(await settledAt(editor, backend, frame, -640, 300)).toEqual({
    pose: [-540, 260],
    snap: "snapped",
  });
  expect(editor.snapshot().snap).toMatchObject({ joinedCells: 29, mismatchedCells: 0 });
  editor.click(0, 0, 0);
  expect(editor.snapshot()).toMatchObject({
    placements: 2,
    refusedClicks: 0,
    roads: { joinedCells: 29, mismatchedCells: 0, overlaps: 0 },
  });
}, 240_000);

it("draws road into the level-crossing set's road end with the road tool, joining the set's own road exactly (#150)", async () => {
  const { editor, backend, catalog } = await startEditor(["10128-1"]);
  await loadCatalogItem(catalog, "omr:10128-1");
  await placer(editor, backend)("omr:10128-1", 320, 160);
  editor.chooseItem(null);
  expect(roadStrokeResult(editor, backend, [-1600, 320], [-320, 320])).toBe("laid");
  expect(editor.snapshot()).toMatchObject({
    placements: 4,
    roads: { joinedCells: 29 + 2 * 32, mismatchedCells: 0, overlaps: 0 },
  });
}, 240_000);

const HITS_THE_SET = /would overlap Baseplate 32 x 32 Road .*'s bounds in 10128-1 /u;

it.each([-300, -400])(
  "never road-snaps a road plate off a refusal: aimed at x %i into the level-crossing set, the hover and the click stay refused at the cursor, naming the set's baseplate",
  async (x) => {
    const { editor, backend, frame } = await besideTheLevelCrossing();
    expect(await settledAt(editor, backend, frame, x, 300)).toEqual({
      pose: [x, 300],
      snap: "refused",
    });
    expect(editor.snapshot().hover?.refusal).toMatch(HITS_THE_SET);
    editor.click(0, 0, 0);
    expect(editor.snapshot()).toMatchObject({
      placements: 1,
      refusedClicks: 1,
      lastRefusal: { reason: expect.stringMatching(HITS_THE_SET) },
    });
  },
  240_000,
);

it("never road-snaps a dragged road plate off a refusal: dragged into the level-crossing set, it stays where it was", async () => {
  const { editor, backend } = await besideTheLevelCrossing();
  backend.aim(-1600, 300);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  editor.chooseItem(null);
  const laid = posesOf(editor);
  expect(selectAt(editor, backend, -1600, 300)?.item).toBe("ldraw:44336p04@72");
  const dragged = dragGroup(editor, backend, [-1600, 300], [-400, 300]);
  expect(dragged.gesture).toMatchObject({
    kind: "move",
    refusal: expect.stringMatching(HITS_THE_SET),
  });
  expect(posesOf(editor)).toEqual(laid);
}, 240_000);

it("reads a road plate held over a placed road plate of another thickness as refused, as the click is", async () => {
  const { editor, backend } = await startEditor([]);
  await placer(editor, backend)("ldraw:69958@72", 320, 320);
  await chosen(editor, "ldraw:44336p04@72");
  backend.aim(320, 320);
  editor.pointerMove(0, 0);
  expect(editor.snapshot().snap).toMatchObject({ state: "refused", overlappingCells: 256 });
  editor.click(0, 0, 0);
  expect(editor.snapshot()).toMatchObject({
    placements: 1,
    lastRefusal: { overlappingCells: 256 },
  });
}, 120_000);

it.each([
  { held: "ldraw:44336p04@72", refused: true },
  { held: "ldraw:69958@72", refused: false },
] as const)(
  "with $held held over a road baseplate, click, fill and move agree: refused when its road would rest in the baseplate's road cells at the same height, accepted when it stacks above them",
  async ({ held, refused }) => {
    const baseplate = "ldraw:44336p04@72";
    const withBaseplate = async () => {
      const started = await startEditor([]);
      await placer(started.editor, started.backend)(baseplate, 320, 320);
      return started;
    };

    const clicking = await withBaseplate();
    const clicked = await placer(clicking.editor, clicking.backend)(held, 320, 320);

    const hovering = await withBaseplate();
    await chosen(hovering.editor, held);
    hovering.backend.aim(320, 320);
    hovering.editor.pointerMove(0, 0);
    const hover = hovering.editor.snapshot().hover;
    const hovered = hover?.placement?.accepted === true && hover.refusal === null;

    const filling = await withBaseplate();
    await chosen(filling.editor, held);
    filling.editor.cycleFillGrid();
    filling.editor.cycleFillGrid();
    dragFill(filling.editor, filling.backend, [160, 160], [480, 480]);

    const moving = await withBaseplate();
    await placer(moving.editor, moving.backend)(held, 1600, 320);
    expect(selectAt(moving.editor, moving.backend, 1600, 320)?.item).toBe(held);
    moving.editor.moveSelectionTo(16, 16, 0);

    expect({
      hovered,
      clicked: clicked.placements,
      filled: filling.editor.snapshot().placements,
      moved: placedXs(moving.editor),
    }).toEqual(
      refused
        ? { hovered: false, clicked: 1, filled: 1, moved: [320, 1600] }
        : { hovered: true, clicked: 2, filled: 2, moved: [320, 320] },
    );
  },
  120_000,
);

function userRoadFile(name: string, parts: ReadonlyArray<string>): Uint8Array {
  return new TextEncoder().encode(
    [
      `0 ${name}, a user's own model`,
      `0 Name: ${name}`,
      "0 Author: lug-layout test",
      `0 !LICENSE ${CC_BY_4}`,
      ...parts,
      "",
    ].join("\n"),
  );
}

it("sets a user's own tile into the slot through a user's own road model, where the model's box would have refused it, and its road joins the slot's sides", async () => {
  const { editor, backend } = await startImportingEditor();
  const slotted = await importUserFile(
    editor,
    "my-slotted-road.ldr",
    userRoadFile("my-slotted-road.ldr", [
      "1 71 -40 0 -20 1 0 0 0 1 0 0 0 1 3068b.dat",
      "1 71 40 0 -20 1 0 0 0 1 0 0 0 1 3068b.dat",
      "1 71 -40 0 20 1 0 0 0 1 0 0 0 1 3022.dat",
      "1 71 40 0 20 1 0 0 0 1 0 0 0 1 3022.dat",
    ]),
  );
  const tile = await importUserFile(
    editor,
    "my-tile-and-plate.ldr",
    userRoadFile("my-tile-and-plate.ldr", [
      "1 71 0 0 -20 1 0 0 0 1 0 0 0 1 3068b.dat",
      "1 71 0 0 20 1 0 0 0 1 0 0 0 1 3022.dat",
    ]),
  );
  await placer(editor, backend)(slotted, 320, 320);
  const before = editor.snapshot().roads;
  const set = await placer(editor, backend)(tile, 320, 320);
  expect(set).toMatchObject({ placements: 2, refusedClicks: 0 });
  expect(before).toMatchObject({ joinedCells: 0, mismatchedCells: 0 });
  expect(editor.snapshot().roads).toMatchObject({
    joinedCells: 8,
    mismatchedCells: 0,
    overlaps: 0,
  });
}, 120_000);

it("fills a user's own road model with unlike ends in a row: every tile places, and the plan reports where the ends mismatch", async () => {
  const { editor, backend } = await startImportingEditor();
  const unlike = await importUserFile(
    editor,
    "my-unlike-ends.ldr",
    userRoadFile("my-unlike-ends.ldr", [
      "1 71 -60 0 0 0 0 1 0 1 0 -1 0 0 87079.dat",
      "1 71 -20 0 0 0 0 1 0 1 0 -1 0 0 87079.dat",
      "1 71 20 0 0 0 0 1 0 1 0 -1 0 0 87079.dat",
      "1 71 60 0 0 1 0 0 0 1 0 0 0 1 3068b.dat",
      "1 71 60 0 -30 1 0 0 0 1 0 0 0 1 3023.dat",
      "1 71 60 0 30 1 0 0 0 1 0 0 0 1 3023.dat",
    ]),
  );
  await chosen(editor, unlike);
  dragFill(editor, backend, [320, 320], [880, 320]);
  expect(editor.snapshot().lastFill).toMatchObject({ placed: 4, refused: 0, reason: null });
  expect(editor.snapshot().roads).toMatchObject({ joinedCells: 3 * 2, mismatchedCells: 3 * 2 });
}, 120_000);

function placedXs(editor: IEditor): ReadonlyArray<number> {
  return Array.from(editor.dump().placements.x).toSorted((a, b) => a - b);
}

it.each([false, true])(
  "a road curve held at a road straight's open end keeps its turn until R, which turns it only to the turns that fit, and the click lays the turn the ghost shows (assist settling over many frames: %s)",
  async (slow) => {
    const { editor, backend, frame } = await startEditor([]);
    await chosen(editor, "ldraw:44336p04@72");
    backend.aim(320, 320);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    await chosen(editor, "ldraw:44342p02@72");
    const clock = slow ? slowClock() : null;
    backend.aim(320, 960);
    editor.pointerMove(0, 0);
    await settledHover(editor, frame);
    const shown = () => {
      const { ghostRot, snap } = editor.snapshot();
      return { ghostRot, fit: snap?.state === "snapped" ? ghostRot : null };
    };
    expect(shown().ghostRot).toBe(0);
    for (const direction of [1, -1] as const) {
      const turns = [];
      for (let press = 0; press < 4; press++) {
        editor.rotate(0, direction);
        await settledHover(editor, frame);
        const turned = shown();
        editor.pointerMove(0, 0);
        await settledHover(editor, frame);
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
    clock?.mockRestore();
    const { placements } = editor.dump();
    expect(placements.rot.at(-1)).toBe(shownRot);
  },
  120_000,
);

function selectAt(editor: IEditor, backend: AimedBackend, x: number, z: number) {
  editor.chooseItem(null);
  backend.aim(x, z);
  editor.click(0, 0, 0);
  return editor.snapshot().selection?.primary ?? null;
}

function turnOutcome(editor: IEditor, direction: 1 | -1) {
  editor.rotate(0, direction);
  const { selection, selectionRefusal, lastRefusal } = editor.snapshot();
  return {
    rot: selection?.primary.kind === "model" ? selection.primary.rot : null,
    yPlates: selection?.primary.kind === "model" ? selection.primary.yPlates : null,
    refusal: selectionRefusal,
    roadCells: lastRefusal ? lastRefusal.mismatchedCells + lastRefusal.overlappingCells : null,
  };
}

it("refuses to turn a module while a set lifted onto it rests on it, turns the set itself, and turns the module once the set is gone", async () => {
  const { editor, backend, catalog } = await startEditor([PLAIN_MODULE_MODEL, PLACEABLE_SET]);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await place(SET, 320, 320);
  const corner = 20;

  expect(selectAt(editor, backend, corner, corner)?.item).toBe(PLAIN_MODULE);
  const moduleUnderSet = turnOutcome(editor, 1);
  const moduleUnderSetBack = turnOutcome(editor, -1);
  const setSelection = selectAt(editor, backend, 320, 320);
  expect(setSelection?.item).toBe(SET);
  const setYPlates = setSelection?.kind === "model" ? setSelection.yPlates : null;
  const setOnModule = turnOutcome(editor, -1);
  editor.deleteSelection(0);
  expect(selectAt(editor, backend, corner, corner)?.item).toBe(PLAIN_MODULE);
  const bareModule = turnOutcome(editor, -1);

  const refused = {
    rot: 0,
    yPlates: 0,
    refusal: expect.stringContaining(`${PLACEABLE_SET} Level Crossing (2010) rests on it`),
    roadCells: 0,
  };
  expect(setYPlates).toBeGreaterThan(0);
  expect({ moduleUnderSet, moduleUnderSetBack, setOnModule, bareModule }).toEqual({
    moduleUnderSet: refused,
    moduleUnderSetBack: refused,
    setOnModule: { rot: 3, yPlates: setYPlates, refusal: null, roadCells: 0 },
    bareModule: { rot: 3, yPlates: 0, refusal: null, roadCells: 0 },
  });
}, 120_000);

it("turns a placed road plate into a mismatch with its neighbour without refusing it, and the readout and the plan's road join rule report the mismatch", async () => {
  const { editor, backend, container } = await startEditor([]);
  const plans = container.get(PLAN_SERVICE);
  const planId = oneTableRoom(plans);
  const straight = "ldraw:44336p04@72";
  await placer(editor, backend)(DUAL_CARRIAGEWAY, 320, 320);
  await chosen(editor, straight);
  editor.rotate(0, 1);
  backend.aim(320, 960);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0));
  const joinedFirst = {
    mismatchedCells: editor.snapshot().roads.mismatchedCells,
    roadJoin: plans.issues(planId).filter((issue) => issue.rule === "roadJoin").length,
  };

  expect(selectAt(editor, backend, 320, 960)?.item).toBe(straight);
  const turned = turnOutcome(editor, 1);
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0));
  const roadJoin = plans.issues(planId).filter((issue) => issue.rule === "roadJoin");

  expect(joinedFirst).toEqual({ mismatchedCells: 0, roadJoin: 0 });
  expect(turned).toEqual({ rot: 2, yPlates: 0, refusal: null, roadCells: null });
  expect(editor.snapshot().roads.mismatchedCells).toBeGreaterThan(0);
  expect(roadJoin.length).toBeGreaterThan(0);
  expect(roadJoin.every((issue) => issue.severity === "error")).toBe(true);
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
  "nudge-right",
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
  const held = { poses: posesOf(editor), turns: turnsOf(editor) };
  editor.moveSelectionTo(40, 0, 0);
  editor.turnSelectedModelTo(2, 0);
  expect({ poses: posesOf(editor), turns: turnsOf(editor) }).toEqual(held);

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

function drawnChunks(backend: HeadlessBackend): string {
  return [...backend.chunks]
    .toSorted(([a], [b]) => a - b)
    .map(([key, chunk]) => {
      const parts = [...chunk.partIndex.subarray(0, chunk.count)].map((i) => backend.partIds[i]);
      const poses = [...chunk.matrices.subarray(0, chunk.count * INSTANCE_MATRIX_FLOATS)].map(
        (value) => value.toFixed(3),
      );
      return `${key}:${parts.join(",")}:${poses.join(",")}`;
    })
    .join("|");
}

function dragTrack(
  editor: IEditor,
  backend: AimedBackend,
  from: readonly [number, number],
  to: readonly [number, number],
): void {
  backend.aim(...from);
  editor.pointerMove(0, 0);
  expect(editor.dragStart(0, 0)).toBe(true);
  backend.aim(...to);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
}

function layoutState(editor: IEditor) {
  const { refs, placements, laidTrack } = editor.dump();
  const poses = placements.refId
    .map(
      (ref, i) =>
        `${refs[ref]} ${placements.x[i]} ${placements.z[i]} ${placements.yPlates[i]} ${placements.rot[i]}`,
    )
    .toSorted();
  const track = editor.snapshot().track;
  return { poses, laidTrack, openEnds: track?.openEnds, joins: track?.joins };
}

const HALF_TURN_CURVES = 8;
const ROAD_STRAIGHT = "ldraw:44336p04@72";
const RIGHT_SWITCH = "ldraw:75541-f1";
const NINE_VOLT_CURVE = "ldraw:74747";

const NINE_VOLT_STRAIGHT = "ldraw:74746";

it("selects a laid track piece by clicking it and deletes it as one step that undo restores and re-selects", async () => {
  const { editor, backend } = await startEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-24 * STUD, 0], [24 * STUD, 0]);
  const laid = layoutState(editor);

  const picked = selectAt(editor, backend, 0, 0);
  const cleared = selectAt(editor, backend, 0, 40 * STUD);
  selectAt(editor, backend, 0, 0);
  editor.deleteSelection(0);
  const deleted = layoutState(editor);
  const afterDelete = editor.snapshot();
  editor.undo(0);
  const restored = layoutState(editor);
  const reselected = editor.snapshot().selection?.primary ?? null;
  editor.redo(0);

  expect(picked).toMatchObject({
    kind: "track",
    item: `${TRACK_PIECE_PREFIX}${NINE_VOLT_STRAIGHT}`,
  });
  expect(cleared).toBeNull();
  expect({
    pieces: deleted.laidTrack.length,
    openEnds: deleted.openEnds,
    joins: deleted.joins,
    selection: afterDelete.selection,
    undo: afterDelete.history.undoLabel,
  }).toEqual({
    pieces: laid.laidTrack.length - 1,
    openEnds: (laid.openEnds ?? 0) + 2,
    joins: (laid.joins ?? 0) - 2,
    selection: null,
    undo: "delete",
  });
  expect(restored).toEqual(laid);
  expect(reselected).toEqual(picked);
  expect(layoutState(editor)).toEqual(deleted);
});

it("undoes and redoes model and track edits in the order they happened, each track gesture one step named by what it laid", async () => {
  const { editor, backend } = await startEditor([]);
  const place = placer(editor, backend);
  const states = [layoutState(editor)];
  const labels: Array<string | null> = [];
  const record = () => {
    states.push(layoutState(editor));
    labels.push(editor.snapshot().history.undoLabel);
  };

  await place(BASEPLATE, 0, 0);
  record();
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  record();
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${NINE_VOLT_CURVE}`);
  backend.aim(16 * STUD, 0);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  const heldCommit = editor.snapshot().track?.lastCommit;
  record();
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [51 * STUD, 100 * STUD], [99 * STUD, 100 * STUD]);
  record();
  dragTrack(editor, backend, [163 * STUD, 100 * STUD], [211 * STUD, 100 * STUD]);
  record();
  dragTrack(editor, backend, [99 * STUD, 100 * STUD], [163 * STUD, 100 * STUD]);
  const closureCommit = editor.snapshot().track?.lastCommit;
  record();
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
  backend.aim(0, 200 * STUD);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  record();
  const lever = editor.snapshot().track?.switches[0];
  if (!lever) throw new Error("the laid switch has no lever");
  const drawnBeforeThrow = drawnChunks(backend);
  selectAt(editor, backend, lever.xLdu, lever.zLdu);
  const drawnAfterThrow = drawnChunks(backend);
  record();
  await place(BASEPLATE, 64 * STUD, 0);
  record();
  let drawnAfterUndoingThrow = "";

  expect({ heldCommit, closureCommit }).toEqual({ heldCommit: "joined", closureCommit: "joined" });
  expect(labels).toEqual([
    "place",
    "lay 2 pieces",
    "lay 1 piece",
    "lay 3 pieces",
    "lay 3 pieces",
    "lay 4 pieces",
    "lay 1 piece",
    "throw switch",
    "place",
  ]);
  expect(states.map((state) => [state.poses.length, state.laidTrack.length])).toEqual([
    [0, 0],
    [1, 0],
    [1, 2],
    [1, 3],
    [1, 6],
    [1, 9],
    [1, 13],
    [1, 14],
    [1, 14],
    [2, 14],
  ]);
  expect(states[8]?.laidTrack).not.toEqual(states[7]?.laidTrack);

  for (let step = states.length - 1; step > 0; step--) {
    editor.undo(0);
    if (labels[step - 1] === "throw switch") drawnAfterUndoingThrow = drawnChunks(backend);
    expect(layoutState(editor), `after undoing edit ${step}`).toEqual(states[step - 1]);
  }
  expect(drawnAfterThrow).not.toBe(drawnBeforeThrow);
  expect(drawnAfterUndoingThrow).toBe(drawnBeforeThrow);
  expect(editor.snapshot().history.undo).toBeNull();
  for (let step = 1; step < states.length; step++) {
    expect(editor.snapshot().history.redoLabel).toBe(labels[step - 1]);
    editor.redo(0);
    expect(layoutState(editor), `after redoing edit ${step}`).toEqual(states[step]);
  }
  expect(editor.snapshot().history.redo).toBeNull();
}, 120_000);

function trackRowsOf(delta: PlanDelta) {
  const removed: number[] = [];
  const added: number[] = [];
  const updated: number[] = [];
  for (let k = 0; k < delta.removalCount; k++) {
    if (delta.removalSegment[k] === TRACK_SEGMENT) removed.push(delta.removalSource[k] ?? -1);
  }
  for (let e = 0; e < delta.writeCount; e++) {
    if (delta.writeSegment[e] !== TRACK_SEGMENT) continue;
    (delta.writeKind[e] === WRITE_ADD ? added : updated).push(delta.writeSource[e] ?? -1);
  }
  return { removed, added, updated };
}

function pieceRange(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

function trackRows(added: number[], removed: number[] = [], updated: number[] = []) {
  return { deltas: [{ removed, added, updated }] };
}

it("sends the plan each track step's rows and saves its lifted pieces, on commit, undo and redo alike", async () => {
  const { editor, backend, container } = await startEditor([]);
  const plans = container.get(PLAN_SERVICE);
  const session = container.get(WORLD_SESSION);
  const apply = plans.apply.bind(plans);
  let applied: Array<ReturnType<typeof trackRowsOf>> = [];
  vi.spyOn(plans, "apply").mockImplementation((delta) => {
    applied.push(trackRowsOf(delta));
    apply(delta);
  });
  const trackEdited = vi.spyOn(session, "trackEdited");
  const setTrack = vi.spyOn(container.get(RAIL_YARD), "setTrack");
  const step = (act: () => void) => {
    applied = [];
    trackEdited.mockClear();
    setTrack.mockClear();
    act();
    return {
      deltas: applied,
      lifted: trackEdited.mock.calls.map(([lifted]) => lifted.map((piece) => piece.index)),
      railsSet: setTrack.mock.calls.length,
    };
  };

  await placer(editor, backend)(BASEPLATE, 0, 0);
  plans.createPlan({
    name: "Room",
    roomWidthMm: 4000,
    roomDepthMm: 4000,
    originChunkX: -2,
    originChunkZ: -2,
  });
  const plansAt = [plans.materialize()];
  const drawnBeforeTrack = drawnChunks(backend);
  let drawnFirstLay = "";
  let drawnFirstLayUndone = "";
  let drawnFirstLayRedone = "";
  const gestures: Array<() => void> = [
    () => {
      editor.chooseItem(TRACK_ITEM_ID);
      dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
    },
    () => {
      editor.chooseItem(`${TRACK_PIECE_PREFIX}${NINE_VOLT_CURVE}`);
      backend.aim(16 * STUD, 0);
      editor.pointerMove(0, 0);
      editor.click(0, 0, 0);
    },
    () => {
      editor.chooseItem(TRACK_ITEM_ID);
      dragTrack(editor, backend, [51 * STUD, 100 * STUD], [99 * STUD, 100 * STUD]);
    },
    () => dragTrack(editor, backend, [163 * STUD, 100 * STUD], [211 * STUD, 100 * STUD]),
    () => dragTrack(editor, backend, [99 * STUD, 100 * STUD], [163 * STUD, 100 * STUD]),
    () => {
      editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
      backend.aim(0, 200 * STUD);
      editor.pointerMove(0, 0);
      editor.click(0, 0, 0);
    },
    () => {
      const lever = editor.snapshot().track?.switches[0];
      if (!lever) throw new Error("the laid switch has no lever");
      selectAt(editor, backend, lever.xLdu, lever.zLdu);
    },
  ];
  const committed = gestures.map((gesture, i) => {
    const seen = step(gesture);
    if (i === 0) drawnFirstLay = drawnChunks(backend);
    plansAt.push(plans.materialize());
    return seen;
  });
  const undone = gestures.map((_, i) => {
    const seen = step(() => editor.undo(0));
    if (i === gestures.length - 1) drawnFirstLayUndone = drawnChunks(backend);
    expect(plans.materialize(), `plan after undoing step ${gestures.length - i}`).toEqual(
      plansAt[gestures.length - i - 1],
    );
    return seen;
  });
  const redone = gestures.map((_, i) => {
    const seen = step(() => editor.redo(0));
    if (i === 0) drawnFirstLayRedone = drawnChunks(backend);
    expect(plans.materialize(), `plan after redoing step ${i + 1}`).toEqual(plansAt[i + 1]);
    return seen;
  });

  const laidRows = [
    pieceRange(0, 2),
    [2],
    pieceRange(3, 6),
    pieceRange(6, 9),
    pieceRange(9, 13),
    [13],
  ];
  expect(committed).toEqual([
    ...laidRows.map((added) => ({ ...trackRows(added), lifted: [[]], railsSet: 1 })),
    { ...trackRows([], [], [13]), lifted: [[13]], railsSet: 1 },
  ]);
  expect(undone).toEqual([
    { ...trackRows([], [], [13]), lifted: [[13]], railsSet: 1 },
    ...laidRows
      .toReversed()
      .map((removed) => ({ ...trackRows([], removed), lifted: [removed], railsSet: 1 })),
  ]);
  expect(redone).toEqual(committed);
  expect(drawnFirstLay).not.toBe(drawnBeforeTrack);
  expect({ undone: drawnFirstLayUndone, redone: drawnFirstLayRedone }).toEqual({
    undone: drawnBeforeTrack,
    redone: drawnFirstLay,
  });
  expect(plansAt.at(-1)?.placements).toHaveLength(15);
  expect(
    plansAt.map(
      (plan) => plan.checks[0]?.issues.filter((issue) => issue.rule === "trackOpenEnd").length,
    ),
  ).toEqual([0, 2, 2, 4, 6, 4, 7, 7]);
}, 120_000);

const STRAIGHT_53401_LDU = 320;
const CROSSING_RUN_LDU = 3 * STRAIGHT_53401_LDU;
const LONE_STRAIGHT_AT_LDU = { x: 320, z: 300 } as const;
const LDU_PER_MM = 5 / 2;
const PLAN_POSITION = /\((-?\d+) mm, (-?\d+) mm\)/u;

function endPositionsLdu(
  messages: ReadonlyArray<string>,
): ReadonlyArray<readonly [number, number]> {
  return messages.map((message) => {
    const match = PLAN_POSITION.exec(message);
    if (!match) throw new Error(`no plan position in "${message}"`);
    return [Number(match[1]) * LDU_PER_MM, Number(match[2]) * LDU_PER_MM] as const;
  });
}

function runsAlongZ(ends: ReadonlyArray<readonly [number, number]>) {
  const byX = Map.groupBy(ends, ([x]) => x);
  return [...byX]
    .map(([x, run]) => {
      const zs = run.map(([, z]) => z);
      return {
        x,
        ends: run.length,
        lengthLdu: Math.max(...zs) - Math.min(...zs),
        midZ: (Math.max(...zs) + Math.min(...zs)) / 2,
      };
    })
    .toSorted((a, b) => a.lengthLdu - b.lengthLdu);
}

it("lists a placed set's own open track ends in the plan where its file puts them, telling listeners once per place, undo and redo", async () => {
  const { editor, backend, container, catalog } = await startEditor([PLACEABLE_SET]);
  const plans = container.get(PLAN_SERVICE);
  const set = `omr:${PLACEABLE_SET}`;
  await loadCatalogItem(catalog, set);
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: 4000,
    roomDepthMm: 4000,
    originChunkX: -2,
    originChunkZ: -2,
  });
  const rows = () =>
    plans
      .issues(planId)
      .filter((issue) => issue.rule === "trackOpenEnd")
      .map((issue) => issue.message);
  const seen: Array<ReadonlyArray<string>> = [];
  plans.subscribe(() => seen.push(rows()));
  await placer(editor, backend)(set, 0, 0);
  const placed = rows();
  editor.undo(0);
  editor.redo(0);
  const [lone, crossing] = runsAlongZ(endPositionsLdu(placed));

  expect([lone, crossing].map((run) => [run?.ends, run?.lengthLdu])).toEqual([
    [2, STRAIGHT_53401_LDU],
    [2, CROSSING_RUN_LDU],
  ]);
  expect(Math.abs((lone?.x ?? 0) - (crossing?.x ?? 0))).toBe(LONE_STRAIGHT_AT_LDU.x);
  expect(Math.abs((lone?.midZ ?? 0) - (crossing?.midZ ?? 0))).toBe(LONE_STRAIGHT_AT_LDU.z);
  for (const message of placed) expect(message).toContain(` on ${PLACEABLE_SET} `);
  expect(seen).toEqual([placed, [], placed]);
}, 120_000);

it("refuses to throw a switch a train stands on, whether the throw comes from a click, an undo or a redo", async () => {
  const { editor, backend, container, catalog } = await startEditor([LOCOMOTIVE.slice(4)]);
  const yard = container.get(RAIL_YARD);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
  backend.aim(0, 0);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  editor.chooseItem(TRACK_ITEM_ID);
  for (const heading of [0, ZETA16_ORDER / 2]) {
    const end = editor.dump().trackEnds.find((open) => open.heading === heading);
    if (!end) throw new Error(`the switch has no end at heading ${heading}`);
    const from = [onLattice(end.xLdu), onLattice(end.zLdu)] as const;
    const away = heading === 0 ? 1 : -1;
    dragTrack(editor, backend, from, [from[0] + away * 128 * STUD, from[1]]);
  }
  const lever = () => editor.snapshot().track?.switches[0];
  const at = lever();
  if (!at) throw new Error("the laid switch has no lever");
  const outcome = () => ({
    lever: lever()?.lever,
    undoDepth: editor.snapshot().history.undoDepth,
    redoDepth: editor.snapshot().history.redoDepth,
    refusal: editor.snapshot().lastRefusal?.reason ?? null,
    refusals: editor.snapshot().refusedClicks,
  });
  const clickSwitch = () => {
    editor.chooseItem(TRACK_ITEM_ID);
    backend.aim(at.xLdu, at.zLdu);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    editor.dragEnd(0, 0, 0);
  };
  clickSwitch();
  const thrown = outcome();
  await placer(editor, backend)(LOCOMOTIVE, Math.round(at.xLdu), Math.round(at.zLdu));
  const train = yard.trains()[0]?.handle;
  if (!train || yard.standingOn(at.placement) !== train) {
    throw new Error("the locomotive does not stand on the switch");
  }
  clickSwitch();
  const clicked = outcome();
  editor.undo(0);
  const trainLifted = outcome();
  const standingOn = yard.standingOn.bind(yard);
  const stillStanding = vi
    .spyOn(yard, "standingOn")
    .mockImplementation((placement) =>
      placement === at.placement ? train : standingOn(placement),
    );
  editor.undo(0);
  const undoRefused = outcome();
  stillStanding.mockRestore();
  editor.undo(0);
  const undone = outcome();
  vi.spyOn(yard, "standingOn").mockImplementation((placement) =>
    placement === at.placement ? train : standingOn(placement),
  );
  editor.redo(0);
  const redoRefused = outcome();

  const refusal = expect.stringContaining("stands on this switch, so it can't be thrown under it");
  expect({ thrown, clicked, trainLifted, undoRefused, undone, redoRefused }).toEqual({
    thrown: { lever: "branching", undoDepth: 4, redoDepth: 0, refusal: null, refusals: 0 },
    clicked: { lever: "branching", undoDepth: 5, redoDepth: 0, refusal, refusals: 1 },
    trainLifted: { lever: "branching", undoDepth: 4, redoDepth: 1, refusal, refusals: 1 },
    undoRefused: { lever: "branching", undoDepth: 4, redoDepth: 1, refusal, refusals: 2 },
    undone: { lever: "straight", undoDepth: 3, redoDepth: 2, refusal, refusals: 2 },
    redoRefused: { lever: "straight", undoDepth: 3, redoDepth: 2, refusal, refusals: 3 },
  });
}, 120_000);

it("lays each piece added to an open end, and the join that closes the loop, as one undo step each", async () => {
  const { editor, backend, container } = await startEditor([]);
  const camera = container.get(EDITOR_CAMERA);
  const pieces = () => editor.dump().laidTrack.length;
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-32 * STUD, 0], [32 * STUD, 0]);
  const continuing = editor.snapshot().track?.extend?.continuing;
  const turns: ReadonlyArray<ExtensionTurn> = [
    ...Array<ExtensionTurn>(HALF_TURN_CURVES).fill("left"),
    ...Array<ExtensionTurn>(4).fill("straight"),
    ...Array<ExtensionTurn>(HALF_TURN_CURVES / 2).fill("left"),
  ];
  const laid = [pieces()];
  const labels: Array<string | null> = [];
  for (const turn of [...turns, null]) {
    editor.extendTrack(turn, 0);
    laid.push(pieces());
    labels.push(editor.snapshot().history.undoLabel);
  }
  const closed = editor.snapshot().track;

  expect(continuing).toBe(true);
  expect(laid).toEqual([...turns.map((_, i) => 4 + i), 4 + turns.length, 8 + turns.length]);
  expect(labels).toEqual([...turns.map(() => "lay 1 piece"), "lay 4 pieces"]);
  expect(closed).toMatchObject({ lastCommit: "joined", openEnds: 0, extend: null });
  expect(closed?.joins).toBe(laid.at(-1));
  for (let step = laid.length - 1; step > 0; step--) {
    editor.undo(0);
    expect(pieces(), `after undoing step ${step}`).toBe(laid[step - 1]);
  }

  backend.aim(32 * STUD, 0);
  editor.pointerMove(0, 0);
  const hovered = editor.snapshot().track?.extend?.continuing;
  editor.extendTrack("straight", 0);
  runEditorAction(editor, camera, "select-tool", 0);
  const afterFirstEscape = editor.snapshot();
  runEditorAction(editor, camera, "select-tool", 0);
  expect(hovered).toBe(false);
  expect(afterFirstEscape.mode).toBe("track");
  expect(afterFirstEscape.track?.extend).toBeNull();
  expect(editor.snapshot().mode).toBe("select");
}, 120_000);

it("keeps the end pointed at while a choice is picked off the canvas, and lays the choice picked", async () => {
  const { editor, backend } = await startEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  const dropped = editor.dropTrackEnd();
  backend.aim(16 * STUD, 0);
  editor.pointerMove(0, 0);
  editor.pointerLeave();
  const offered = editor.snapshot().track?.extend?.choices ?? [];
  const right = offered.findIndex((choice) => choice.kind === "right");
  editor.selectTrackChoice(right);
  const picked = editor.snapshot().track?.extend?.index;
  editor.extendTrack(null, 0);

  expect(dropped).toBe(true);
  expect(picked).toBe(right);
  expect(editor.dump().laidTrack.at(-1)?.ref).toBe(NINE_VOLT_CURVE);
  expect(editor.snapshot().track?.extend?.continuing).toBe(true);
}, 120_000);

const A_KEY = { key: "a", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

function aState(editor: IEditor, play?: PlaySnapshot) {
  const acts = (id: CommandId): boolean => commandEnabled(id, editor.snapshot(), play);
  const match = commandForKey(A_KEY, false, acts);
  return {
    does: match && acts(match.id) ? match.id : null,
    switchEnabled: placementModeSwitchEnabled(editor.snapshot(), play),
    extends: acts("extend-left"),
  };
}

it("gives A to the placement mode wherever its switch is enabled, except at an open track end, where it lays a left curve, and to nothing while a train runs", async () => {
  const { editor, backend, container } = await startEditor([]);
  const running: PlaySnapshot = { ...container.get(TRAIN_PLAY).snapshot(), status: "running" };
  const selecting = aState(editor);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  editor.dropTrackEnd();
  backend.aim(0, 40 * STUD);
  editor.pointerMove(0, 0);
  const awayFromEnd = aState(editor);
  backend.aim(16 * STUD, 0);
  editor.pointerMove(0, 0);
  const atOpenEnd = aState(editor);
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${NINE_VOLT_STRAIGHT}`);
  backend.aim(16 * STUD, 0);
  editor.pointerMove(0, 0);
  const pieceAtEnd = aState(editor);
  await chosen(editor, BASEPLATE);
  const placing = aState(editor);
  const trainRunning = aState(editor, running);

  const toggles = { does: "toggle-placement-mode", switchEnabled: true, extends: false };
  expect({ selecting, awayFromEnd, atOpenEnd, pieceAtEnd, placing, trainRunning }).toEqual({
    selecting: toggles,
    awayFromEnd: toggles,
    atOpenEnd: { does: "extend-left", switchEnabled: true, extends: true },
    pieceAtEnd: toggles,
    placing: toggles,
    trainRunning: { does: null, switchEnabled: false, extends: false },
  });
}, 120_000);

it("lets go of a held switch on Esc and keeps drawing track from its open end, and leaves the tool on the next Esc", async () => {
  const { editor, backend, container } = await startEditor([]);
  const camera = container.get(EDITOR_CAMERA);
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
  backend.aim(0, 0);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  const holding = editor.snapshot().track?.held != null;
  runEditorAction(editor, camera, "select-tool", 0);
  const letGo = { mode: editor.snapshot().mode, held: editor.snapshot().track?.held ?? null };
  const [end] = editor.dump().trackEnds;
  if (!end) throw new Error("the laid switch has no open end");
  backend.aim(end.xLdu, end.zLdu);
  editor.pointerMove(0, 0);
  editor.extendTrack("straight", 0);
  const extended = editor.dump().laidTrack.length;
  runEditorAction(editor, camera, "select-tool", 0);
  runEditorAction(editor, camera, "select-tool", 0);

  expect({ holding, letGo, extended, left: editor.snapshot().mode }).toEqual({
    holding: true,
    letGo: { mode: "track", held: null },
    extended: 2,
    left: "select",
  });
}, 120_000);

it("selects nothing on a laid piece clicked in the track tool, leaves the tool on one Esc with nothing to let go of, and extends an open end clicked there", async () => {
  const { editor, backend, container } = await startEditor([]);
  const camera = container.get(EDITOR_CAMERA);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  editor.dropTrackEnd();
  const clickAt = (x: number, z: number) => {
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    editor.dragEnd(0, 0, 0);
  };
  clickAt(-8 * STUD, 0);
  const clickedLaid = { mode: editor.snapshot().mode, selection: editor.snapshot().selection };
  runEditorAction(editor, camera, "select-tool", 0);
  const escaped = { mode: editor.snapshot().mode, selection: editor.snapshot().selection };
  editor.chooseItem(TRACK_ITEM_ID);
  const laidBefore = editor.dump().laidTrack.length;
  clickAt(16 * STUD, 0);

  expect(clickedLaid).toEqual({ mode: "track", selection: null });
  expect(escaped).toEqual({ mode: "select", selection: null });
  expect(editor.dump().laidTrack).toHaveLength(laidBefore + 1);
  expect(editor.snapshot().history.undoLabel).toBe("lay 1 piece");
}, 120_000);

it("lays a piece onto a road plate's roadway, reports it unsupported, and says why", async () => {
  const { editor, backend } = await startEditor([]);
  await placer(editor, backend)(ROAD_STRAIGHT, 0, 0);
  await supportChecked(editor);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [0, -48 * STUD], [0, -16 * STUD]);
  const laid = editor.dump().laidTrack.length;

  editor.extendTrack("straight", 0);
  const onRoadway = {
    laid: editor.dump().laidTrack.length,
    hud: toolHints(editor.snapshot()),
    unsupported: editor.snapshot().track?.unsupported,
  };
  backend.aim(0, -48 * STUD);
  editor.pointerMove(0, 0);
  editor.extendTrack("straight", 0);

  expect(onRoadway).toEqual({
    laid: laid + 1,
    hud: expect.objectContaining({
      tone: "warn",
      title: "Laid unsupported",
      detail: expect.stringMatching(
        /^1 piece rests on .+ where it has no studs, so it isn't supported$/u,
      ),
    }),
    unsupported: 1,
  });
  expect(editor.snapshot().history.undoLabel).toBe("lay 1 piece");
  expect(editor.dump().laidTrack).toHaveLength(laid + 2);
}, 120_000);

it("saves the world without a track run once it is undone, and with it again once it is redone", async () => {
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
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });

  await placer(editor, backend)(BASEPLATE, 0, 0);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  const laid = editor.dump().laidTrack.length;
  expect(laid).toBe(2);
  await vi.waitFor(() => expect(repository.storedTrack()).toBe(laid));
  editor.undo(0);
  await vi.waitFor(() => expect(repository.storedTrack()).toBe(0));
  expect(repository.storedPlacements()).toBe(1);
  editor.redo(0);
  await vi.waitFor(() => expect(repository.storedTrack()).toBe(laid));
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
    shadowLibrary: null,
    timings: {
      readMs: 0,
      resolveMs: 0,
      bakeMs: 0,
      totalMs: 0,
      placementMs: 0,
      recordFetchMs: 0,
      compileMs: 0,
      ldrawFetchMs: 0,
      shadowFetchMs: 0,
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

function importedRecord(
  fileName: string,
  record: ModelRecord,
  connectors: ReadonlyArray<PartConnectors | null> = record.parts.map(() => null),
): ImportResult {
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
    connectors: [...connectors],
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
    (bound) => bound.rebind(MODEL_IMPORTER).toConstantValue(importer),
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
  const play = container.get(TRAIN_PLAY);
  const playAttempt = () => {
    startPlay(editor, play);
    return play.snapshot().status === "idle" ? "waits" : "starts";
  };
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
      play: playAttempt(),
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
    play: "starts",
  });
  expect(drawnPending - (editor.snapshot().studs?.drawn ?? 0)).toBe(2 * covered);
  expect(posesOf(editor)).toEqual(posesPending);
}, 120_000);

async function checkingImport(
  fetcher: IAssetFetcher = new BundleDirectoryFetcher(),
  served = PLACEABLE_SET,
  models: ReadonlyArray<string> = [],
  bringsRecords = false,
) {
  const importer = new GatedModelImporter();
  const started = await startEditor(models, fetcher, [], (bound) =>
    bound.rebind(MODEL_IMPORTER).toConstantValue(importer),
  );
  const { container, editor } = started;
  const loader = container.get(PART_BUNDLE_LOADER);
  const record = await loader.loadModelRecord("standard", served);
  const connectors = bringsRecords
    ? await Promise.all(record.parts.map((part) => loader.loadPartConnectors("standard", part.id)))
    : undefined;
  importer.serve(importedRecord("checking.mpd", record, connectors));
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

it("keeps an imported train's bake and train model through its stud check", async () => {
  const { editor, importer, importedPlaceable, catalog } = await checkingImport(
    new BundleDirectoryFetcher(),
    "10205-1",
  );
  await importChecking(editor);
  const pending = importedPlaceable();
  if (!pending) throw new Error("the import was not announced");
  const whileChecking = { bake: catalog.baked(pending), train: catalog.playModel(pending) };
  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  const checked = importedPlaceable();
  if (!checked) throw new Error("the import left the catalog");

  expect(checked).not.toBe(pending);
  expect(whileChecking.train).not.toBeNull();
  expect({ bake: catalog.baked(checked), train: catalog.playModel(checked) }).toEqual(
    whileChecking,
  );
}, 120_000);

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

const IMPORTED_COPY = "imported copy";

function oneTableRoom(plans: IPlanService): string {
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: 3200,
    roomDepthMm: 1100,
    originChunkX: -4,
    originChunkZ: -2,
  });
  plans.addTable(planId, {
    name: "Table",
    rect: { x: 0, z: 0, width: 2000, depth: 1100 },
    heightMm: 750,
  });
  return planId;
}

function planQueries(plans: IPlanService, planId: string) {
  return {
    state: plans.materialize(),
    plans: plans.plans(),
    activePlanId: plans.activePlanId(),
    tableTopY: plans.tableTopY(),
    region: plans.regionView(planId),
    inside: plans.insideCount(planId),
    issueCount: plans.issueCount(planId),
    issues: plans.issues(planId),
    tallies: [
      plans.joinedRoadCells(planId),
      plans.unmeasuredCount(planId),
      plans.customParts(planId),
    ],
    sandbox: plans.sandboxCount(),
    placements: plans.placementCount(),
  };
}

async function placedOnceChecked(layout: ReadonlyArray<readonly [string, number]>) {
  const { editor, backend, container, importer } = await checkingImport();
  importer.release();
  const item = await importChecking(editor);
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  const plans = container.get(PLAN_SERVICE);
  const planId = oneTableRoom(plans);
  const place = placer(editor, backend);
  for (const [id, x] of layout) await place(id === IMPORTED_COPY ? item : id, x, 0);
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0));
  return planQueries(plans, planId);
}

it("keeps the plan equal to today's recompute when the checked studs land, with the copies listed where they were placed", async () => {
  const west = [BASEPLATE, -2_000] as const;
  const near = [IMPORTED_COPY, 0] as const;
  const middle = [BASEPLATE, 2_000] as const;
  const far = [IMPORTED_COPY, 4_000] as const;
  const east = [BASEPLATE, 6_000] as const;
  const recomputed = {
    landed: await placedOnceChecked([west, near, middle, far, east]),
    undone: await placedOnceChecked([west, near, middle, far]),
    undoneTwice: await placedOnceChecked([west, near, middle]),
  };
  const { editor, backend, container, importer } = await checkingImport();
  const item = await importChecking(editor);
  const plans = container.get(PLAN_SERVICE);
  const planId = oneTableRoom(plans);
  const place = placer(editor, backend);
  const refused: number[] = [];
  for (const [id, x] of [west, near, middle, far, east]) {
    refused.push((await place(id === IMPORTED_COPY ? item : id, x, 0)).refusedClicks);
  }
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0));
  const [plateWest, copyNear, plateMiddle, copyFar, plateEast] = plans.materialize().placements;
  const observed = () => ({
    listed: plans.materialize().placements,
    queries: planQueries(plans, planId),
  });
  const pending = planQueries(plans, planId);
  expect(refused).toEqual([0, 0, 0, 0, 0]);
  expect({
    inside: pending.inside,
    issues: Object.groupBy(pending.issues, (issue) => issue.rule),
    sandbox: pending.sandbox,
  }).toEqual({
    inside: 4,
    issues: {
      bomMapping: [expect.anything(), expect.anything()],
      fit: [expect.objectContaining({ placements: [copyFar?.key] })],
      trackOffTable: [
        expect.objectContaining({ placements: [copyFar?.key], entirelyOffTables: true }),
      ],
      trackOpenEnd: Array.from({ length: 8 }, () => expect.anything()),
    },
    sandbox: 1,
  });

  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  expect(observed()).toEqual({
    listed: [plateWest, copyNear, plateMiddle, copyFar, plateEast],
    queries: recomputed.landed,
  });
  editor.undo(0);
  expect(observed()).toEqual({
    listed: [plateWest, copyNear, plateMiddle, copyFar],
    queries: recomputed.undone,
  });
  editor.undo(0);
  expect(observed()).toEqual({
    listed: [plateWest, copyNear, plateMiddle],
    queries: recomputed.undoneTwice,
  });
  editor.redo(0);
  expect(observed()).toEqual({
    listed: [plateWest, copyNear, plateMiddle, copyFar],
    queries: recomputed.undone,
  });
}, 120_000);

it("resolves clicks queued while the held item's tables load, over an import whose studs are being checked, exactly as clicks made once they have loaded, refusal included", async () => {
  const outcome = async (queued: boolean) => {
    const gate = heldPartConnectivity("44336p01");
    const { editor, backend } = await checkingImport(gate);
    const item = await importChecking(editor);
    await placer(editor, backend)(item, 0, 0);
    let atClick: EditorSnapshot["queuedPlacement"] = null;
    if (queued) {
      placerNow(editor, backend)(ROAD_PLATE, 0, 0);
      atClick = editor.snapshot().queuedPlacement;
      gate.open();
      await settledChoice(editor);
    } else {
      gate.open();
      await placer(editor, backend)(ROAD_PLATE, 0, 0);
    }
    await placer(editor, backend)(BASEPLATE, OPEN_TABLE_X, 0);
    const { placements, refusedClicks, lastRefusal, studChecks, queuedPlacement } =
      editor.snapshot();
    return {
      atClick,
      settled: {
        placements,
        refusedClicks,
        reason: lastRefusal?.reason ?? null,
        studChecks,
        queuedPlacement,
        poses: posesOf(editor),
      },
    };
  };

  const [queued, direct] = [await outcome(true), await outcome(false)];

  expect(queued).toEqual({
    atClick: expect.objectContaining({ item: ROAD_PLATE }),
    settled: direct.settled,
  });
  expect(queued.settled).toMatchObject({
    placements: 2,
    refusedClicks: 1,
    studChecks: 1,
    queuedPlacement: null,
  });
  expect(queued.settled.poses).toContain(`${BASEPLATE} ${OPEN_TABLE_X},0 y0`);
}, 120_000);

it("keeps the stud mates of a module loaded after an import that brought no record for the parts they share", async () => {
  const { editor, backend, importer, catalog, frame } = await checkingImport(
    new BundleDirectoryFetcher(),
    PLAIN_MODULE_MODEL,
    [PLAIN_MODULE_MODEL, PLACEABLE_SET],
  );
  await importChecking(editor);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  await placer(editor, backend)(PLAIN_MODULE, 2_000, 320);
  await chosen(editor, SET);
  backend.aim(2_000, 320);
  editor.pointerMove(0, 0);
  const hover = hoverOutcome((await settledHover(editor, frame))?.placement);
  importer.release();

  expect(hover).toMatchObject({ accepted: true, restsOn: [PLAIN_MODULE] });
  expect(hover.mates).toBeGreaterThan(0);
}, 120_000);

function hoverOutcome(placement: PlacementHover | null | undefined) {
  return {
    pose: placement?.pose,
    accepted: placement?.accepted,
    magnetised: placement?.magnetised,
    magnet: placement?.magnet,
    restsOn: [...new Set(placement?.restsOn.map((model) => model.item))],
    mates: placement?.mates.length,
  };
}

async function setTwoStudsIntoPendingImport() {
  const started = await checkingImport(
    new BundleDirectoryFetcher(),
    PLAIN_MODULE_MODEL,
    [PLACEABLE_SET],
    true,
  );
  const { editor, backend } = started;
  const item = await importChecking(editor);
  const place = placer(editor, backend);
  await place(item, 320, 320);
  await place(item, 960, 320);
  await place(SET, 320, 320);
  const wide = editor.snapshot().catalog.find((entry) => entry.id === SET)?.studsWide ?? 0;
  await chosen(editor, SET);
  backend.aim(320 + wide * 20 - 2 * STUD_LDU, 320);
  return { ...started, item };
}

it("decides assist over an import whose studs are being checked from its connectors alone: it offers no stud meanwhile, and the hover that magnetises a held set onto it is the same before and after its studs land", async () => {
  const { editor, importer, importedPlaceable, frame, item } = await setTwoStudsIntoPendingImport();
  const hover = async () => {
    editor.pointerMove(0, 0);
    return hoverOutcome((await settledHover(editor, frame))?.placement);
  };
  const offersStuds = () => importedPlaceable()?.studLattice.onLattice.includes(1) ?? null;
  const pending = { studChecks: editor.snapshot().studChecks, offersStuds: offersStuds() };
  const pendingHover = await hover();

  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  const republished = hoverOutcome((await settledHover(editor, frame))?.placement);
  const moved = await hover();

  expect(pending).toEqual({ studChecks: 1, offersStuds: false });
  expect(offersStuds()).toBe(true);
  expect(pendingHover).toMatchObject({ accepted: true, magnetised: true, restsOn: [item] });
  expect({ republished, moved }).toEqual({
    republished: pendingHover,
    moved: pendingHover,
  });
}, 120_000);

it("keeps a click queued while the held item's tables load through another import's studs landing, then places it", async () => {
  const gate = heldPartConnectivity("3811");
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

function latticeKeys(poses: CandidatePoses, x: number, z: number): Set<string> {
  const found = new Set<string>();
  for (let q = 0; q < poses.count; q++) {
    const px = poses.x[q] ?? 0;
    const pz = poses.z[q] ?? 0;
    if ((px - x) % 20 !== 0 || (pz - z) % 20 !== 0) continue;
    found.add(`${px},${pz},${poses.yPlates[q]},${poses.rot[q]}`);
  }
  return found;
}

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
    reason: expect.stringContaining(
      `${OVERLAP} Baseplate 32 x 32's bounds in 3811 Baseplate 32 x 32`,
    ),
  },
  ghostRefusal: expect.stringContaining(OVERLAP),
  ghostTone: "refused",
  hint: {
    tone: "warn",
    detail: expect.stringContaining(
      "would overlap Baseplate 32 x 32's bounds in 3811 Baseplate 32 x 32",
    ),
  },
};
const PLACED_BESIDE = {
  outcome: { placements: 2, refusedClicks: 0, reason: null },
  ghostRefusal: null,
  ghostTone: "fits",
  hint: { tone: "place", detail: "Magnetic · 0°" },
};
const SEATED_ON_STUDS = {
  ...PLACED_BESIDE,
  ghostTone: "mates",
  hint: {
    tone: "place",
    detail: expect.stringMatching(/^Magnetic · 0° · \d+ studs(?: of [^·]+)? hold it/u),
  },
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
  { name: "a set on the 3811", held: SET, at: [0, 0], expected: SEATED_ON_STUDS },
] as const)(
  "with a 3811 placed, $name is refused only where it would overlap the 3811, naming the part it hits, and the ghost and tool hint say so before the click",
  async ({ held, at, expected }) => {
    const { editor, backend, catalog, frame } = await startEditor([
      PLAIN_MODULE_MODEL,
      PLACEABLE_SET,
    ]);
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await loadCatalogItem(catalog, SET);
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    await chosen(editor, held);
    backend.aim(at[0], at[1]);
    editor.pointerMove(0, 0);
    const ghostRefusal = (await settledHover(editor, frame))?.refusal ?? null;
    const ghostTone = backend.verdict?.tone ?? null;
    const { tone, detail } = toolHints(editor.snapshot());
    const outcome = await place(held, at[0], at[1]);

    expect({ outcome, ghostRefusal, ghostTone, hint: { tone, detail } }).toEqual(expected);
  },
  120_000,
);

it("says what mates when a set is held over a user's own baseplate file, which isn't a palette item", async () => {
  const { editor, backend, catalog } = await startEditor(
    ["baseplate-row", PLACEABLE_SET],
    new BundleDirectoryFetcher(),
    ["baseplate-row"],
  );
  const row = "omr:baseplate-row";
  await loadCatalogItem(catalog, row);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(row, 0, 0);
  await chosen(editor, SET);
  backend.aim(0, -320);
  editor.pointerMove(0, 0);
  const { tone, detail } = toolHints(editor.snapshot());

  expect({ ghost: backend.verdict?.tone, hint: { tone, detail } }).toEqual({
    ghost: "mates",
    hint: {
      tone: "place",
      detail: expect.stringMatching(
        /^Magnetic · 0° · (?:Snapped [^·]+ · )?\d+ studs(?: of [^·]+)? hold it/u,
      ),
    },
  });
}, 120_000);

it("A switches to precise placement and back, the hold override flips the mode while it is set, and the ghost and tool hint follow the effective mode", async () => {
  const { editor, backend, container } = await startEditor([]);
  const camera = container.get(EDITOR_CAMERA);
  await chosen(editor, BASEPLATE);
  backend.aim(0, 0);
  editor.pointerMove(0, 0);
  const shown = () => ({
    hover: editor.snapshot().hover?.placement?.mode ?? null,
    outlined: backend.verdict?.precise ?? null,
    hint: toolHints(editor.snapshot()).detail?.split(" · ")[0] ?? null,
  });
  const start = shown();
  runEditorAction(editor, camera, "toggle-placement-mode", 0);
  const precise = shown();
  editor.setPlacementModeOverride(true);
  const held = shown();
  editor.setPlacementModeOverride(false);
  const released = shown();
  runEditorAction(editor, camera, "toggle-placement-mode", 0);

  expect({ start, precise, held, released, back: shown() }).toEqual({
    start: { hover: "assist", outlined: false, hint: "Magnetic" },
    precise: { hover: "precise", outlined: true, hint: "Precise" },
    held: { hover: "assist", outlined: false, hint: "Magnetic" },
    released: { hover: "precise", outlined: true, hint: "Precise" },
    back: { hover: "assist", outlined: false, hint: "Magnetic" },
  });
}, 120_000);

it("settles the ghost to neutral after a click's drop until the pointer leaves the cell, a click there is refused or the mode changes, never after a redo, while the hover keeps the solver's verdict", async () => {
  const { editor, backend, frame } = await startEditor([]);
  const place = placer(editor, backend);
  await place(BASEPLATE, 0, 0);
  const shown = () => ({
    accepted: editor.snapshot().hover?.placement?.accepted ?? null,
    ghost: backend.verdict?.tone ?? null,
    hint: toolHints(editor.snapshot()).tone,
  });
  const dropped = shown();
  const droppedSaid = toolHints(editor.snapshot()).speech?.verdict;
  backend.aim(5, 5);
  editor.pointerMove(0, 0);
  const sameCell = shown();
  editor.click(0, 0, 0);
  const clickedAgain = shown();
  backend.aim(100, 0);
  editor.pointerMove(0, 0);
  await settledHover(editor, frame);
  const moved = shown();
  editor.undo(0);
  const undone = shown();
  editor.redo(0);
  const redone = shown();
  await place(BASEPLATE, 640, 0);
  const droppedBeside = shown();
  editor.setPlacementModeOverride(true);
  const heldPrecise = shown();

  expect({
    dropped,
    droppedSaid,
    sameCell,
    clickedAgain,
    moved,
    undone,
    redone,
    droppedBeside,
    heldPrecise,
  }).toEqual({
    dropped: { accepted: false, ghost: null, hint: "place" },
    droppedSaid: expect.stringMatching(/^Placed .*3811/u),
    sameCell: { accepted: false, ghost: null, hint: "place" },
    clickedAgain: { accepted: false, ghost: "refused", hint: "warn" },
    moved: { accepted: false, ghost: "refused", hint: "warn" },
    undone: { accepted: true, ghost: "fits", hint: "place" },
    redone: { accepted: false, ghost: "refused", hint: "warn" },
    droppedBeside: { accepted: false, ghost: null, hint: "place" },
    heldPrecise: { accepted: false, ghost: "refused", hint: "warn" },
  });
}, 120_000);

it("claims nothing while an assist search is unsettled, though precise's provisional verdict is a refusal, and states the settled verdict", async () => {
  const sliced = await setTwoStudsIntoSet();
  const clock = slowClock();
  const shown = () => {
    const { tone, detail, busy, waiting, speech } = toolHints(sliced.editor.snapshot());
    return {
      settled: sliced.editor.snapshot().hover?.placement?.settled,
      ghost: sliced.backend.verdict,
      hint: { tone, detail, busy, waiting, verdict: speech?.verdict },
    };
  };
  try {
    sliced.editor.pointerMove(0, 0);
    const searching = shown();
    await framesToSettle(sliced.editor, sliced.frame);
    const settled = shown();

    expect({ searching, settled }).toEqual({
      searching: {
        settled: false,
        ghost: { tone: null, hit: null, precise: false },
        hint: {
          tone: "place",
          detail: "Magnetic · 0°",
          busy: true,
          waiting: "Finding a fit…",
          verdict: null,
        },
      },
      settled: {
        settled: true,
        ghost: { tone: "mates", hit: null, precise: false },
        hint: {
          tone: "place",
          detail: expect.stringMatching(/^Magnetic · 0° · Snapped 1 stud /u),
          busy: false,
          waiting: null,
          verdict: expect.stringMatching(/^Magnetic, 0°\. Snapped 1 stud /u),
        },
      },
    });
  } finally {
    clock.mockRestore();
  }
}, 240_000);

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
  const putDown = labels();
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
    putDown,
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
    putDown: [],
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

it("checks a user's model in a two-table plan on plan sync: across the seam, out of reach, loose on a roadway and without catalog ids, and counts only the plan's rows in its parts list", async () => {
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
  const planId = plans.createPlan({
    name: "Two tables",
    roomWidthMm: 3000,
    roomDepthMm: 3000,
    originChunkX: 0,
    originChunkZ: 0,
  });
  plans.addTable(planId, {
    name: "A",
    rect: { x: 0, z: 0, width: 1000, depth: 2000 },
    heightMm: 750,
  });
  plans.addTable(planId, {
    name: "B",
    rect: { x: 1000, z: 0, width: 1000, depth: 2000 },
    heightMm: 750,
  });

  await place(brick, 2500, 1000);
  await place(brick, 300, 300);
  await place(brick, 2250, 2500);
  await place(ROAD_STRAIGHT, 960, 4360);
  await place(brick, 960, 4360);
  await place(brick, -2000, 0);
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
  const planBom = editor.bomInput({ kind: "plan", planId });
  const worldBom = editor.bomInput({ kind: "world" });

  expect({
    placements: editor.snapshot().placements,
    inside: plans.insideCount(planId),
    issues: plans.issues(planId).map((issue) => [issue.rule, issue.message]),
    plan: [planBom.name, planBom.placements, planBom.counter.total()],
    world: [worldBom.placements, worldBom.counter.total()],
  }).toEqual({
    placements: 6,
    inside: 5,
    issues: [
      [
        "bomMapping",
        "4 parts in this plan have no Rebrickable part or colour id; the parts list names them.",
      ],
      [
        "bomMapping",
        "4 parts in this plan have no BrickLink part or colour id; the parts list names them.",
      ],
      [
        "seam",
        'brick-2x4 at 2500, 1000 stands across the seam between tables "A" and "B"; a seam must fall between placements.',
      ],
      [
        "reach",
        "brick-2x4 at 2260, 2500 is out of reach: part of it is more than 700 mm from every table edge you can stand at.",
      ],
      [
        "unsupported",
        "brick-2x4 at 960, 4360 isn't held: none of its anti-studs sits on a stud, and it doesn't stand on the bare table.",
      ],
    ],
    plan: ["plan-Two_tables", 5, 5],
    world: [6, 6],
  });
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

it("seats a set on a module's surface where the cursor's ray reaches the module through its side, as a tilted camera's does", async () => {
  const { editor, backend, catalog, frame } = await startEditor([
    PLAIN_MODULE_MODEL,
    PLACEABLE_SET,
  ]);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await chosen(editor, SET);
  const cameraAt45Degrees = 1;
  const justInsideTheFrontEdge = 620;
  backend.aim(320, justInsideTheFrontEdge, cameraAt45Degrees);
  editor.pointerMove(0, 0);
  const hover = (await settledHover(editor, frame))?.placement;

  expect({
    accepted: hover?.accepted,
    lifted: hover?.lifted,
    restsOn: hover?.restsOn.map((model) => model.item),
    studMates: (hover?.mates.length ?? 0) > 0,
  }).toEqual({ accepted: true, lifted: true, restsOn: [PLAIN_MODULE], studMates: true });
}, 120_000);

it("seats a set on a module's surface where the cursor's ray enters the module's top face by its far edge, though the ray reaches the table past the module", async () => {
  const { editor, backend, catalog, frame } = await startEditor([
    PLAIN_MODULE_MODEL,
    PLACEABLE_SET,
  ]);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await chosen(editor, SET);
  const cameraAt45Degrees = 1;
  const tablePastTheFarEdge = -12;
  backend.aim(320, tablePastTheFarEdge, cameraAt45Degrees);
  editor.pointerMove(0, 0);
  const hover = (await settledHover(editor, frame))?.placement;

  expect({
    accepted: hover?.accepted,
    lifted: hover?.lifted,
    restsOn: hover?.restsOn.map((model) => model.item),
    studMates: (hover?.mates.length ?? 0) > 0,
  }).toEqual({ accepted: true, lifted: true, restsOn: [PLAIN_MODULE], studMates: true });
}, 120_000);

it("seats a user's brick on a stack of three where a low camera's ray meets the stack's top face, though that ray reaches the table beyond assist's reach", async () => {
  const { editor, backend, catalog, frame } = await startEditor(
    [USER_BRICK],
    new BundleDirectoryFetcher(),
    [USER_BRICK],
  );
  await loadCatalogItem(catalog, HELD_BRICK);
  const place = placer(editor, backend);
  for (let level = 0; level < 3; level++) await place(HELD_BRICK, 0, 0);
  await chosen(editor, HELD_BRICK);
  const stackTopLdu = 9 * PLATE_LDU;
  const lowCamera = 2;
  backend.aim(0, -stackTopLdu * lowCamera, lowCamera);
  editor.pointerMove(0, 0);
  const hover = (await settledHover(editor, frame))?.placement;

  expect({ accepted: hover?.accepted, pose: hover?.pose }).toEqual({
    accepted: true,
    pose: { x: 0, z: 0, yPlates: 9, rot: 0 },
  });
}, 120_000);

it("draws the held model's ghost exactly where a click commits it, seated on the module it rests on", async () => {
  const { editor, backend, catalog, frame } = await startEditor([
    PLAIN_MODULE_MODEL,
    PLACEABLE_SET,
  ]);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await chosen(editor, SET);
  backend.aim(320, 320);
  editor.pointerMove(0, 0);
  await settledHover(editor, frame);
  const [x = Number.NaN, yLdu = Number.NaN, z = Number.NaN] = backend.ghostPose;
  editor.click(0, 0, 0);

  expect({ poses: posesOf(editor), onTheModule: yLdu > 0 }).toEqual({
    poses: [`${PLAIN_MODULE} 320,320 y0`, `${SET} ${x},${z} y${yLdu / PLATE_LDU}`].toSorted(),
    onTheModule: true,
  });
}, 120_000);

it("assist moves a held set that would cut two studs into a placed set to a mated pose; precise, chosen or held, refuses it at the cursor naming the set", async () => {
  const { editor, backend, catalog, frame } = await startEditor([
    PLAIN_MODULE_MODEL,
    PLACEABLE_SET,
  ]);
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await place(PLAIN_MODULE, 960, 320);
  await place(SET, 320, 320);
  const wide = editor.snapshot().catalog.find((item) => item.id === SET)?.studsWide ?? 0;
  const twoStudsIn = 320 + wide * 20 - 2 * STUD_LDU;
  await chosen(editor, SET);
  backend.aim(twoStudsIn, 320);
  const hover = async () => {
    editor.pointerMove(0, 0);
    const placement = (await settledHover(editor, frame))?.placement;
    return {
      mode: placement?.mode,
      accepted: placement?.accepted,
      magnetised: placement?.magnetised,
      atCursor: placement?.pose.x === twoStudsIn && placement.pose.z === 320,
      hits: placement?.hit?.placed.item ?? null,
    };
  };
  const assist = await hover();
  editor.setPlacementModeOverride(true);
  const held = await hover();
  editor.setPlacementModeOverride(false);
  const released = await hover();
  editor.setPlacementMode("precise");
  const chosenPrecise = await hover();

  const snapped = { mode: "assist", accepted: true, magnetised: true, atCursor: false, hits: null };
  const refused = {
    mode: "precise",
    accepted: false,
    magnetised: false,
    atCursor: true,
    hits: SET,
  };
  expect({ assist, held, released, chosenPrecise }).toEqual({
    assist: snapped,
    held: refused,
    released: snapped,
    chosenPrecise: refused,
  });
}, 120_000);

const SLOW_CLOCK_STEP_MS = 1;
const FRAMES_FOR_AN_ABANDONED_SEARCH = 200;

function slowClock() {
  let now = performance.now();
  return vi.spyOn(performance, "now").mockImplementation(() => (now += SLOW_CLOCK_STEP_MS));
}

async function setTwoStudsIntoSet(gate: IAssetFetcher = new BundleDirectoryFetcher()) {
  const started = await startEditor([PLAIN_MODULE_MODEL, PLACEABLE_SET], gate);
  const { editor, backend, catalog } = started;
  await loadCatalogItem(catalog, PLAIN_MODULE);
  await loadCatalogItem(catalog, SET);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await place(PLAIN_MODULE, 960, 320);
  await place(SET, 320, 320);
  const wide = editor.snapshot().catalog.find((item) => item.id === SET)?.studsWide ?? 0;
  const twoStudsIn = 320 + wide * 20 - 2 * STUD_LDU;
  await chosen(editor, SET);
  backend.aim(twoStudsIn, 320);
  return { ...started, twoStudsIn };
}

function publishedHovers(editor: IEditor): Array<PlacementHover | null> {
  const published: Array<PlacementHover | null> = [];
  editor.subscribe(() => published.push(editor.snapshot().hover?.placement ?? null));
  return published;
}

async function framesToSettle(editor: IEditor, frame: () => Promise<void>): Promise<number> {
  let frames = 0;
  while (unsettled(editor.snapshot().hover?.placement)) {
    if (frames >= SETTLE_FRAMES) throw new Error("the hover never settled");
    await frame();
    frames++;
  }
  return frames;
}

it("shows precise's verdict at the cursor at once, then settles assist over later frames on exactly the hover a whole search gives", async () => {
  const whole = await setTwoStudsIntoSet();
  whole.editor.pointerMove(0, 0);
  const wholeHover = (await settledHover(whole.editor, whole.frame))?.placement;
  const sliced = await setTwoStudsIntoSet();
  const clock = slowClock();
  try {
    sliced.editor.pointerMove(0, 0);
    const provisional = sliced.editor.snapshot().hover?.placement;
    const ghostAtOnce = [...sliced.backend.ghostPose];
    const frames = await framesToSettle(sliced.editor, sliced.frame);
    const settled = sliced.editor.snapshot().hover?.placement;

    expect({
      settled: provisional?.settled,
      mode: provisional?.mode,
      accepted: provisional?.accepted,
      magnetised: provisional?.magnetised,
      pose: provisional?.pose,
      hits: provisional?.hit?.placed.item,
      ghost: ghostAtOnce.slice(0, 3),
    }).toEqual({
      settled: false,
      mode: "assist",
      accepted: false,
      magnetised: false,
      pose: { x: sliced.twoStudsIn, z: 320, yPlates: provisional?.pose.yPlates, rot: 0 },
      hits: SET,
      ghost: [sliced.twoStudsIn, (provisional?.pose.yPlates ?? 0) * PLATE_LDU, 320],
    });
    expect({ settled, multiFrame: frames > 1 }).toEqual({ settled: wholeHover, multiFrame: true });
    expect(wholeHover).toMatchObject({ settled: true, accepted: true, magnetised: true });
  } finally {
    clock.mockRestore();
  }
}, 240_000);

const FINE_CLOCK_STEP_MS = 0.25;
const NO_RENDER_MS = 0;
const HEAVY_RENDER_MS = 10;
const OVER_BUDGET_RENDER_MS = 14;
const THREE_STUDS_IN_FROM_TWO_IN = STUD_LDU;

async function settleBehindRender(renderMs: number) {
  const scene = await setTwoStudsIntoSet();
  let now = performance.now();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => (now += FINE_CLOCK_STEP_MS));
  scene.backend.onRender = () => {
    now += renderMs;
  };
  try {
    scene.backend.aim(scene.twoStudsIn - THREE_STUDS_IN_FROM_TWO_IN, 320);
    scene.editor.pointerMove(0, 0);
    const frameMs: number[] = [];
    while (unsettled(scene.editor.snapshot().hover?.placement)) {
      if (frameMs.length >= SETTLE_FRAMES) throw new Error("the hover never settled");
      const before = now;
      await scene.frame();
      frameMs.push(now - before);
    }
    return { frameMs, hover: scene.editor.snapshot().hover?.placement };
  } finally {
    clock.mockRestore();
  }
}

it("slices assist around the frame's render: a slow render shrinks the slice, never below its floor, and the hover settles as a whole search does", async () => {
  const whole = await setTwoStudsIntoSet();
  whole.backend.aim(whole.twoStudsIn - THREE_STUDS_IN_FROM_TWO_IN, 320);
  whole.editor.pointerMove(0, 0);
  const wholeHover = (await settledHover(whole.editor, whole.frame))?.placement;
  const light = await settleBehindRender(NO_RENDER_MS);
  const heavy = await settleBehindRender(HEAVY_RENDER_MS);
  const overBudget = await settleBehindRender(OVER_BUDGET_RENDER_MS);

  expect({ light: light.hover, heavy: heavy.hover, overBudget: overBudget.hover }).toEqual({
    light: wholeHover,
    heavy: wholeHover,
    overBudget: wholeHover,
  });
  expect({
    lightSpansFrames: light.frameMs.length > 2,
    heavySlicesShrink: heavy.frameMs.length > light.frameMs.length,
    heavyFramesWithin16Ms: heavy.frameMs.every((ms) => ms <= 16),
    overBudgetAtMostTwiceTheFrames: overBudget.frameMs.length <= 2 * light.frameMs.length + 2,
  }).toEqual({
    lightSpansFrames: true,
    heavySlicesShrink: true,
    heavyFramesWithin16Ms: true,
    overBudgetAtMostTwiceTheFrames: true,
  });
}, 240_000);

it("commits the settled assist pose for a click made before the search settles, made at once or queued while the held set's tables load", async () => {
  const setPoses = (editor: IEditor) => posesOf(editor).filter((pose) => pose.startsWith(SET));
  const atOnce = async (sliced: boolean) => {
    const scene = await setTwoStudsIntoSet();
    const clock = sliced ? slowClock() : null;
    try {
      scene.editor.pointerMove(0, 0);
      const settledAtClick = scene.editor.snapshot().hover?.placement?.settled;
      scene.editor.click(0, 0, 0);
      return { settledAtClick, poses: setPoses(scene.editor), twoStudsIn: scene.twoStudsIn };
    } finally {
      clock?.mockRestore();
    }
  };
  const queuedBesideModule = async (sliced: boolean) => {
    let holding = false;
    const gate = new HeldText(
      new BundleDirectoryFetcher(),
      (path) => holding && path.includes("/model-"),
    );
    const { editor, backend, catalog } = await startEditor(
      [PLAIN_MODULE_MODEL, PLACEABLE_SET],
      gate,
    );
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await placer(editor, backend)(PLAIN_MODULE, 320, 320);
    const wide = editor.snapshot().catalog.find((item) => item.id === SET)?.studsWide ?? 0;
    const clearOfModule = 640 + Math.ceil(wide / 2) * 20;
    holding = true;
    const clock = sliced ? slowClock() : null;
    try {
      placerNow(editor, backend)(SET, clearOfModule, 320);
      const queued = editor.snapshot().queuedPlacement !== null;
      gate.open();
      await settledChoice(editor);
      return { queued, poses: setPoses(editor), clearOfModule };
    } finally {
      clock?.mockRestore();
    }
  };
  const [wholeAtOnce, slicedAtOnce] = [await atOnce(false), await atOnce(true)];
  const [wholeQueued, slicedQueued] = [
    await queuedBesideModule(false),
    await queuedBesideModule(true),
  ];

  expect({ settledAtClick: slicedAtOnce.settledAtClick, queued: slicedQueued.queued }).toEqual({
    settledAtClick: false,
    queued: true,
  });
  expect({ atOnce: slicedAtOnce.poses, queued: slicedQueued.poses }).toEqual({
    atOnce: wholeAtOnce.poses,
    queued: wholeQueued.poses,
  });
  expect({
    atOnceMoved: !slicedAtOnce.poses.includes(`${SET} ${slicedAtOnce.twoStudsIn},320 y4`),
    queuedOnTheModule: slicedQueued.poses.every(
      (pose) => pose.endsWith(" y4") && !pose.includes(` ${slicedQueued.clearOfModule},`),
    ),
  }).toEqual({ atOnceMoved: true, queuedOnTheModule: true });
}, 240_000);

it("drops an unsettled assist search when the pointer moves to another stud, the held set turns, the mode toggles or the pointer leaves, and never shows its result", async () => {
  const outcome = async (
    trigger: (scene: Awaited<ReturnType<typeof setTwoStudsIntoSet>>) => void,
  ) => {
    const scene = await setTwoStudsIntoSet();
    const clock = slowClock();
    try {
      scene.editor.pointerMove(0, 0);
      const startedUnsettled = scene.editor.snapshot().hover?.placement?.settled === false;
      await scene.frame();
      const published = publishedHovers(scene.editor);
      trigger(scene);
      await framesToSettle(scene.editor, scene.frame);
      for (let frame = 0; frame < 4; frame++) await scene.frame();
      return { startedUnsettled, published, scene };
    } finally {
      clock.mockRestore();
    }
  };
  const whole = await setTwoStudsIntoSet();
  whole.editor.pointerMove(0, 0);
  const abandoned = (await settledHover(whole.editor, whole.frame))?.placement;
  const isAbandoned = (hover: PlacementHover | null) =>
    hover !== null &&
    hover.pose.x === abandoned?.pose.x &&
    hover.pose.z === abandoned.pose.z &&
    hover.pose.rot === abandoned.pose.rot &&
    hover.mode === "assist";
  const awayX = 2_400;
  whole.backend.aim(awayX, 320);
  whole.editor.pointerMove(0, 0);
  const awayHover = (await settledHover(whole.editor, whole.frame))?.placement;
  const moved = await outcome(({ editor, backend }) => {
    backend.aim(awayX, 320);
    editor.pointerMove(0, 0);
  });
  const turned = await outcome(({ editor }) => editor.rotate(0));
  const toggled = await outcome(({ editor }) => editor.setPlacementModeOverride(true));
  const leaving = await setTwoStudsIntoSet();
  const leaveClock = slowClock();
  let left: { startedUnsettled: boolean; hover: unknown; ghostMoved: boolean };
  try {
    leaving.editor.pointerMove(0, 0);
    const startedUnsettled = leaving.editor.snapshot().hover?.placement?.settled === false;
    await leaving.frame();
    leaving.editor.pointerLeave();
    const ghostAtLeave = [...leaving.backend.ghostPose];
    for (let frame = 0; frame < FRAMES_FOR_AN_ABANDONED_SEARCH; frame++) await leaving.frame();
    left = {
      startedUnsettled,
      hover: leaving.editor.snapshot().hover,
      ghostMoved: leaving.backend.ghostPose.some((value, index) => value !== ghostAtLeave[index]),
    };
  } finally {
    leaveClock.mockRestore();
  }

  expect([moved, turned, toggled].map(({ startedUnsettled }) => startedUnsettled)).toEqual([
    true,
    true,
    true,
  ]);
  expect({
    moved: moved.published.some(isAbandoned),
    turned: turned.published.some(isAbandoned),
    toggled: toggled.published.some(isAbandoned),
  }).toEqual({ moved: false, turned: false, toggled: false });
  expect({
    moved: moved.scene.editor.snapshot().hover?.placement,
    turnedRot: turned.scene.editor.snapshot().hover?.placement?.pose.rot,
    toggled: toggled.published
      .slice(toggled.published.findIndex((hover) => hover?.mode === "precise"))
      .every((hover) => hover?.mode === "precise" && hover.settled),
  }).toEqual({ moved: awayHover, turnedRot: 1, toggled: true });
  expect(left).toEqual({ startedUnsettled: true, hover: null, ghostMoved: false });
}, 240_000);

it("restarts an unsettled assist search when an import's studs land under it, and settles on the hover it had before they landed", async () => {
  const whole = await setTwoStudsIntoPendingImport();
  whole.editor.pointerMove(0, 0);
  const before = (await settledHover(whole.editor, whole.frame))?.placement;
  whole.importer.release();
  const sliced = await setTwoStudsIntoPendingImport();
  const atLanding: Array<boolean | undefined> = [];
  const clock = slowClock();
  try {
    sliced.editor.pointerMove(0, 0);
    const startedUnsettled = sliced.editor.snapshot().hover?.placement?.settled === false;
    sliced.editor.subscribe(() => {
      const { studChecks, hover } = sliced.editor.snapshot();
      if (studChecks === 0) atLanding.push(hover?.placement?.settled);
    });
    sliced.importer.release();
    while (sliced.editor.snapshot().studChecks > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await framesToSettle(sliced.editor, sliced.frame);
    const after = sliced.editor.snapshot().hover?.placement;

    expect({ startedUnsettled, restarted: atLanding[0] }).toEqual({
      startedUnsettled: true,
      restarted: false,
    });
    expect(after).toEqual(before);
    expect(before).toMatchObject({ settled: true, accepted: true, magnetised: true });
  } finally {
    clock.mockRestore();
  }
}, 240_000);

it("constructs no typed array once warm while hovers slice, settle and publish, refusals named included", async () => {
  const { editor, backend, frame } = await setTwoStudsIntoSet();
  const sweep = async () => {
    for (let x = 0; x <= 1_400; x += 20) {
      backend.aim(x, 320);
      editor.pointerMove(0, 0);
      await settledHover(editor, frame);
    }
  };
  await sweep();
  const refusals = () => (editor.snapshot().hover?.refusal ? 1 : 0);
  let refused = 0;
  const constructed = await typedArraysConstructedDuring(async () => {
    for (let x = 0; x <= 1_400; x += 20) {
      backend.aim(x, 320);
      editor.pointerMove(0, 0);
      await settledHover(editor, frame);
      refused += refusals();
    }
  });

  expect({ constructed, refused: refused > 0 }).toEqual({ constructed: 0, refused: true });
}, 240_000);

it("publishes the assist radius as the farthest lattice pose within 32 px at the cursor, never under one stud nor over the custom pair's 60 LDU basin", async () => {
  const { editor, backend } = await startEditor([]);
  await chosen(editor, BASEPLATE);
  const viewWidthPx = 640;
  const thirtyTwoPxIn = (ldu: number) => (ldu * viewWidthPx) / 2 / 32;
  const radius = (lduPer32Px: number) => {
    backend.viewHalfWidthLdu = thirtyTwoPxIn(lduPer32Px);
    backend.aim(0, 0);
    editor.pointerMove(0, 0);
    return editor.snapshot().hover?.placement?.assistNeighbourhood;
  };

  const [capped, within, floored] = [radius(100), radius(44), radius(5)];

  expect({ capped, floored, withinCells: within?.cells, withinPlates: within?.plates }).toEqual({
    capped: { ldu: 60, cells: 3, plates: 7 },
    floored: { ldu: 20, cells: 1, plates: 2 },
    withinCells: 3,
    withinPlates: 5,
  });
  expect(within?.ldu).toBeCloseTo(Math.hypot(2 * STUD_LDU, 2 * PLATE_LDU), 12);
}, 120_000);

const ZOOM_INSIDE_THE_ASSIST_CLAMP_LOG = -1.2;
const SUB_CELL_OFFSETS_PX: ReadonlyArray<readonly [number, number]> = [
  [0, 2],
  [0, -2],
  [2, 0],
  [-2, 0],
  [2, 2],
  [-2, -2],
];
const NDC_PER_PX_X = 2 / 640;
const NDC_PER_PX_Y = 2 / 480;

function orbitCameraAt(x: number, z: number, zoomLog: number): ViewCamera {
  const camera = new ViewCamera(CAMERA_FOV_DEGREES);
  camera.resize(640, 480);
  camera.step(0);
  camera.setMode("orbit");
  camera.step(1);
  camera.step(5_000);
  camera.zoomAtSafeCentre(zoomLog);
  camera.step(10_000);
  camera.jumpTo(x, z);
  camera.step(15_000);
  return camera;
}

it("keeps the hover and never restarts its search while the pointer moves within one stud cell at a fixed zoom", async () => {
  const scene = await setTwoStudsIntoSet();
  const { editor, backend, frame } = scene;
  backend.camera = orbitCameraAt(scene.twoStudsIn, 320, ZOOM_INSIDE_THE_ASSIST_CLAMP_LOG);
  editor.pointerMove(0, 0);
  await framesToSettle(editor, frame);
  const start = editor.snapshot().hover;
  const settled = start?.placement ?? null;
  const published = publishedHovers(editor);
  const cells = new Set<string>([`${start?.x},${start?.z}`]);
  const clock = slowClock();
  try {
    for (const [rightPx, upPx] of SUB_CELL_OFFSETS_PX) {
      editor.pointerMove(rightPx * NDC_PER_PX_X, upPx * NDC_PER_PX_Y);
      const hover = editor.snapshot().hover;
      cells.add(`${hover?.x},${hover?.z}`);
      await frame();
    }
  } finally {
    clock.mockRestore();
  }
  const reach = settled?.assistNeighbourhood.ldu ?? 0;

  expect({ cells: cells.size, insideTheClamp: reach > STUD_LDU && reach < 3 * STUD_LDU }).toEqual({
    cells: 1,
    insideTheClamp: true,
  });
  expect({
    published: published.length > 0,
    allTheSettledHover: published.every((hover) => hover === settled),
  }).toEqual({ published: true, allTheSettledHover: true });
}, 240_000);

it("counts Technic, side-stud and track votes only where those finders propose a pose, over real modulars, a module and a set with track", async () => {
  const fireBrigade = "omr:10190-1";
  const petShop = "omr:10218-1";
  const { editor, backend, catalog, container } = await startEditor([
    PLAIN_MODULE_MODEL,
    PLACEABLE_SET,
    "10190-1",
    "10218-1",
  ]);
  for (const item of [PLAIN_MODULE, SET, fireBrigade, petShop])
    await loadCatalogItem(catalog, item);
  const place = placer(editor, backend);
  await place(PLAIN_MODULE, 320, 320);
  await place(fireBrigade, 960, 320);
  await place(SET, 320, 1600);
  const solver = container.get(CONNECTION_SOLVER);
  const search = container.get(PLACEMENT_SEARCH);
  const tables = container.get(CONNECTOR_TABLES);
  const proposals = new CandidatePoses();
  const reach = { cells: 3, plates: 7, turns: 4 };
  const missed: string[] = [];
  let voted = 0;
  const held: ReadonlyArray<readonly [string, number, number, number]> = [
    [petShop, 1600, 320, 0],
    [petShop, 1300, 320, 0],
    [SET, 320, 320, 4],
    [SET, 320, 1600 + 980, 0],
  ];
  for (const [item, x, z, yPlates] of held) {
    const placeable = await loadCatalogItem(catalog, item);
    const loaded = await tables.load(placeable);
    const model = search.model(loaded.tables, placeable.partTransforms, []);
    solver.proposeMates(model, { x, z, yPlates, rot: 0, ...reach }, proposals);
    const proposed = new Set<string>();
    for (let q = 0; q < proposals.count; q++) {
      proposed.add(
        `${proposals.x[q]},${proposals.z[q]},${proposals.yPlates[q]},${proposals.rot[q]}`,
      );
    }
    for (let rot = 0; rot < reach.turns; rot++) {
      for (let dy = -reach.plates; dy <= reach.plates; dy++) {
        if (yPlates + dy < 0) continue;
        for (let i = -reach.cells; i <= reach.cells; i++) {
          for (let j = -reach.cells; j <= reach.cells; j++) {
            const pose = { x: x + i * 20, z: z + j * 20, yPlates: yPlates + dy, rot };
            if (solver.proposalVotes(model, pose) === 0) continue;
            voted++;
            const key = `${pose.x},${pose.z},${pose.yPlates},${pose.rot}`;
            if (!proposed.has(key)) missed.push(`${item} ${key}`);
          }
        }
      }
    }
  }

  expect({ missed, votedSomewhere: voted > 0 }).toEqual({ missed: [], votedSomewhere: true });
}, 600_000);

it("proposes on the stud lattice exactly the lattice poses of the full slot walk, one slot per slice, a held Technic hole's facade pin among the side studs and bars included", async () => {
  const marketStreet = "omr:10190-1";
  const petShop = "omr:10218-1";
  const { editor, backend, catalog, container } = await startEditor(["10190-1", "10218-1"]);
  for (const item of [marketStreet, petShop]) await loadCatalogItem(catalog, item);
  await placer(editor, backend)(marketStreet, 0, 0);
  const sparse = container.get(SPARSE_CONNECTOR_FINDER);
  const solver = container.get(CONNECTION_SOLVER);
  const search = container.get(PLACEMENT_SEARCH);
  const shapes = container.get(SNAP_SHAPES);
  const placeable = await loadCatalogItem(catalog, petShop);
  const loaded = await container.get(CONNECTOR_TABLES).load(placeable);
  const model = search.model(loaded.tables, placeable.partTransforms, []);
  const full = new CandidatePoses();
  const lattice = new CandidatePoses();
  const report = new MateReport();
  const progress = new ProposalProgress();
  const differing: string[] = [];
  let technicMates = 0;
  let slices = 0;
  for (const x of [600, 640, 680]) {
    const window = { x, z: 0, yPlates: 0, rot: 0, cells: 3, plates: 7, turns: 4 };
    sparse.propose(model, window, full);
    progress.restart();
    while (!sparse.proposeOnLattice(model, window, lattice, progress, 1)) slices++;
    const walked = latticeKeys(full, x, 0);
    const indexed = latticeKeys(lattice, x, 0);
    for (const key of walked) if (!indexed.has(key)) differing.push(`missing ${key}`);
    for (const key of indexed) if (!walked.has(key)) differing.push(`extra ${key}`);
    for (const key of indexed) {
      const [px = 0, pz = 0, yPlates = 0, rot = 0] = key.split(",").map(Number);
      solver.partneredMates(model, { x: px, z: pz, yPlates, rot }, report);
      for (const mate of mateCounts(report, shapes, new Set(), () => null)) {
        const flaredPartner = mate.partnerKinds.some((kind) =>
          kind.sections.some((section) => section.profile === "flare"),
        );
        if (mate.kind.gender === "female" && flaredPartner) technicMates += mate.connectors;
      }
    }
  }

  expect({ differing, technicMates: technicMates > 0, sliced: slices > 0 }).toEqual({
    differing: [],
    technicMates: true,
    sliced: true,
  });
}, 600_000);

it("leaves no placement verdict on the hover once road mode replaces a held model that was refused", async () => {
  const { editor, backend } = await startEditor([]);
  const place = placer(editor, backend);
  await place(BASEPLATE, 0, 0);
  await chosen(editor, BASEPLATE);
  backend.aim(160, 0);
  editor.pointerMove(0, 0);
  const held = editor.snapshot().hover;
  const kit = editor.snapshot().roadKits[0];
  if (!kit) throw new Error("no road kit");
  editor.chooseItem(kit.id);
  editor.pointerMove(0, 0);
  const { mode, hover } = editor.snapshot();

  expect({
    heldRefused: held?.placement?.accepted === false && held.refusal !== null,
    mode,
    placement: hover?.placement ?? null,
    refusal: hover?.refusal ?? null,
  }).toEqual({ heldRefused: true, mode: "road", placement: null, refusal: null });
}, 120_000);

it("refuses to delete a MILS module while a set rests on it, names the set, and deletes it once the set is gone", async () => {
  const { editor, backend, catalog } = await startEditor([PLAIN_MODULE_MODEL, PLACEABLE_SET]);
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
    const { editor, backend, catalog } = await startEditor([PLAIN_MODULE_MODEL, PLACEABLE_SET]);
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

const USER_ROW = "baseplate-row";
const HELD_ROW = `omr:${USER_ROW}`;

type Ground = readonly [number, number];

function ndcOf([x, z]: Ground): Ground {
  return [x / NDC_SPAN_LDU, -z / NDC_SPAN_LDU];
}

function dragGroup(editor: IEditor, backend: HeadlessBackend, from: Ground, to: Ground) {
  backend.aim(...from);
  const kind = editor.selectDragStart(0, 0, false);
  backend.aim(...to);
  editor.pointerMove(0, 0);
  editor.selectDragMove(0, 0);
  const shown = { gesture: editor.snapshot().gesture, ghost: backend.ghost };
  editor.selectDragEnd(0, 0, 0);
  return { kind, ...shown };
}

function boxSelect(
  editor: IEditor,
  backend: HeadlessBackend,
  corner: Ground,
  opposite: Ground,
  additive = false,
) {
  editor.chooseItem(null);
  backend.aim(0, 0);
  const kind = editor.selectDragStart(...ndcOf(corner), additive);
  editor.selectDragMove(...ndcOf(opposite));
  const inside = editor.snapshot().gesture;
  editor.selectDragEnd(...ndcOf(opposite), 0);
  return { kind, inside, selected: selectedItems(editor), outlined: backend.selectionBoxes };
}

function toggleAt(editor: IEditor, backend: HeadlessBackend, at: Ground) {
  backend.aim(...at);
  editor.toggleSelected(0, 0);
  return selectedItems(editor);
}

function selectedItems(editor: IEditor): ReadonlyArray<string> {
  return (editor.snapshot().selection?.members ?? []).map((member) => member.item).toSorted();
}

function groupMoveOutcome(editor: IEditor) {
  const { lastRefusal } = editor.snapshot();
  return { ...editOutcome(editor), refusedAt: lastRefusal ? [lastRefusal.x, lastRefusal.z] : null };
}

function editOutcome(editor: IEditor) {
  const { selectionRefusal, history } = editor.snapshot();
  return { poses: posesOf(editor), refusal: selectionRefusal, undoDepth: history.undoDepth };
}

async function rowBesideBaseplate() {
  const started = await startEditor([USER_ROW], new BundleDirectoryFetcher(), [USER_ROW]);
  await loadCatalogItem(started.catalog, HELD_ROW);
  return started;
}

function rowBetweenPlates(poses: ReadonlyArray<string>, refusal: unknown = null) {
  return { poses, refusal, undoDepth: 4, turns: [0, 0, 0], pivotStuds: { x: 32, z: 0 } };
}

describe("selection groups", () => {
  it("sets a user's model's position in studs and its rotation from the properties panel through placement, refusing a collision, each edit one undo step, and moves a group by the pivot it turns about, kept through a turn, a typed move and a drag", async () => {
    const { editor, backend } = await rowBesideBaseplate();
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    await place(BASEPLATE, 1300, 0);
    await place(HELD_ROW, 640, 2000);
    expect(selectAt(editor, backend, 640, 2000)?.item).toBe(HELD_ROW);
    const outcome = () => ({
      ...editOutcome(editor),
      turns: turnsOf(editor),
      pivotStuds: editor.snapshot().selection?.pivotStuds,
    });
    const start = outcome();

    editor.moveSelectionTo(32, 0, 0);
    const between = outcome();
    editor.moveSelectionTo(31.5, 0, 0);
    editor.moveSelectionTo(2 ** 27, 0, 0);
    const offLatticeOrWorld = outcome();
    editor.moveSelectionTo(31, 0, 0);
    const oneIn = outcome();
    editor.turnSelectedModelTo(1, 0);
    const quarter = outcome();
    editor.turnSelectedModelTo(3, 0);
    const threeQuarters = outcome();
    editor.turnSelectedModelTo(2, 0);
    const half = outcome();
    editor.turnSelectedModelTo(0, 0);
    const back = outcome();
    const undone = [0, 1, 2].map(() => {
      editor.undo(0);
      return { poses: posesOf(editor), turns: turnsOf(editor) };
    });
    boxSelect(editor, backend, [-400, -400], [1700, 400]);
    editor.turnSelectedModelTo(1, 0);
    const group = outcome();
    editor.rotate(0, 1);
    const groupTurned = outcome();
    editor.moveSelectionTo(33, 10, 0);
    const groupMoved = outcome();
    dragGroup(editor, backend, [660, 860], [860, 860]);
    const groupDragged = outcome();

    const plates = [`${BASEPLATE} 0,0 y0`, `${BASEPLATE} 1300,0 y0`];
    const betweenPoses = [...plates, `${HELD_ROW} 640,0 y0`].toSorted();
    expect({
      start,
      between,
      oneIn,
      offLatticeOrWorld,
      quarter,
      threeQuarters,
      half,
      back,
      undone,
      group,
      groupTurned,
      groupMoved,
      groupDragged,
    }).toEqual({
      start: {
        poses: [...plates, `${HELD_ROW} 640,2000 y0`].toSorted(),
        refusal: null,
        undoDepth: 3,
        turns: [0, 0, 0],
        pivotStuds: { x: 32, z: 100 },
      },
      between: rowBetweenPlates(betweenPoses),
      oneIn: rowBetweenPlates(
        betweenPoses,
        expect.stringMatching(new RegExp(`^Can't move it there\\. .*${OVERLAP}`, "u")),
      ),
      offLatticeOrWorld: rowBetweenPlates(betweenPoses),
      quarter: rowBetweenPlates(
        betweenPoses,
        expect.stringMatching(new RegExp(`^Can't turn to 90°\\. .*${OVERLAP}`, "u")),
      ),
      threeQuarters: rowBetweenPlates(
        betweenPoses,
        expect.stringMatching(new RegExp(`^Can't turn to 270°\\. .*${OVERLAP}`, "u")),
      ),
      half: { ...rowBetweenPlates(betweenPoses), undoDepth: 5, turns: [0, 0, 2] },
      back: { ...rowBetweenPlates(betweenPoses), undoDepth: 6 },
      undone: [
        { poses: betweenPoses, turns: [0, 0, 2] },
        { poses: betweenPoses, turns: [0, 0, 0] },
        { poses: start.poses, turns: [0, 0, 0] },
      ],
      group: { ...start, pivotStuds: { x: 33, z: 0 } },
      groupTurned: {
        poses: [
          `${BASEPLATE} 660,660 y0`,
          `${BASEPLATE} 660,-640 y0`,
          `${HELD_ROW} 640,2000 y0`,
        ].toSorted(),
        refusal: null,
        undoDepth: 4,
        turns: [0, 1, 1],
        pivotStuds: { x: 33, z: 0 },
      },
      groupMoved: {
        poses: [
          `${BASEPLATE} 660,860 y0`,
          `${BASEPLATE} 660,-440 y0`,
          `${HELD_ROW} 640,2000 y0`,
        ].toSorted(),
        refusal: null,
        undoDepth: 5,
        turns: [0, 1, 1],
        pivotStuds: { x: 33, z: 10 },
      },
      groupDragged: {
        poses: [
          `${BASEPLATE} 860,860 y0`,
          `${BASEPLATE} 860,-440 y0`,
          `${HELD_ROW} 640,2000 y0`,
        ].toSorted(),
        refusal: null,
        undoDepth: 6,
        turns: [0, 1, 1],
        pivotStuds: { x: 43, z: 10 },
      },
    });
  }, 120_000);

  it("turns a model from the properties panel about the origin R turns it on, where 10190-1's overhang puts its footprint's lattice centre a stud away", async () => {
    const overhanging = "10190-1";
    const held = `omr:${overhanging}`;
    const { editor, backend, catalog } = await startEditor(
      [overhanging],
      new BundleDirectoryFetcher(),
      [],
    );
    await loadCatalogItem(catalog, held);
    await placer(editor, backend)(held, 0, 0);
    const selected = selectAt(editor, backend, 0, 0);
    if (!selected) throw new Error(`${held} was not selected`);
    const centre = [
      nearestStud((selected.box.minX + selected.box.maxX) / 2),
      nearestStud((selected.box.minZ + selected.box.maxZ) / 2),
    ];

    const turned = [1, 3, 2, 0].map((rot) => {
      editor.turnSelectedModelTo(rot, 0);
      return { ...editOutcome(editor), turns: turnsOf(editor) };
    });

    expect(centre).not.toEqual([0, 0]);
    expect(turned).toEqual(
      [1, 3, 2, 0].map((rot, step) => ({
        poses: [`${held} 0,0 y0`],
        refusal: null,
        undoDepth: step + 2,
        turns: [rot],
      })),
    );
  }, 120_000);

  it("drags a user's model through placement: it lands flush beside a 3811, is refused one stud in, shows each pose as it goes, and Esc leaves it where it was", async () => {
    const { editor, backend } = await rowBesideBaseplate();
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    await place(HELD_ROW, 1280, 0);
    expect(selectAt(editor, backend, 1280, 0)?.item).toBe(HELD_ROW);
    const before = editOutcome(editor);

    const flush = dragGroup(editor, backend, [1280, 0], [640, 0]);
    const landed = { ...editOutcome(editor), undo: editor.snapshot().history.undo };
    const oneIn = dragGroup(editor, backend, [640, 0], [620, 0]);
    const refused = editOutcome(editor);
    backend.aim(640, 0);
    editor.selectDragStart(0, 0, false);
    backend.aim(1600, 0);
    editor.selectDragMove(0, 0);
    editor.cancelGesture();
    editor.selectDragEnd(0, 0, 0);
    const cancelled = { ...editOutcome(editor), gesture: editor.snapshot().gesture };
    editor.undo(0);

    expect({ flush, landed, oneIn, refused, cancelled, undone: posesOf(editor) }).toEqual({
      flush: {
        kind: "move",
        gesture: { kind: "move", models: 1, pieces: 0, trains: 0, dx: -640, dz: 0, refusal: null },
        ghost: { x: 640, z: 0, rot: 0 },
      },
      landed: {
        poses: [`${BASEPLATE} 0,0 y0`, `${HELD_ROW} 640,0 y0`],
        refusal: null,
        undoDepth: before.undoDepth + 1,
        undo: "move",
      },
      oneIn: {
        kind: "move",
        gesture: expect.objectContaining({ dx: -20, refusal: expect.stringContaining(OVERLAP) }),
        ghost: { x: 620, z: 0, rot: 0 },
      },
      refused: {
        poses: landed.poses,
        refusal: expect.stringMatching(new RegExp(`^Can't move it there\\. .*${OVERLAP}`, "u")),
        undoDepth: before.undoDepth + 1,
      },
      cancelled: {
        poses: landed.poses,
        refusal: null,
        undoDepth: before.undoDepth + 1,
        gesture: null,
      },
      undone: before.poses,
    });
  }, 120_000);

  it("nudges the selection one stud per press through placement, each its own undo step, and leaves the arrows to the camera with nothing selected", async () => {
    const { editor, backend } = await rowBesideBaseplate();
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    await place(HELD_ROW, 680, 0);
    expect(selectAt(editor, backend, 680, 0)?.item).toBe(HELD_ROW);
    const nudgeOffered = commandEnabled("nudge-left", editor.snapshot());
    const before = editOutcome(editor);

    editor.moveSelectionBy(-20, 0, 0);
    const oneStud = editOutcome(editor);
    editor.moveSelectionBy(-20, 0, 0);
    const flush = editOutcome(editor);
    editor.moveSelectionBy(-20, 0, 0);
    const oneIn = editOutcome(editor);
    editor.undo(0);
    const undoneOnce = posesOf(editor);
    editor.chooseItem(null);

    expect({ nudgeOffered, oneStud, flush, oneIn, undoneOnce }).toEqual({
      nudgeOffered: true,
      oneStud: {
        poses: [`${BASEPLATE} 0,0 y0`, `${HELD_ROW} 660,0 y0`],
        refusal: null,
        undoDepth: before.undoDepth + 1,
      },
      flush: {
        poses: [`${BASEPLATE} 0,0 y0`, `${HELD_ROW} 640,0 y0`],
        refusal: null,
        undoDepth: before.undoDepth + 2,
      },
      oneIn: {
        poses: flush.poses,
        refusal: expect.stringContaining(OVERLAP),
        undoDepth: before.undoDepth + 2,
      },
      undoneOnce: oneStud.poses,
    });
    expect([
      commandEnabled("nudge-left", editor.snapshot()),
      commandEnabled("pan-left", editor.snapshot()),
    ]).toEqual([false, true]);
  }, 120_000);

  it("box-selects whole models, Shift toggles one, and a group drag carries a set riding a selected module but won't leave it behind", async () => {
    const { editor, backend, catalog } = await startEditor(["mils-plain", PLACEABLE_SET]);
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await loadCatalogItem(catalog, SET);
    const place = placer(editor, backend);
    await place(PLAIN_MODULE, 320, 320);
    await place(SET, 320, 320);
    await place(BASEPLATE, -1280, 320);
    const raised = posesOf(editor);
    const setHeight = raised.find((pose) => pose.startsWith(SET))?.split(" y")[1];

    const boxed = boxSelect(editor, backend, [-700, -700], [1340, 1340]);
    const setOut = toggleAt(editor, backend, [320, 320]);
    const alone = dragGroup(editor, backend, [20, 20], [20, 1300]);
    const leftBehind = editOutcome(editor);
    const setBackIn = toggleAt(editor, backend, [320, 320]);
    dragGroup(editor, backend, [20, 20], [20, 1300]);
    const carried = editOutcome(editor);
    editor.undo(0);

    expect({
      boxed,
      setOut,
      alone,
      leftBehind,
      setBackIn,
      carried,
      undone: posesOf(editor),
    }).toEqual({
      boxed: {
        kind: "box",
        inside: { kind: "box", models: 2, pieces: 0, trains: 0 },
        selected: [PLAIN_MODULE, SET],
        outlined: 2,
      },
      setOut: [PLAIN_MODULE],
      alone: expect.objectContaining({
        kind: "move",
        gesture: expect.objectContaining({ refusal: expect.stringContaining("rests on it") }),
      }),
      leftBehind: {
        poses: raised,
        refusal: expect.stringMatching(/^Can't move it there\. .*rests on it/u),
        undoDepth: 3,
      },
      setBackIn: [PLAIN_MODULE, SET],
      carried: {
        poses: [
          `${BASEPLATE} -1280,320 y0`,
          `${PLAIN_MODULE} 320,1600 y0`,
          `${SET} 320,1600 y${setHeight}`,
        ].toSorted(),
        refusal: null,
        undoDepth: 4,
      },
      undone: raised,
    });
    expect(setHeight).not.toBe("0");
  }, 120_000);

  it("won't delete or move a group out from under a user's brick stacked on it, until the brick is selected too, then deletes all of it in one undo step", async () => {
    const { editor, backend, catalog } = await startEditor(
      [USER_BRICK],
      new BundleDirectoryFetcher(),
      [USER_BRICK],
    );
    await loadCatalogItem(catalog, HELD_BRICK);
    const place = placer(editor, backend);
    await place(HELD_BRICK, 0, 0);
    await place(HELD_BRICK, 0, 0);
    await place(HELD_BRICK, 400, 0);
    const laid = posesOf(editor);
    const stacked = laid.filter((pose) => pose.endsWith(" y0")).length;

    const boxed = boxSelect(editor, backend, [-300, -300], [700, 300]).selected.length;
    const underneath = toggleAt(editor, backend, [0, 0]).length;
    editor.deleteSelection(0);
    const deleteRefused = { ...editOutcome(editor), tone: toolHints(editor.snapshot()).tone };
    const moveRefused = dragGroup(editor, backend, [400, 0], [400, 400]).gesture;
    const withRider = toggleAt(editor, backend, [0, 0]).length;
    editor.deleteSelection(0);
    const deleted = editOutcome(editor);
    editor.undo(0);

    expect({ stacked, boxed, underneath, deleteRefused, moveRefused, withRider, deleted }).toEqual({
      stacked: 2,
      boxed: 3,
      underneath: 2,
      deleteRefused: {
        poses: laid,
        refusal: expect.stringMatching(/^Can't delete\. .*rests on it.*select it too\.$/u),
        undoDepth: 3,
        tone: "warn",
      },
      moveRefused: expect.objectContaining({
        kind: "move",
        refusal: expect.stringContaining("rests on it"),
      }),
      withRider: 3,
      deleted: { poses: [], refusal: null, undoDepth: 4 },
    });
    expect({ undone: posesOf(editor), reselected: selectedItems(editor).length }).toEqual({
      undone: laid,
      reselected: 3,
    });
  }, 120_000);

  it("turns a group of user's bricks about its lattice centre and back exactly, each turn one undo step, and won't turn one out from under a brick stacked on it", async () => {
    const { editor, backend, catalog } = await startEditor(
      [USER_BRICK],
      new BundleDirectoryFetcher(),
      [USER_BRICK],
    );
    await loadCatalogItem(catalog, HELD_BRICK);
    editor.setPlacementMode("precise");
    const place = placer(editor, backend);
    await place(HELD_BRICK, 0, 0);
    await place(HELD_BRICK, 100, 0);
    const laid = { poses: posesOf(editor), turns: turnsOf(editor) };

    boxSelect(editor, backend, [-300, -300], [400, 300]);
    const pivot = selectionPivot(editor);
    editor.rotate(0, 1);
    const turned = { ...editOutcome(editor), turns: turnsOf(editor) };
    editor.rotate(0, -1);
    const back = { ...editOutcome(editor), turns: turnsOf(editor) };
    editor.undo(0);
    editor.undo(0);
    const undone = posesOf(editor);
    await place(HELD_BRICK, 100, 0);
    boxSelect(editor, backend, [-300, -300], [400, 300]);
    toggleAt(editor, backend, [100, 0]);
    editor.rotate(0, 1);
    const underRider = editOutcome(editor);

    expect({ turned, back, undone, underRider }).toEqual({
      turned: {
        poses: laid.poses.map((pose) => turnedPose(pose, pivot)).toSorted(),
        refusal: null,
        undoDepth: 3,
        turns: [1, 1],
      },
      back: { poses: laid.poses, refusal: null, undoDepth: 4, turns: laid.turns },
      undone: laid.poses,
      underRider: {
        poses: [...laid.poses, `${HELD_BRICK} 100,0 y3`].toSorted(),
        refusal: expect.stringMatching(/^Can't turn the group\. .*rests on it/u),
        undoDepth: 3,
      },
    });
  }, 120_000);

  it("moves a group rigidly at its exact poses, each joined part of it held up only by its own mate outside the group or the table, and names a hit rather than lift it", async () => {
    const raisedPair = async (secondAt: readonly [number, number]) => {
      const started = await startEditor(
        [CABOOSE.slice("omr:".length)],
        new BundleDirectoryFetcher(),
        [USER_BRICK],
      );
      const { editor, backend, catalog } = started;
      await loadCatalogItem(catalog, HELD_BRICK);
      await loadCatalogItem(catalog, CABOOSE);
      editor.setPlacementMode("precise");
      const place = placer(editor, backend);
      for (const [x, z] of [[0, 0], [200, 0], [0, 400], [0, 0], secondAt] as const) {
        await place(HELD_BRICK, x, z);
      }
      await place(CABOOSE, 0, 1200);
      return { ...started, laid: posesOf(editor) };
    };
    const apart = await raisedPair([200, 0]);
    selectAt(apart.editor, apart.backend, 0, 0);
    toggleAt(apart.editor, apart.backend, [200, 0]);
    apart.editor.moveSelectionBy(0, 400, 0);
    const oneOverAir = groupMoveOutcome(apart.editor);

    const overCaboose = await raisedPair([200, 0]);
    selectAt(overCaboose.editor, overCaboose.backend, 0, 0);
    toggleAt(overCaboose.editor, overCaboose.backend, [200, 0]);
    overCaboose.editor.moveSelectionBy(0, 1_200, 0);
    const overTheCaboose = groupMoveOutcome(overCaboose.editor);
    const caboose = overCaboose.editor
      .snapshot()
      .catalog.find((item) => item.id === CABOOSE)?.label;

    const joined = await raisedPair([20, 0]);
    selectAt(joined.editor, joined.backend, 50, 0);
    toggleAt(joined.editor, joined.backend, [-30, 0]);
    joined.editor.moveSelectionBy(0, 400, 0);
    const carried = groupMoveOutcome(joined.editor);

    expect({
      apart: apart.laid.filter((pose) => !pose.endsWith(" y0")),
      joined: joined.laid.filter((pose) => !pose.endsWith(" y0")),
    }).toEqual({
      apart: [`${HELD_BRICK} 0,0 y3`, `${HELD_BRICK} 200,0 y3`],
      joined: [`${HELD_BRICK} 0,0 y3`, `${HELD_BRICK} 20,0 y6`],
    });
    expect({ oneOverAir, overTheCaboose, carried }).toEqual({
      oneOverAir: {
        poses: apart.laid,
        refusal: expect.stringMatching(/^Can't move them there\. .*has nothing to rest on here/u),
        undoDepth: apart.laid.length,
        refusedAt: [200, 400],
      },
      overTheCaboose: {
        poses: overCaboose.laid,
        refusal: expect.stringContaining(`${OVERLAP} Plate 2 x 8's bounds in ${caboose ?? ""}`),
        undoDepth: overCaboose.laid.length,
        refusedAt: [0, 1200],
      },
      carried: {
        poses: joined.laid
          .map((pose) => pose.replace(" 0,0 y3", " 0,400 y3").replace(" 20,0 y6", " 20,400 y6"))
          .toSorted(),
        refusal: null,
        undoDepth: joined.laid.length + 1,
        refusedAt: null,
      },
    });
  }, 120_000);

  it("copies a group with a user's model and pastes it on the cursor in one undo step, refusing a drop where it would overlap", async () => {
    const { editor, backend } = await rowBesideBaseplate();
    const place = placer(editor, backend);
    await place(BASEPLATE, 0, 0);
    await place(HELD_ROW, 640, 0);
    const laid = posesOf(editor);
    boxSelect(editor, backend, [-400, -1800], [1000, 1800]);
    const box = editor.snapshot().selection?.box;
    if (!box) throw new Error("the box selected nothing");
    const pivot: Ground = [
      nearestStud((box.minX + box.maxX) / 2),
      nearestStud((box.minZ + box.maxZ) / 2),
    ];
    const depth = nearestStud(box.maxZ - box.minZ);
    editor.copySelection();
    const copied = editor.snapshot().clipboard;

    editor.pasteClipboard();
    const ghostParts = backend.ghostInstances;
    backend.aim(pivot[0] + 20, pivot[1]);
    editor.pointerMove(0, 0);
    const overlapping = editor.snapshot().gesture;
    editor.click(0, 0, 0);
    const refusedDrop = { ...editOutcome(editor), gesture: editor.snapshot().gesture?.kind };
    backend.aim(pivot[0], pivot[1] + depth);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    const dropped = { ...editOutcome(editor), selected: selectedItems(editor) };
    editor.undo(0);

    expect(ghostParts).toBeGreaterThan(0);
    expect({ copied, overlapping, refusedDrop, dropped, undone: posesOf(editor) }).toEqual({
      copied: 2,
      overlapping: expect.objectContaining({
        kind: "paste",
        models: 2,
        refusal: expect.stringContaining(OVERLAP),
      }),
      refusedDrop: {
        poses: laid,
        refusal: expect.stringContaining("Can't paste here."),
        undoDepth: 2,
        gesture: "paste",
      },
      dropped: {
        poses: [...laid, ...shiftedPoses(laid, depth)].toSorted(),
        refusal: null,
        undoDepth: 3,
        selected: [BASEPLATE, HELD_ROW].toSorted(),
      },
      undone: laid,
    });
  }, 120_000);
});

const STRAIGHT_PIECE = `${TRACK_PIECE_PREFIX}${NINE_VOLT_STRAIGHT}`;

function pieceCentres(editor: IEditor): ReadonlyArray<string> {
  return (editor.snapshot().selection?.members ?? [])
    .flatMap((member) => (member.kind === "track" ? [`${member.centreX},${member.centreZ}`] : []))
    .toSorted();
}

function groupOutcome(editor: IEditor) {
  const { selectionRefusal, history } = editor.snapshot();
  const { poses, laidTrack, openEnds, joins } = layoutState(editor);
  return {
    poses,
    headings: laidTrack.map((record) => record.heading),
    openEnds,
    joins,
    refusal: selectionRefusal,
    undo: history.undoLabel,
    undoDepth: history.undoDepth,
    selected: selectedItems(editor),
    pieces: pieceCentres(editor),
  };
}

function turnedCentre([x, z]: Ground, [px, pz]: Ground): string {
  return `${px + (z - pz)},${pz - (x - px)}`;
}

function shiftedLayoutPose(pose: string, dx: number, dz: number): string {
  const [ref = "", x = "0", z = "0", yPlates = "0", rot = "0"] = pose.split(" ");
  return `${ref} ${Number(x) + dx} ${Number(z) + dz} ${yPlates} ${rot}`;
}

function turnedLayoutPose(pose: string, pivot: Ground): string {
  const [ref = "", x = "0", z = "0", yPlates = "0", rot = "0"] = pose.split(" ");
  const [turnedX, turnedZ] = turnedCentre([Number(x), Number(z)], pivot).split(",");
  return `${ref} ${turnedX} ${turnedZ} ${yPlates} ${(Number(rot) + 1) % 4}`;
}

function centreOf(at: string): Ground {
  const [x = 0, z = 0] = at.split(",").map(Number);
  return [x, z];
}

async function brickBesideRun() {
  const started = await startEditor([USER_BRICK], new BundleDirectoryFetcher(), [USER_BRICK]);
  await loadCatalogItem(started.catalog, HELD_BRICK);
  started.editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(started.editor, started.backend, [-24 * STUD, 0], [24 * STUD, 0]);
  await placer(started.editor, started.backend)(HELD_BRICK, -320, 400);
  started.editor.chooseItem(null);
  return started;
}

const RUN_PLAN_ORIGIN_CHUNK = -2;

function runPlanMm(ldu: number): number {
  return (ldu - RUN_PLAN_ORIGIN_CHUNK * CHUNK_LDU) / LDU_PER_MM;
}

describe("selection groups with laid track", () => {
  it("shows plan listeners only the track rows a group nudge or delete of a user's brick and laid track leaves", async () => {
    const { editor, backend, container } = await brickBesideRun();
    const plans = container.get(PLAN_SERVICE);
    const planId = plans.createPlan({
      name: "Room",
      roomWidthMm: 4000,
      roomDepthMm: 4000,
      originChunkX: RUN_PLAN_ORIGIN_CHUNK,
      originChunkZ: RUN_PLAN_ORIGIN_CHUNK,
    });
    const openEnds = () =>
      plans
        .issues(planId)
        .filter((issue) => issue.rule === "trackOpenEnd")
        .map((issue) => issue.message);
    let seen: Array<ReadonlyArray<string>> = [];
    plans.subscribe(() => seen.push(openEnds()));
    boxSelect(editor, backend, [-520, -200], [520, 500]);
    const before = openEnds();
    seen = [];
    editor.moveSelectionBy(0, STUD, 0);
    const nudged = { seen, rows: openEnds() };
    seen = [];
    editor.deleteSelection(0);

    const runEnds = (zLdu: number) => [
      `Open track end at (${runPlanMm(-24 * STUD)} mm, ${runPlanMm(zLdu)} mm) on Train Track 9V Straight #1: nothing joins it.`,
      `Open track end at (${runPlanMm(24 * STUD)} mm, ${runPlanMm(zLdu)} mm) on Train Track 9V Straight #3: nothing joins it.`,
    ];

    expect(before).toEqual(runEnds(0));
    expect(nudged.seen).toEqual([runEnds(STUD)]);
    expect(nudged.rows).toEqual(runEnds(STUD));
    expect(seen).toEqual([[]]);
  }, 120_000);

  it("box-selects a user's brick with laid track, nudges, turns and deletes them as one undo step each that redo repeats, and pulls a piece off its join like real track, which undo joins again", async () => {
    const { editor, backend } = await brickBesideRun();
    const laid = groupOutcome(editor);

    const partial = boxSelect(editor, backend, [-520, -200], [-140, 500]);
    const partialPieces = pieceCentres(editor);
    editor.moveSelectionBy(-STUD, 0, 0);
    const pulledOff = groupOutcome(editor);
    editor.undo(0);
    const rejoined = groupOutcome(editor);

    const whole = boxSelect(editor, backend, [-520, -200], [520, 500]);
    const wholeTitle = toolHints(editor.snapshot()).title;
    const before = groupOutcome(editor);
    editor.moveSelectionBy(0, STUD, 0);
    const nudged = groupOutcome(editor);
    editor.undo(0);
    const nudgeUndone = groupOutcome(editor);
    editor.redo(0);
    const nudgeRedone = groupOutcome(editor);
    const pivot = selectionPivot(editor);
    editor.rotate(0, 1);
    const turned = groupOutcome(editor);
    editor.undo(0);
    const turnUndone = groupOutcome(editor);
    editor.redo(0);
    const turnRedone = groupOutcome(editor);
    editor.rotate(0, -1);
    const turnedBack = groupOutcome(editor);
    editor.deleteSelection(0);
    const deleted = groupOutcome(editor);
    editor.undo(0);
    const deleteUndone = groupOutcome(editor);
    editor.redo(0);
    const deleteRedone = groupOutcome(editor);

    const partialSelected = { ...laid, selected: partial.selected, pieces: partialPieces };
    expect({ partial, pulledOff, rejoined }).toEqual({
      partial: {
        kind: "box",
        inside: { kind: "box", models: 1, pieces: 1, trains: 0 },
        selected: [HELD_BRICK, STRAIGHT_PIECE].toSorted(),
        outlined: 2,
      },
      pulledOff: {
        ...partialSelected,
        poses: laid.poses.map((pose) => pose.replace(" -320 400 ", " -340 400 ")),
        openEnds: 4,
        joins: 1,
        undo: "move",
        undoDepth: laid.undoDepth + 1,
        pieces: partialPieces.map((at) => {
          const [x, z] = centreOf(at);
          return `${x - STUD},${z}`;
        }),
      },
      rejoined: partialSelected,
    });
    expect(whole.selected).toEqual([HELD_BRICK, STRAIGHT_PIECE, STRAIGHT_PIECE, STRAIGHT_PIECE]);
    expect(wholeTitle).toBe("1 model and 3 track pieces selected");
    expect(laid.joins).toBe(2);
    expect({ nudged, nudgeUndone, nudgeRedone }).toEqual({
      nudged: {
        ...before,
        poses: before.poses.map((pose) => pose.replace(" -320 400 ", " -320 420 ")),
        undo: "move",
        undoDepth: before.undoDepth + 1,
        pieces: before.pieces.map((at) => {
          const [x, z] = centreOf(at);
          return `${x},${z + STUD}`;
        }),
      },
      nudgeUndone: before,
      nudgeRedone: nudged,
    });
    expect({ turned, turnUndone, turnRedone }).toEqual({
      turned: {
        ...nudged,
        poses: nudged.poses.map((pose) => turnedLayoutPose(pose, pivot)).toSorted(),
        headings: nudged.headings.map((heading) => (heading + ZETA16_ORDER - 4) % ZETA16_ORDER),
        undo: "rotate",
        undoDepth: nudged.undoDepth + 1,
        pieces: nudged.pieces.map((at) => turnedCentre(centreOf(at), pivot)).toSorted(),
      },
      turnUndone: nudged,
      turnRedone: turned,
    });
    expect(turnedBack).toEqual({
      ...nudged,
      undo: "rotate",
      undoDepth: turned.undoDepth + 1,
    });
    expect({ deleted, deleteUndone, deleteRedone }).toEqual({
      deleted: {
        poses: [],
        headings: [],
        openEnds: 0,
        joins: 0,
        refusal: null,
        undo: "delete",
        undoDepth: turnedBack.undoDepth + 1,
        selected: [],
        pieces: [],
      },
      deleteUndone: turnedBack,
      deleteRedone: deleted,
    });
  }, 120_000);

  it("undoes a group's delete, turn and nudge one after another back to where it was laid, the group selected at each step", async () => {
    const { editor, backend } = await brickBesideRun();
    boxSelect(editor, backend, [-520, -200], [520, 500]);
    const laid = groupOutcome(editor);
    editor.moveSelectionBy(0, STUD, 0);
    const nudged = groupOutcome(editor);
    editor.rotate(0, 1);
    const turned = groupOutcome(editor);
    editor.deleteSelection(0);
    const undone = [1, 2, 3].map(() => {
      editor.undo(0);
      return groupOutcome(editor);
    });

    expect(undone).toEqual([turned, nudged, laid]);
  }, 120_000);

  it("drags a lone laid piece along its line until it joins the open end exactly, nudges it off that join and back by undo, and pastes a copy of it on the cursor in one undo step", async () => {
    const { editor, backend } = await startEditor([]);
    editor.chooseItem(TRACK_ITEM_ID);
    dragTrack(editor, backend, [-24 * STUD, 0], [-8 * STUD, 0]);
    dragTrack(editor, backend, [8 * STUD, 0], [24 * STUD, 0]);
    editor.chooseItem(null);
    const apart = groupOutcome(editor);
    expect(selectAt(editor, backend, 16 * STUD, 0)?.item).toBe(STRAIGHT_PIECE);

    const slid = dragGroup(editor, backend, [16 * STUD, 0], [0, 0]);
    const joined = groupOutcome(editor);
    editor.moveSelectionBy(STUD, 0, 0);
    const pulled = groupOutcome(editor);
    editor.undo(0);
    const rejoined = groupOutcome(editor);
    editor.copySelection();
    editor.pasteClipboard();
    backend.aim(0, 40 * STUD);
    editor.pointerMove(0, 0);
    const pasting = editor.snapshot().gesture;
    editor.click(0, 0, 0);
    const pasted = groupOutcome(editor);
    editor.undo(0);
    const pasteUndone = groupOutcome(editor);

    expect({ apart: { joins: apart.joins, openEnds: apart.openEnds }, slid }).toEqual({
      apart: { joins: 0, openEnds: 4 },
      slid: {
        kind: "move",
        gesture: {
          kind: "move",
          models: 0,
          pieces: 1,
          trains: 0,
          dx: -16 * STUD,
          dz: 0,
          refusal: null,
        },
        ghost: { x: -16 * STUD, z: 0, rot: 0 },
      },
    });
    expect({ joined, pulled, rejoined, pasting, pasted, pasteUndone }).toEqual({
      joined: {
        ...apart,
        joins: 1,
        openEnds: 2,
        undo: "move",
        undoDepth: apart.undoDepth + 1,
        selected: [STRAIGHT_PIECE],
        pieces: ["0,0"],
      },
      pulled: {
        ...joined,
        joins: 0,
        openEnds: 4,
        undoDepth: joined.undoDepth + 1,
        pieces: [`${STUD},0`],
      },
      rejoined: joined,
      pasting: expect.objectContaining({ kind: "paste", models: 0, pieces: 1, refusal: null }),
      pasted: {
        ...joined,
        headings: [...joined.headings, ...joined.headings.slice(1)],
        openEnds: 4,
        undo: "place",
        undoDepth: joined.undoDepth + 1,
        pieces: [`0,${40 * STUD}`],
      },
      pasteUndone: { ...joined, selected: [], pieces: [] },
    });
  }, 120_000);

  it("moves a lone laid piece from the properties panel by its centre in studs until it joins the open end, and offers it no model rotation", async () => {
    const { editor, backend } = await startEditor([]);
    editor.chooseItem(TRACK_ITEM_ID);
    dragTrack(editor, backend, [-24 * STUD, 0], [-8 * STUD, 0]);
    dragTrack(editor, backend, [8 * STUD, 0], [24 * STUD, 0]);
    editor.chooseItem(null);
    expect(selectAt(editor, backend, 16 * STUD, 0)?.item).toBe(STRAIGHT_PIECE);
    const pivot = () => editor.snapshot().selection?.pivotStuds;
    const apart = { ...groupOutcome(editor), pivotStuds: pivot() };

    editor.moveSelectionTo(0, 0, 0);
    const joined = { ...groupOutcome(editor), pivotStuds: pivot() };
    editor.turnSelectedModelTo(1, 0);
    const turned = { ...groupOutcome(editor), pivotStuds: pivot() };

    expect({ apart: apart.pivotStuds, joined, turned }).toEqual({
      apart: { x: 16, z: 0 },
      joined: {
        ...apart,
        joins: 1,
        openEnds: 2,
        undo: "move",
        undoDepth: apart.undoDepth + 1,
        pieces: ["0,0"],
        pivotStuds: { x: 0, z: 0 },
      },
      turned: joined,
    });
  }, 120_000);

  it("keeps a selected piece selected through a redo that lifts a piece laid before it", async () => {
    const { editor, backend } = await startEditor([]);
    editor.chooseItem(TRACK_ITEM_ID);
    dragTrack(editor, backend, [-24 * STUD, 0], [24 * STUD, 0]);
    selectAt(editor, backend, -16 * STUD, 0);
    editor.deleteSelection(0);
    editor.undo(0);
    selectAt(editor, backend, 16 * STUD, 0);
    editor.redo(0);

    expect(editor.snapshot().selection?.members).toEqual([
      expect.objectContaining({
        kind: "track",
        item: STRAIGHT_PIECE,
        centreX: 16 * STUD,
        centreZ: 0,
      }),
    ]);
    expect(editor.snapshot().track?.pieces).toBe(2);
  }, 120_000);

  it("nudges a set off the laid track its own track is joined to, moves both together with the join kept, and won't drag them into the module beside them", async () => {
    const { editor, backend, catalog } = await startEditor(["mils-plain", PLACEABLE_SET]);
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await loadCatalogItem(catalog, SET);
    const place = placer(editor, backend);
    await place(PLAIN_MODULE, 0, 1600);
    await place(SET, 0, 0);
    const [end] = editor.dump().trackEnds;
    if (!end) throw new Error(`${SET} carries no open track end`);
    const from: Ground = [nearestStud(end.xLdu), nearestStud(end.zLdu)];
    const outward: Ground = [
      Math.round(Math.cos(end.headingRadians)),
      Math.round(Math.sin(end.headingRadians)),
    ];
    const reach = 16 * STUD;
    editor.chooseItem(TRACK_ITEM_ID);
    dragTrack(editor, backend, from, [from[0] + outward[0] * reach, from[1] + outward[1] * reach]);
    editor.chooseItem(null);
    const joined = groupOutcome(editor);
    const { joins: joinedCount = 0, openEnds: openCount = 0 } = joined;

    const [dx, dz] = [outward[1] * STUD, outward[0] * STUD];
    const [backX, backZ] = [-outward[0] * STUD, -outward[1] * STUD];
    expect(selectAt(editor, backend, 0, 0)?.item).toBe(SET);
    editor.moveSelectionBy(backX, backZ, 0);
    const setAlone = groupOutcome(editor);
    editor.undo(0);
    toggleAt(editor, backend, [
      from[0] + (outward[0] * reach) / 2,
      from[1] + (outward[1] * reach) / 2,
    ]);
    const pair = groupOutcome(editor);
    editor.moveSelectionBy(dx, dz, 0);
    const together = groupOutcome(editor);
    const ontoModule = dragGroup(editor, backend, [0, 0], [0, 1600]).gesture;
    const left = groupOutcome(editor);

    expect(joined.joins).toBeGreaterThan(0);
    expect({ setAlone, together }).toEqual({
      setAlone: {
        ...joined,
        poses: joined.poses.map((pose) =>
          pose.startsWith(`${SET} `) ? shiftedLayoutPose(pose, backX, backZ) : pose,
        ),
        joins: joinedCount - 1,
        openEnds: openCount + 2,
        undo: "move",
        undoDepth: joined.undoDepth + 1,
        selected: [SET],
      },
      together: {
        ...pair,
        poses: pair.poses.map((pose) =>
          pose.startsWith(`${SET} `) ? shiftedLayoutPose(pose, dx, dz) : pose,
        ),
        undo: "move",
        undoDepth: pair.undoDepth + 1,
        pieces: pair.pieces.map((at) => {
          const [x, z] = centreOf(at);
          return `${x + dx},${z + dz}`;
        }),
      },
    });
    expect(pair.selected).toEqual([SET, STRAIGHT_PIECE].toSorted());
    expect(ontoModule).toMatchObject({
      kind: "move",
      refusal: expect.stringContaining(OVERLAP),
    });
    expect({ ...left, refusal: null }).toEqual({ ...together, refusal: null });
  }, 120_000);

  it("won't drag laid track into a user's brick, names the brick, and leaves the track where it was", async () => {
    const { editor, backend } = await brickBesideRun();
    const laid = groupOutcome(editor);
    boxSelect(editor, backend, [-520, -200], [520, 200]);

    const intoBrick = dragGroup(editor, backend, [0, 0], [-320, 400]);
    const left = groupOutcome(editor);

    expect(intoBrick.gesture).toMatchObject({
      kind: "move",
      models: 0,
      pieces: 3,
      refusal: expect.stringMatching(/ would run into .*brick/u),
    });
    expect({ ...left, refusal: null, selected: [], pieces: [] }).toEqual({
      ...laid,
      selected: [],
      pieces: [],
    });
    expect(left.refusal).toMatch(/^Can't move them there\. /u);
  }, 120_000);

  it("drags laid track onto a road plate's roadway as a level crossing reported unsupported, as a stroke lays it, and won't drag it across track it doesn't join", async () => {
    const { editor, backend } = await startEditor([]);
    await placer(editor, backend)(ROAD_STRAIGHT, 0, 0);
    await supportChecked(editor);
    editor.chooseItem(TRACK_ITEM_ID);
    dragTrack(editor, backend, [-24 * STUD, 40 * STUD], [24 * STUD, 40 * STUD]);
    dragTrack(editor, backend, [-24 * STUD, 70 * STUD], [24 * STUD, 70 * STUD]);
    const crossingOf = () => ({
      unsupported: editor.snapshot().track?.unsupported,
      crossings: editor.dump().crossings.length,
    });
    const laid = crossingOf();

    boxSelect(editor, backend, [-26 * STUD, 35 * STUD], [26 * STUD, 45 * STUD]);
    const ontoRoadway = dragGroup(editor, backend, [0, 40 * STUD], [0, 0]);
    const onRoadway = { ...groupOutcome(editor), ...crossingOf() };
    const acrossTrack = dragGroup(editor, backend, [0, 0], [0, 70 * STUD]);
    const left = { ...groupOutcome(editor), ...crossingOf() };

    expect(laid).toEqual({ unsupported: 0, crossings: 0 });
    expect(ontoRoadway.gesture).toMatchObject({ kind: "move", pieces: 3, refusal: null });
    expect(onRoadway).toMatchObject({
      undo: "move",
      refusal: null,
      unsupported: expect.any(Number),
      crossings: 1,
    });
    expect(onRoadway.unsupported).toBeGreaterThan(0);
    expect(acrossTrack.gesture).toMatchObject({
      kind: "move",
      pieces: 3,
      refusal: expect.stringMatching(/ would cross the track laid there\.$/u),
    });
    expect({ ...left, refusal: null }).toEqual({ ...onRoadway, refusal: null });
  }, 120_000);
});

function nearestStud(ldu: number): number {
  return Math.round(ldu / STUD) * STUD;
}

function selectionPivot(editor: IEditor): Ground {
  const box = editor.snapshot().selection?.box;
  if (!box) throw new Error("nothing is selected");
  return [nearestStud((box.minX + box.maxX) / 2), nearestStud((box.minZ + box.maxZ) / 2)];
}

function turnedPose(pose: string, [px, pz]: Ground): string {
  const [ref = "", at = "", height = ""] = pose.split(" ");
  const [x = 0, z = 0] = at.split(",").map(Number);
  return `${ref} ${px + (z - pz)},${pz - (x - px)} ${height}`;
}

function shiftedPoses(poses: ReadonlyArray<string>, dz: number): ReadonlyArray<string> {
  return poses.map((pose) => {
    const [ref = "", at = "", height = ""] = pose.split(" ");
    const [x = "", z = ""] = at.split(",");
    return `${ref} ${x},${Number(z) + dz} ${height}`;
  });
}

function turnsOf(editor: IEditor): ReadonlyArray<number> {
  return editor.dump().placements.rot.toSorted();
}

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
  setGhostVerdict(...args: Parameters<ISceneBackend["setGhostVerdict"]>): void {
    this.three.setGhostVerdict(...args);
  }
  setSelectionBoxes(...args: Parameters<ISceneBackend["setSelectionBoxes"]>): void {
    this.three.setSelectionBoxes(...args);
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

const CONNECTOR_INDEX = /\/(connectivity|connector)-index\.[0-9a-f]+\.json$/u;
const CONNECTOR_PACK = /\/(connectivity|connectors)-pack\.[0-9a-f]+\.json$/u;

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
    if (CONNECTOR_INDEX.test(path)) return JSON.stringify(this.withdrawn(JSON.parse(text)));
    if (!CONNECTOR_PACK.test(path)) return text;
    const pack = JSON.parse(text) as { files: Record<string, unknown> };
    const files = Object.entries(pack.files).map(([name, file]) => [
      name,
      CONNECTOR_INDEX.test(`/${name}`) ? this.withdrawn(file) : file,
    ]);
    return JSON.stringify({ ...pack, files: Object.fromEntries(files) });
  }

  private withdrawn(file: unknown): unknown {
    const index = file as { parts: Record<string, unknown> };
    const { [this.partId]: _withdrawn, ...parts } = index.parts;
    return { ...index, parts };
  }
}

class HeldText implements IAssetFetcher {
  private release: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private failure: Error | null = null;
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
      if (this.failure) throw this.failure;
    }
    return this.files.text(path);
  }

  open(): void {
    this.release();
  }

  fail(reason: string): void {
    this.failure = new Error(reason);
    this.release();
  }
}

function heldConnectivity(): HeldText {
  return new HeldText(new BundleDirectoryFetcher(), (path) => path.includes("/connectivity-pack."));
}

const BUNDLE_MANIFEST = /\/manifest\.json$/u;

class PerPartConnectorBundle implements IAssetFetcher {
  private readonly files = new BundleDirectoryFetcher();

  bytes(path: string): Promise<ArrayBuffer> {
    return this.files.bytes(path);
  }

  async text(path: string): Promise<string> {
    const text = await this.files.text(path);
    if (!BUNDLE_MANIFEST.test(path)) return text;
    const { connectorPacks: _packs, ...manifest } = JSON.parse(text);
    return JSON.stringify(manifest);
  }
}

function heldPartConnectivity(partId: string): HeldText {
  return new HeldText(new PerPartConnectorBundle(), (path) =>
    path.includes(`/connectivity-${partId}.`),
  );
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

it("decides a click queued while a set's tables load in the mode in effect when they load: assist magnetises it onto the module beside it, precise takes the cursor pose", async () => {
  const queuedBesideModule = async (mode: "assist" | "precise") => {
    let holding = false;
    const gate = new HeldText(
      new BundleDirectoryFetcher(),
      (path) => holding && path.includes("/model-"),
    );
    const { editor, backend, catalog } = await startEditor(
      [PLAIN_MODULE_MODEL, PLACEABLE_SET],
      gate,
    );
    await loadCatalogItem(catalog, PLAIN_MODULE);
    await placer(editor, backend)(PLAIN_MODULE, 320, 320);
    const wide = editor.snapshot().catalog.find((item) => item.id === SET)?.studsWide ?? 0;
    const clearOfModule = 640 + Math.ceil(wide / 2) * 20;
    holding = true;
    editor.setPlacementMode(mode);
    placerNow(editor, backend)(SET, clearOfModule, 320);
    const queued = editor.snapshot().queuedPlacement !== null;
    gate.open();
    await settledChoice(editor);
    const set = posesOf(editor).find((pose) => pose.startsWith(SET)) ?? "";
    return { queued, set, clearOfModule };
  };
  const assist = await queuedBesideModule("assist");
  const precise = await queuedBesideModule("precise");

  expect({
    queued: [assist.queued, precise.queued],
    assistOnTheModule:
      assist.set.endsWith(" y4") && !assist.set.includes(` ${assist.clearOfModule},`),
    precise: precise.set,
  }).toEqual({
    queued: [true, true],
    assistOnTheModule: true,
    precise: `${SET} ${precise.clearOfModule},320 y0`,
  });
}, 240_000);

it("keeps a click made while an item loads through the pointer leaving that stud and the canvas, and places it at the clicked pose once the tables load", async () => {
  const gate = heldConnectivity();
  const { editor, backend } = await startEditor([], gate);

  placerNow(editor, backend)(BASEPLATE, 640, 640);
  const queued = editor.snapshot().queuedPlacement;
  backend.aim(1280, 640);
  editor.pointerMove(0, 0);
  editor.pointerLeave();
  const afterMove = editor.snapshot().queuedPlacement;
  gate.open();
  await settledChoice(editor);
  await vi.waitFor(() => expect(editor.snapshot().queuedPlacement).toBeNull());

  expect({ queued, afterMove, placed: posesOf(editor) }).toEqual({
    queued: { item: BASEPLATE, x: 640, z: 640, rot: 0 },
    afterMove: { item: BASEPLATE, x: 640, z: 640, rot: 0 },
    placed: [`${BASEPLATE} 640,640 y0`],
  });
}, 120_000);

const ROAD_TILE_LDU = 640;
const BASEPLATE_SPAN_LDU = 640;
const WAITING_NOTE = "is still reading its connectors";

const USER_BASEPLATE_MODEL = "baseplate-3811";

async function userBaseplateImport(): Promise<ImportResult> {
  const fixtures = fixtureBundleLoader();
  const record = await fixtures.loadModelRecord("standard", USER_BASEPLATE_MODEL);
  const connectors = await Promise.all(
    record.parts.map((part) => fixtures.loadPartConnectors("standard", part.id)),
  );
  return importedRecord(`${USER_BASEPLATE_MODEL}.ldr`, record, connectors);
}

async function roadPlatesReadingBesideUserBaseplate() {
  const importer = new GatedModelImporter();
  importer.serve(await userBaseplateImport());
  importer.release();
  const gate = heldPartConnectivity("44336p04");
  const started = await startEditor([], gate, [], (bound) =>
    bound.rebind(MODEL_IMPORTER).toConstantValue(importer),
  );
  await started.editor.importModelFile({
    name: `${USER_BASEPLATE_MODEL}.ldr`,
    bytes: new TextEncoder().encode("0 a user's model of a 3811\n"),
  });
  const held = started.editor.snapshot().modelImport?.item ?? "";
  return { ...started, gate, held };
}

function strokeRoad(editor: IEditor, backend: AimedBackend): void {
  const kit = editor.snapshot().roadKits.find((k) => k.label.startsWith("Dark Bluish Grey"));
  if (!kit) throw new Error("no Dark Bluish Grey road kit");
  editor.chooseItem(kit.id);
  backend.aim(ROAD_TILE_LDU / 2, ROAD_TILE_LDU / 2);
  editor.dragStart(0, 0);
  for (const column of [1, 2]) {
    backend.aim(column * ROAD_TILE_LDU + ROAD_TILE_LDU / 2, ROAD_TILE_LDU / 2);
    editor.dragMove(0, 0);
  }
  editor.dragEnd(0, 0, 0);
}

function baseplatesOnRoad(editor: IEditor, baseplate: string): number {
  const { refs, placements } = editor.dump();
  const at = placements.refId.map((ref, i) => ({
    item: refs[ref] ?? "",
    x: placements.x[i] ?? 0,
    z: placements.z[i] ?? 0,
    y: placements.yPlates[i] ?? 0,
  }));
  const roads = at.filter(({ item }) => item.startsWith("ldraw:44336"));
  return at.filter(
    (base) =>
      base.item === baseplate &&
      roads.some(
        (road) =>
          road.y === base.y &&
          Math.abs(road.x - base.x) < BASEPLATE_SPAN_LDU &&
          Math.abs(road.z - base.z) < BASEPLATE_SPAN_LDU,
      ),
  ).length;
}

const OVER_THE_ROAD: Ground = [ROAD_TILE_LDU + ROAD_TILE_LDU / 2, ROAD_TILE_LDU / 2];
const LAST_ROAD_TILE: Ground = [2 * ROAD_TILE_LDU + ROAD_TILE_LDU / 2, ROAD_TILE_LDU / 2];
const BESIDE_THE_ROAD_EDGE: Ground = [ROAD_TILE_LDU + ROAD_TILE_LDU / 2, (3 * ROAD_TILE_LDU) / 2];
const GREY_ROAD_PLATE = "ldraw:44336p04@72";

function clickHeldAt(editor: IEditor, backend: AimedBackend, [x, z]: Ground): void {
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
}

function waitingView(editor: IEditor) {
  const placement = editor.snapshot().hover?.placement;
  const waiting = placement?.waitingOn;
  return {
    waitingOn: waiting
      ? {
          item: waiting.placed.item,
          at: [waiting.placed.pose.x, waiting.placed.pose.z],
          failed: waiting.failed,
        }
      : null,
    accepted: placement?.accepted ?? null,
    settled: placement?.settled ?? null,
  };
}

it.each([
  {
    gesture: "a click over a plate, refused once they load",
    act: (editor: IEditor, backend: AimedBackend) => clickHeldAt(editor, backend, OVER_THE_ROAD),
    release: (gate: HeldText) => gate.open(),
    decided: (editor: IEditor) => editor.snapshot().refusedClicks > 0,
    whileReading: (held: string) => ({
      queued: { item: held, x: OVER_THE_ROAD[0], z: OVER_THE_ROAD[1], rot: 0 },
      hover: {
        waitingOn: { item: GREY_ROAD_PLATE, at: OVER_THE_ROAD, failed: false },
        accepted: false,
        settled: false,
      },
    }),
    decision: () => ({
      placed: [],
      refusal: expect.stringContaining("would overlap Baseplate 32 x 32 Road"),
      hover: { waitingOn: null, accepted: false, settled: true },
    }),
  },
  {
    gesture:
      "a click beside the plates, replayed at the clicked pose after the pointer moves over a plate and off the canvas",
    act: (editor: IEditor, backend: AimedBackend) => {
      clickHeldAt(editor, backend, BESIDE_THE_ROAD_EDGE);
      backend.aim(...OVER_THE_ROAD);
      editor.pointerMove(0, 0);
      editor.pointerLeave();
    },
    release: (gate: HeldText) => gate.open(),
    decided: (editor: IEditor) => editor.snapshot().placements > 3,
    whileReading: (held: string) => ({
      queued: {
        item: held,
        x: BESIDE_THE_ROAD_EDGE[0],
        z: BESIDE_THE_ROAD_EDGE[1],
        rot: 0,
      },
      hover: { waitingOn: null, accepted: null, settled: null },
    }),
    decision: (held: string) => ({
      placed: [`${held} ${BESIDE_THE_ROAD_EDGE[0]},${BESIDE_THE_ROAD_EDGE[1]} y0`],
      refusal: null,
      hover: { waitingOn: null, accepted: null, settled: null },
    }),
  },
  {
    gesture: "a click over a plate, cancelled by Esc before they load",
    act: (editor: IEditor, backend: AimedBackend, held: string) => {
      clickHeldAt(editor, backend, OVER_THE_ROAD);
      editor.chooseItem(null);
      editor.chooseItem(held);
      backend.aim(...OVER_THE_ROAD);
      editor.pointerMove(0, 0);
    },
    release: (gate: HeldText) => gate.open(),
    decided: (editor: IEditor) => editor.snapshot().hover?.placement?.waitingOn === null,
    whileReading: () => ({
      queued: null,
      hover: {
        waitingOn: { item: GREY_ROAD_PLATE, at: OVER_THE_ROAD, failed: false },
        accepted: false,
        settled: false,
      },
    }),
    decision: () => ({
      placed: [],
      refusal: null,
      hover: { waitingOn: null, accepted: false, settled: true },
    }),
  },
  {
    gesture: "a click over a plate whose tables fail to load, refused for that",
    act: (editor: IEditor, backend: AimedBackend) => clickHeldAt(editor, backend, OVER_THE_ROAD),
    release: (gate: HeldText) => gate.fail("503"),
    decided: (editor: IEditor) => editor.snapshot().refusedClicks > 0,
    whileReading: (held: string) => ({
      queued: { item: held, x: OVER_THE_ROAD[0], z: OVER_THE_ROAD[1], rot: 0 },
      hover: {
        waitingOn: { item: GREY_ROAD_PLATE, at: OVER_THE_ROAD, failed: false },
        accepted: false,
        settled: false,
      },
    }),
    decision: () => ({
      placed: [],
      refusal: expect.stringContaining("connector data didn't load"),
      hover: {
        waitingOn: { item: GREY_ROAD_PLATE, at: OVER_THE_ROAD, failed: true },
        accepted: false,
        settled: true,
      },
    }),
  },
  {
    gesture:
      "a hover over the last plate laid, naming that plate rather than the earlier one beside it",
    act: (editor: IEditor, backend: AimedBackend) => {
      backend.aim(...LAST_ROAD_TILE);
      editor.pointerMove(0, 0);
    },
    release: (gate: HeldText) => gate.open(),
    decided: (editor: IEditor) => editor.snapshot().hover?.placement?.waitingOn === null,
    whileReading: () => ({
      queued: null,
      hover: {
        waitingOn: { item: GREY_ROAD_PLATE, at: LAST_ROAD_TILE, failed: false },
        accepted: false,
        settled: false,
      },
    }),
    decision: () => ({
      placed: [],
      refusal: null,
      hover: { waitingOn: null, accepted: false, settled: true },
    }),
  },
  {
    gesture: "a fill across the plates",
    act: (editor: IEditor, backend: AimedBackend) => {
      backend.aim(...OVER_THE_ROAD);
      editor.pointerMove(0, 0);
      editor.dragStart(0, 0);
      backend.aim(3 * ROAD_TILE_LDU, ROAD_TILE_LDU / 2);
      editor.dragMove(0, 0);
      editor.dragEnd(0, 0, 0);
    },
    release: (gate: HeldText) => gate.open(),
    decided: (editor: IEditor) => (editor.snapshot().lastFill?.refused ?? 0) > 0,
    whileReading: () => ({ queued: null, hover: expect.anything() }),
    decision: () => ({ placed: [], refusal: null, hover: expect.anything() }),
  },
])(
  "waits on $gesture while a road stroke's plates read their connector tables, never committing a user's model of a 3811 onto a plate",
  async ({ act, release, decided, whileReading, decision }) => {
    const { editor, backend, frame, gate, held } = await roadPlatesReadingBesideUserBaseplate();
    strokeRoad(editor, backend);
    const laid = posesOf(editor);
    await chosen(editor, held);
    act(editor, backend, held);
    const reading = {
      placed: posesOf(editor).filter((pose) => !laid.includes(pose)),
      queued: editor.snapshot().queuedPlacement,
      hover: waitingView(editor),
    };
    expect({ laid: laid.length, heldRecords: gate.held > 0, reading }).toEqual({
      laid: 3,
      heldRecords: true,
      reading: { placed: [], ...whileReading(held) },
    });
    release(gate);
    await vi.waitFor(() => expect(decided(editor)).toBe(true), { timeout: 60_000 });
    await settledHover(editor, frame);

    expect({
      placed: posesOf(editor).filter((pose) => !laid.includes(pose)),
      onRoad: baseplatesOnRoad(editor, held),
      queued: editor.snapshot().queuedPlacement,
      refusal: editor.snapshot().lastRefusal?.reason ?? null,
      hover: waitingView(editor),
    }).toEqual({ ...decision(held), onRoad: 0, queued: null });
  },
  240_000,
);

it("leaves nothing of a world it switched away from while that world's plates read their connector tables: their arrival places no ghost to collide with", async () => {
  const gate = heldConnectivity();
  const { editor, backend } = await streamingEditor({ models: [], tier: null, fetcher: gate });
  strokeRoad(editor, backend);
  expect(posesOf(editor)).toHaveLength(3);
  await vi.waitFor(() => expect(gate.held).toBeGreaterThan(0));
  expect(await editor.newWorld("Second")).toBe(true);
  gate.open();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const [x, z] = OVER_THE_ROAD;
  expect((await placer(editor, backend)(BASEPLATE, x, z)).placements).toBe(1);
  expect(posesOf(editor)).toEqual([`${BASEPLATE} ${x},${z} y0`]);
}, 120_000);

type PendingNeighbourCommit = (
  editor: IEditor,
  backend: AimedBackend,
  held: string,
) => Promise<void>;

const BESIDE_THE_ROAD: Ground = [ROAD_TILE_LDU + ROAD_TILE_LDU / 2, (3 * ROAD_TILE_LDU) / 2];
const CLEAR_OF_THE_ROAD: Ground = [ROAD_TILE_LDU + ROAD_TILE_LDU / 2, (5 * ROAD_TILE_LDU) / 2];
const ON_THE_ROAD: Ground = [ROAD_TILE_LDU + ROAD_TILE_LDU / 2, ROAD_TILE_LDU / 2];

const clickOnRoad =
  (mode: "assist" | "precise"): PendingNeighbourCommit =>
  async (editor, backend, held) => {
    editor.setPlacementMode(mode);
    await chosen(editor, held);
    backend.aim(...ON_THE_ROAD);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
  };

const COMMITS_THAT_READ_A_VERDICT: Readonly<
  Record<
    EditKind,
    | ReadonlyArray<{
        readonly path: string;
        readonly first: Ground | null;
        readonly commit: PendingNeighbourCommit;
      }>
    | string
  >
> = {
  place: [
    { path: "an assist click", first: null, commit: clickOnRoad("assist") },
    { path: "a precise click", first: null, commit: clickOnRoad("precise") },
    {
      path: "a paste",
      first: CLEAR_OF_THE_ROAD,
      commit: async (editor, backend) => {
        selectAt(editor, backend, ...CLEAR_OF_THE_ROAD);
        editor.copySelection();
        editor.pasteClipboard();
        backend.aim(...ON_THE_ROAD);
        editor.pointerMove(0, 0);
        editor.click(0, 0, 0);
      },
    },
  ],
  fill: [
    {
      path: "a fill",
      first: null,
      commit: async (editor, backend, held) => {
        await chosen(editor, held);
        backend.aim(...ON_THE_ROAD);
        editor.pointerMove(0, 0);
        editor.dragStart(0, 0);
        backend.aim(3 * ROAD_TILE_LDU, ROAD_TILE_LDU / 2);
        editor.dragMove(0, 0);
        editor.dragEnd(0, 0, 0);
      },
    },
  ],
  move: [
    {
      path: "a move onto the road",
      first: CLEAR_OF_THE_ROAD,
      commit: async (editor, backend) => {
        selectAt(editor, backend, ...CLEAR_OF_THE_ROAD);
        editor.moveSelectionBy(0, ON_THE_ROAD[1] - CLEAR_OF_THE_ROAD[1], 0);
      },
    },
  ],
  rotate: [
    {
      path: "a turn beside the road",
      first: BESIDE_THE_ROAD,
      commit: async (editor, backend) => {
        selectAt(editor, backend, ...BESIDE_THE_ROAD);
        editor.turnSelectedModelTo(1, 0);
      },
    },
  ],
  remove: [
    {
      path: "a delete beside the road",
      first: BESIDE_THE_ROAD,
      commit: async (editor, backend) => {
        selectAt(editor, backend, ...BESIDE_THE_ROAD);
        editor.deleteSelection(0);
      },
    },
  ],
  road: "lays road plates by road joins, not by the placement search",
  "lay-track": "lays track against the drawing's own obstacles, which wait on seats",
  "throw-switch": "throws a switch without placing a model",
  plan: "edits plan regions only",
  "open-plan":
    "opens a plan file through the paste path's checks, and a neighbour still reading its connectors refuses the open as a file error",
};

it.each(
  Object.entries(COMMITS_THAT_READ_A_VERDICT).flatMap(([kind, paths]) =>
    typeof paths === "string" ? [] : paths.map((row) => ({ kind, ...row })),
  ),
)(
  "$kind: $path of a user's model of a 3811 beside a road plate still reading its connector tables waits and commits nothing",
  async ({ first, commit }) => {
    const { editor, backend, gate, held } = await roadPlatesReadingBesideUserBaseplate();
    if (first) await placer(editor, backend)(held, ...first);
    strokeRoad(editor, backend);
    const before = layoutState(editor).poses;
    await commit(editor, backend, held);
    const { queuedPlacement, lastFill, selectionRefusal } = editor.snapshot();
    const waits =
      queuedPlacement !== null ||
      (lastFill?.reason ?? "").includes(WAITING_NOTE) ||
      (selectionRefusal ?? "").includes(WAITING_NOTE);
    gate.open();

    expect({ poses: layoutState(editor).poses, waits }).toEqual({ poses: before, waits: true });
  },
  240_000,
);

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
    (bound) => bound.rebind(MODEL_IMPORTER).toConstantValue(importer),
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
  const { editor, container } = await startEditor([], hidden, [], (bound) =>
    bound.rebind(MODEL_IMPORTER).toConstantValue(new ImporterBringing(["ldraw:3811"], [record])),
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

function dragFill(
  editor: IEditor,
  backend: AimedBackend,
  from: readonly [number, number],
  to: readonly [number, number],
): void {
  backend.aim(from[0], from[1]);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
  backend.aim(to[0], to[1]);
  editor.pointerMove(0, 0);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
}

function placedPoses(editor: IEditor, refId: number) {
  const { x, z, yPlates, refId: refs } = editor.dump().placements;
  return x
    .map((at, i) => ({ x: at, z: z[i] ?? 0, yPlates: yPlates[i] ?? 0, refId: refs[i] }))
    .filter((pose) => pose.refId === refId)
    .map(({ x: px, z: pz, yPlates: py }) => [px, pz, py] as const)
    .toSorted((a, b) => a[1] - b[1] || a[0] - b[0]);
}

it("fills a dragged row with a user's model at its own size rounded up to the 8-, 16- or 32-stud grid, each tile resting where a click there would put it", async () => {
  const userModel = "brick-2x4";
  const { editor, backend, catalog } = await startEditor([], new BundleDirectoryFetcher(), [
    userModel,
  ]);
  const brick = `omr:${userModel}`;
  await loadCatalogItem(catalog, brick);
  const refId = catalog.itemRefId(brick) ?? -1;
  await chosen(editor, brick);
  const steps: number[][] = [];
  for (const _ of [8, 16, 32]) {
    dragFill(editor, backend, [0, 0], [1300, 10]);
    const xs = placedPoses(editor, refId).map(([x]) => x);
    steps.push(xs.slice(1).map((x, i) => x - (xs[i] ?? 0)));
    editor.undo(0);
    editor.cycleFillGrid();
  }
  dragFill(editor, backend, [0, 0], [1300, 10]);
  const row = placedPoses(editor, refId);
  editor.undo(0);
  const under = row[2] ?? [0, 0, 0];
  backend.aim(under[0], under[1]);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  dragFill(editor, backend, [0, 0], [1300, 10]);

  expect(steps).toEqual([Array(8).fill(160), Array(4).fill(320), Array(2).fill(640)]);
  expect(placedPoses(editor, refId).filter(([, , y]) => y > 0)).toEqual([[under[0], under[1], 3]]);
  expect(editor.snapshot().lastFill).toEqual({
    item: brick,
    placed: row.length,
    refused: 0,
    alreadyThere: 0,
    reason: null,
  });
}, 120_000);

it("skips and reports the tiles a click would refuse, counts the tiles already holding that plate as already there, places the rest, and one undo takes the whole fill back", async () => {
  const { editor, backend, catalog } = await startEditor([]);
  const refId = catalog.itemRefId(BASEPLATE) ?? -1;
  const place = placer(editor, backend);
  editor.setPlacementMode("precise");
  expect((await place(BASEPLATE, 960, 320)).placements).toBe(1);
  expect((await place(BASEPLATE, 1640, 320)).placements).toBe(2);
  editor.setPlacementMode("assist");
  editor.cycleFillGrid();
  editor.cycleFillGrid();
  const seen = () => {
    const { placements, lastFill, history } = editor.snapshot();
    return {
      placements,
      placed: lastFill?.placed ?? null,
      refused: lastFill?.refused ?? null,
      alreadyThere: lastFill?.alreadyThere ?? null,
      overlap:
        lastFill?.reason?.includes(
          "would overlap Baseplate 32 x 32's bounds in 3811 Baseplate 32 x 32",
        ) ?? null,
      undo: history.undoLabel,
    };
  };

  dragFill(editor, backend, [0, 0], [1900, 10]);
  const filled = seen();
  editor.undo(0);
  const undone = seen();
  editor.redo(0);

  expect(filled).toEqual({
    placements: 3,
    placed: 1,
    refused: 1,
    alreadyThere: 1,
    overlap: true,
    undo: "fill (1 placement)",
  });
  expect(undone).toEqual({
    placements: 2,
    placed: null,
    refused: null,
    alreadyThere: null,
    overlap: null,
    undo: "place",
  });
  expect(placedPoses(editor, refId)).toEqual([
    [320, 320, 0],
    [960, 320, 0],
    [1640, 320, 0],
  ]);
}, 120_000);

it("fills the active plan's tables with a user's model, inside the tables, and the plan counts every tile", async () => {
  const userModel = "brick-2x4";
  const { editor, catalog, container } = await startEditor([], new BundleDirectoryFetcher(), [
    userModel,
  ]);
  const brick = `omr:${userModel}`;
  await loadCatalogItem(catalog, brick);
  const plans = container.get(PLAN_SERVICE);
  const { planId } = plans.drawTable({ minX: -160, minZ: 0, maxX: 1440, maxZ: 640 });
  await chosen(editor, brick);

  editor.fillTables(0);
  const filled = {
    placements: editor.snapshot().placements,
    inside: plans.insideCount(planId),
    issues: plans.issues(planId).length,
  };
  editor.undo(0);

  expect(filled).toEqual({ placements: 40, inside: 40, issues: 0 });
  expect({ placements: editor.snapshot().placements, inside: plans.insideCount(planId) }).toEqual({
    placements: 0,
    inside: 0,
  });
}, 120_000);

it.each([{ snapRoads: true }, { snapRoads: false }] as const)(
  "with road snapping $snapRoads, fills road straights against a dual carriageway's end without refusing the tile whose end mismatches it, and the readout counts the mismatch",
  async ({ snapRoads }) => {
    const { editor, backend } = await startEditor([]);
    await placer(editor, backend)(DUAL_CARRIAGEWAY, 320, -320);
    editor.setSnapRoads(snapRoads);
    await chosen(editor, ROAD_STRAIGHT);
    editor.cycleFillGrid();
    editor.cycleFillGrid();

    dragFill(editor, backend, [0, 0], [1900, 1900]);
    const { lastFill, roads, placements } = editor.snapshot();

    expect({
      refused: lastFill?.refused ?? 0,
      mismatched: roads.mismatchedCells > 0,
      placements,
    }).toEqual({ refused: 0, mismatched: true, placements: 1 + 9 });
  },
  120_000,
);

it("refuses a fill tile where a held train would stand on the rails, and places the rest on the ground", async () => {
  const { editor, backend, catalog } = await startEditor([LOCOMOTIVE.slice(4)]);
  drawOval(editor, backend);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  await chosen(editor, LOCOMOTIVE);

  dragFill(editor, backend, [-640, -640], [640, 640]);
  const { lastFill, placements } = editor.snapshot();

  expect({
    placed: lastFill?.placed,
    refusedSome: (lastFill?.refused ?? 0) > 0,
    reason: lastFill?.reason,
    placements,
    trains: trainsOf(editor),
  }).toEqual({
    placed: placements,
    refusedSome: true,
    reason: `${LOCOMOTIVE_LABEL} would stand on the rails there. Set it on the rails with a click.`,
    placements: expect.any(Number),
    trains: [],
  });
  expect(placements).toBeGreaterThan(0);
}, 120_000);

it("offers the fill grid key only while a part is in hand, and leaves selecting and the camera live everywhere", async () => {
  const { editor } = await startEditor([]);
  const live = (id: CommandId) => commandEnabled(id, editor.snapshot());
  const selecting = (["cycle-fill-grid", "select-tool", "fit-all", "zoom-in"] as const).map(live);
  await chosen(editor, BASEPLATE);
  const placing = (["cycle-fill-grid", "select-tool", "fit-all", "zoom-in"] as const).map(live);

  expect({ selecting, placing }).toEqual({
    selecting: [false, true, true, true],
    placing: [true, true, true, true],
  });
}, 120_000);

it("cancels a fill mid-drag with the part kept in hand, so its release places nothing and the next drag starts afresh", async () => {
  const { editor, backend } = await startEditor([]);
  await chosen(editor, BASEPLATE);
  backend.aim(0, 0);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
  backend.aim(1900, 1900);
  editor.pointerMove(0, 0);
  editor.dragMove(0, 0);
  const drafted = editor.snapshot().fillDraft?.wanted ?? 0;
  const cancellable = commandEnabled("cancel", editor.snapshot());
  editor.cancelGesture();
  editor.dragEnd(0, 0, 0);
  const released = {
    placements: editor.snapshot().placements,
    fillDraft: editor.snapshot().fillDraft,
    lastFill: editor.snapshot().lastFill,
    held: editor.snapshot().activeItem,
    cancellable: commandEnabled("cancel", editor.snapshot()),
  };
  dragFill(editor, backend, [0, 0], [1260, 10]);

  expect({ drafted: drafted > 1, cancellable }).toEqual({ drafted: true, cancellable: true });
  expect(released).toEqual({
    placements: 0,
    fillDraft: null,
    lastFill: null,
    held: BASEPLATE,
    cancellable: false,
  });
  expect(editor.snapshot().lastFill?.placed).toBe(editor.snapshot().placements);
  expect(editor.snapshot().placements).toBe(2);
}, 120_000);

const RAISED_ROAD = "ldraw:69958@72";
const USER_TRACK = "switch-then-reversed-curve";
const DRAG_STEP_LDU = 40;
const QUARTER_TURN_STEPS = 4;
const REACH_LDU = 400;
const ONE_STRAIGHT_LDU = 320;

type PlanPoint = readonly [number, number];

function trackDrawer(editor: IEditor, backend: AimedBackend) {
  return (from: PlanPoint, to: PlanPoint) => {
    editor.chooseItem(TRACK_ITEM_ID);
    backend.aim(from[0], from[1]);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / DRAG_STEP_LDU);
    for (let step = 1; step <= steps; step++) {
      backend.aim(
        from[0] + ((to[0] - from[0]) * step) / steps,
        from[1] + ((to[1] - from[1]) * step) / steps,
      );
      editor.dragMove(0, 0);
    }
    editor.dragEnd(0, 0, 0);
    const { track } = editor.snapshot();
    return {
      pieces: track?.pieces ?? 0,
      lastCommit: track?.lastCommit ?? null,
      lastBlock: track?.lastBlock ?? null,
      lastWithheld: track?.lastWithheld ?? null,
      lastUnsupported: track?.lastUnsupported ?? null,
    };
  };
}

async function supportChecked(editor: IEditor): Promise<void> {
  await vi.waitFor(() => {
    expect(editor.dump().studChecks).toBe(0);
    expect(editor.snapshot().track?.unsupported).not.toBeNull();
  });
}

function holdAndClick(editor: IEditor, backend: AimedBackend, piece: string, at: PlanPoint) {
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${piece}`);
  backend.aim(at[0], at[1]);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  const { refusedClicks, lastRefusal, track } = editor.snapshot();
  return { refusedClicks, reason: lastRefusal?.reason ?? null, pieces: track?.pieces ?? 0 };
}

async function crossingOverRoad(inUsersModel: boolean) {
  const { editor, backend } = await startImportingEditor();
  const place = placer(editor, backend);
  if (inUsersModel) {
    const street = userRoadFile("my-street-with-grass.ldr", [
      "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336p04.dat",
      "1 2 640 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    ]);
    await place(await importUserFile(editor, "my-street-with-grass.ldr", street), 320, 0);
  } else {
    await place(ROAD_STRAIGHT, 0, 0);
    await place(BASEPLATE_32, 640, 0);
  }
  await supportChecked(editor);
  const across = trackDrawer(editor, backend)([-480, 0], [480, 0]);
  return { pieces: across.pieces, crossings: editor.dump().crossings };
}

it("lays track across the road inside a user's own street model as the same level crossing, ramps and all, as across the palette's road plate", async () => {
  const palette = await crossingOverRoad(false);
  expect(palette.crossings).toHaveLength(1);
  expect(palette.crossings[0]?.roadwayCells).toBeGreaterThan(0);
  expect(await crossingOverRoad(true)).toEqual(palette);
}, 240_000);

it("lays a run across a road plate's roadway as a level crossing reported unsupported, with ramps on the verge studs; a raised plate stops a run short and can't be dropped onto track", async () => {
  const { editor, backend } = await startEditor([]);
  const place = placer(editor, backend);
  const draw = trackDrawer(editor, backend);
  await place(ROAD_STRAIGHT, 0, 0);
  await supportChecked(editor);

  const across = draw([-480, 0], [480, 0]);
  const hud = toolHints(editor.snapshot());
  const [crossing, ...others] = editor.dump().crossings;
  expect(across).toMatchObject({
    lastCommit: "laid",
    lastBlock: null,
    lastWithheld: null,
    lastUnsupported: {
      pieces: expect.any(Number),
      block: { kind: "model", label: expect.stringContaining("44336p04"), unseated: true },
    },
  });
  expect(hud).toMatchObject({
    title: "Laid unsupported",
    detail: expect.stringContaining("where it has no studs"),
  });
  expect(editor.snapshot().track?.unsupported).toBeGreaterThan(0);
  expect(others).toEqual([]);
  expect(crossing?.ramps.length).toBeGreaterThan(0);
  for (const ramp of crossing?.ramps ?? []) expect(ramp.studMates).toBeGreaterThan(0);

  await place(RAISED_ROAD, 0, 1600);
  const through = draw([-800, 1600], [480, 1600]);
  expect(through.lastBlock).toEqual({
    kind: "model",
    label: expect.stringContaining("69958"),
    unseated: false,
  });

  editor.setSnapRoads(false);
  const onto = await place(RAISED_ROAD, -500, 0);
  expect(onto.reason).toMatch(/69958 .* would cross the track laid there\./u);
}, 120_000);

it("stops a run short at a user's brick model or track it doesn't join and names it, refuses a held piece or the model dropped onto track, and lays a run that joins an open end", async () => {
  const { editor, backend, catalog } = await startEditor([], new BundleDirectoryFetcher(), [
    USER_BRICK,
  ]);
  const brick = `omr:${USER_BRICK}`;
  await loadCatalogItem(catalog, brick);
  const place = placer(editor, backend);
  const draw = trackDrawer(editor, backend);
  await place(brick, 0, 0);
  const label = editor.snapshot().catalog.find((item) => item.id === brick)?.label ?? brick;

  const throughBrick = draw([-480, 0], [480, 0]);
  const beside = draw([-480, 400], [480, 400]);
  const acrossTrack = draw([440, -300], [440, 700]);
  const fromOpenEnd = draw([480, 400], [800, 400]);
  const heldOntoBrick = holdAndClick(editor, backend, TRACK_STRAIGHT, [0, 0]);
  editor.chooseItem(null);
  const brickOntoTrack = await place(brick, 0, 400);

  expect(throughBrick.lastBlock).toEqual({ kind: "model", label, unseated: false });
  expect(beside).toMatchObject({ lastCommit: "laid", lastBlock: null });
  expect(acrossTrack.lastBlock).toEqual({ kind: "track" });
  expect(fromOpenEnd.pieces).toBeGreaterThan(acrossTrack.pieces);
  expect(fromOpenEnd).toMatchObject({ lastCommit: "laid", lastBlock: null });
  expect(heldOntoBrick).toMatchObject({
    pieces: fromOpenEnd.pieces,
    reason: `Train Track 9V Straight would run into ${label}.`,
  });
  expect(brickOntoTrack.reason).toBe(`${label} would cross the track laid there.`);
}, 120_000);

function outwardFrom(
  end: { readonly xLdu: number; readonly zLdu: number; readonly heading: number },
  reach: number,
) {
  const radians = (end.heading * Math.PI) / (2 * QUARTER_TURN_STEPS);
  return [end.xLdu + reach * Math.cos(radians), end.zLdu + reach * Math.sin(radians)] as const;
}

it("lets a run start from or close onto the open end of a user's track model and stops one short at its track", async () => {
  const { editor, backend, catalog } = await startEditor([], new BundleDirectoryFetcher(), [
    USER_TRACK,
  ]);
  const container = `omr:${USER_TRACK}`;
  await loadCatalogItem(catalog, container);
  await placer(editor, backend)(container, 0, 0);
  const draw = trackDrawer(editor, backend);
  const [from, onto] = editor
    .dump()
    .trackEnds.filter(
      (open) =>
        open.heading % QUARTER_TURN_STEPS === 0 &&
        Number.isInteger(open.xLdu / 20) &&
        Number.isInteger(open.zLdu / 20),
    );
  if (!from || !onto) {
    throw new Error(`${USER_TRACK} has no two open ends on the stud grid facing a quarter turn`);
  }

  const joined = draw([from.xLdu, from.zLdu], outwardFrom(from, REACH_LDU));
  const closed = draw(outwardFrom(onto, ONE_STRAIGHT_LDU), [onto.xLdu, onto.zLdu]);
  const stillOpen = editor.dump().trackEnds;
  const crossing = draw([-160, -600], [-160, 400]);

  expect(joined).toMatchObject({ pieces: 1, lastCommit: "laid", lastBlock: null });
  expect(closed).toMatchObject({ pieces: 2, lastCommit: "joined", lastBlock: null });
  expect(stillOpen).not.toContainEqual(
    expect.objectContaining({ xLdu: onto.xLdu, zLdu: onto.zLdu }),
  );
  expect(crossing.lastBlock).toEqual({ kind: "track" });
}, 120_000);

function overlapIssues(issues: ReadonlyArray<string>): number {
  return issues.filter((issue) => issue.startsWith("overlap: ")).length;
}

it("keeps a plan's overlap and support after every edit exactly as reopening the world measures them, across overlapping and floating models loaded from a stored world", async () => {
  const userModel = "brick-2x4";
  const repository = new MemoryRepository();
  const { editor, backend, catalog, container } = await startEditor(
    [],
    new BundleDirectoryFetcher(),
    [userModel],
    (bound) => bound.rebind(WORLD_REPOSITORY).toConstantValue(repository),
  );
  const plans = container.get(PLAN_SERVICE);
  const brick = `omr:${userModel}`;
  await loadCatalogItem(catalog, brick);
  const { planId } = plans.drawTable({ minX: 0, minZ: 0, maxX: 1920, maxZ: 1280 });
  expect(await editor.newWorld("Built")).toBe(true);
  const built = editor.snapshot().world?.id ?? "";
  const place = placer(editor, backend);
  await place(BASEPLATE, 640, 640);
  await place(brick, 520, 520);
  await place(brick, 760, 760);
  await place(brick, 800, 760);
  await place(brick, 1400, 640);
  const laid = posesOf(editor);
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(5));
  const copy = await repository.copyWith(built, "Loaded", (placements) => {
    const onTable = placements.find((p) => p.x === 1400 && p.z === 640);
    const onPlate = placements.find((p) => p.x === 520 && p.z === 520);
    if (!onTable || !onPlate) throw new Error("the built world lacks its bricks");
    return [
      { ...onTable, x: onTable.x + 20 },
      { ...onPlate, x: onPlate.x + 40, yPlates: onPlate.yPlates + 6 },
    ];
  });
  let stored = 12;
  const issues = async () => {
    await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
    return plans
      .issues(planId)
      .map((issue) => `${issue.rule}: ${issue.message}`)
      .toSorted();
  };
  const step = async (edit: () => Promise<void> | void, placements: number) => {
    await edit();
    const poses = posesOf(editor);
    const incremental = await issues();
    stored += placements;
    await vi.waitFor(() => expect(repository.storedPlacements()).toBe(stored));
    expect(await editor.openWorld(built)).toBe(true);
    expect(await editor.openWorld(copy)).toBe(true);
    return { poses, turns: turnsOf(editor), incremental, reopened: await issues() };
  };
  const remove = (x: number, z: number) => () => {
    selectAt(editor, backend, x, z);
    editor.deleteSelection(0);
  };
  const moveOverlapPartner = () => {
    selectAt(editor, backend, 1400, 640);
    editor.moveSelectionBy(0, 200, 0);
  };

  expect(await editor.openWorld(copy)).toBe(true);
  const loaded = await issues();
  const steps = {
    removedAndUndone: await step(() => {
      remove(1400, 640)();
      editor.undo(0);
    }, 0),
    stackedOnTheOverlap: await step(async () => {
      await place(brick, 1400, 680);
    }, 1),
    stackedRemoved: await step(remove(1400, 660), -1),
    partnerMovedAndUndone: await step(() => {
      moveOverlapPartner();
      editor.undo(0);
    }, 0),
    partnerMovedAway: await step(moveOverlapPartner, 0),
    movedTurnedUndoneRedone: await step(() => {
      selectAt(editor, backend, 1410, 840);
      editor.rotate(0);
      editor.undo(0);
      editor.redo(0);
    }, 0),
    pairMovedUndoneRedone: await step(() => {
      selectAt(editor, backend, 1410, 840);
      backend.aim(1410, 640);
      editor.toggleSelected(0, 0);
      editor.moveSelectionBy(-200, 0, 0);
      editor.undo(0);
      editor.redo(0);
    }, 0),
    baseplateRemoved: await step(remove(400, 900), -1),
    floatingHeldFromBelow: await step(async () => {
      await place(brick, 500, 520);
    }, 1),
    floatingRemovedUndoneRedone: await step(() => {
      remove(580, 520)();
      editor.undo(0);
      editor.redo(0);
    }, -1),
  };

  expect(laid).toEqual(
    [
      expect.stringMatching(/ 640,640 y0$/u),
      `${brick} 520,520 y0`,
      `${brick} 760,760 y0`,
      `${brick} 800,760 y3`,
      `${brick} 1400,640 y0`,
    ].toSorted(),
  );
  expect(loaded.filter((issue) => !issue.startsWith("bomMapping"))).toEqual([
    expect.stringMatching(/^overlap: /u),
    expect.stringMatching(/^overlap: /u),
    expect.stringMatching(/^unsupported: brick-2x4 at 560, 520 /u),
  ]);
  for (const { incremental, reopened } of Object.values(steps)) {
    expect(incremental).toEqual(reopened);
  }
  expect(Object.values(steps).map((done) => overlapIssues(done.incremental))).toEqual([
    2, 2, 2, 2, 0, 0, 0, 0, 0, 0,
  ]);
  expect(steps.partnerMovedAway.poses).toContainEqual(expect.stringMatching(/ 14[02]0,840 y0$/u));
  expect(steps.movedTurnedUndoneRedone.turns).not.toEqual(steps.partnerMovedAway.turns);
  expect(steps.pairMovedUndoneRedone.poses).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/ 12[02]0,640 y0$/u),
      expect.stringMatching(/ 12[02]0,840 y0$/u),
    ]),
  );
  expect(steps.floatingHeldFromBelow.poses).toContainEqual(
    expect.stringMatching(/ 5[0-2]0,520 y3$/u),
  );
  expect(steps.floatingHeldFromBelow.incremental).not.toContainEqual(
    expect.stringMatching(/^unsupported: /u),
  );
  expect(steps.stackedOnTheOverlap.poses).toContain(`${brick} 1400,660 y3`);
  expect(steps.baseplateRemoved.poses).not.toContainEqual(expect.stringMatching(/ 640,640 y0$/u));
}, 240_000);

it("fills a user's track container across a road plate's roadway as track the plan reports unsupported, and skips the tiles whose track would cross laid track", async () => {
  const { editor, backend, catalog, container } = await startEditor(
    [],
    new BundleDirectoryFetcher(),
    [USER_TRACK],
  );
  const carrier = `omr:${USER_TRACK}`;
  await loadCatalogItem(catalog, carrier);
  const plans = container.get(PLAN_SERVICE);
  const { planId } = plans.drawTable({ minX: -1920, minZ: -1920, maxX: 1920, maxZ: 1920 });
  await placer(editor, backend)(ROAD_STRAIGHT, 0, 0);
  await supportChecked(editor);
  const label = editor.snapshot().catalog.find((item) => item.id === carrier)?.label ?? carrier;
  const outcome = () => {
    const unsupported = plans.issues(planId).filter((issue) => issue.rule === "unsupported");
    return {
      lastFill: editor.snapshot().lastFill,
      unsupportedTrack: editor.snapshot().track?.unsupported ?? 0,
      carriersFlagged: unsupported.filter((issue) => issue.message.startsWith(label)).length,
    };
  };

  await chosen(editor, carrier);
  dragFill(editor, backend, [-1140, 0], [1420, 10]);
  await supportChecked(editor);
  const acrossRoadway = outcome();
  editor.undo(0);
  const undone = outcome();
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [0, 2000], [0, 2960]);
  await chosen(editor, carrier);
  dragFill(editor, backend, [-1280, 2480], [1280, 2490]);
  const acrossTrack = editor.snapshot().lastFill;

  expect(acrossRoadway.lastFill).toMatchObject({ item: carrier, refused: 0, reason: null });
  expect(acrossRoadway.lastFill?.placed).toBeGreaterThan(1);
  expect(acrossRoadway.unsupportedTrack).toBeGreaterThan(0);
  expect(acrossRoadway.carriersFlagged).toBeGreaterThan(0);
  expect(undone).toMatchObject({ unsupportedTrack: 0, carriersFlagged: 0 });
  expect(acrossTrack).toMatchObject({
    item: carrier,
    reason: `${label} would cross the track laid there.`,
  });
  expect(acrossTrack?.refused).toBeGreaterThan(0);
  expect(acrossTrack?.placed).toBeGreaterThan(0);
}, 120_000);

it("loads track support again on the next edit after a failed load, then reports unsupported track and clears the error", async () => {
  let offline = true;
  const { editor, backend } = await startEditor([], new BundleDirectoryFetcher(), [], (bound) => {
    const tables = bound.get(CONNECTOR_TABLES);
    bound.rebind(CONNECTOR_TABLES).toConstantValue({
      load: (placeable) =>
        offline ? Promise.reject(new Error("offline")) : tables.load(placeable),
      loaded: (placeable) => tables.loaded(placeable),
    });
  });
  await vi.waitFor(() =>
    expect(editor.snapshot().catalogError).toBe("track connector records can't be read: offline"),
  );
  const unknown = editor.snapshot().track?.unsupported ?? null;

  offline = false;
  await placer(editor, backend)(ROAD_STRAIGHT, 0, 0);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-24 * STUD, 0], [24 * STUD, 0]);
  await supportChecked(editor);

  expect(unknown).toBeNull();
  expect(editor.snapshot().track?.unsupported).toBeGreaterThan(0);
  expect(editor.snapshot().catalogError).toBeNull();
}, 120_000);

const MY_COTTAGE = [
  "0 Custom cottage built from official parts",
  "0 Name: my-cottage.ldr",
  "0 Author: lug-layout tests, after the experience audit's custom cottage",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
  "1 15 -40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 -40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 -60 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 15 60 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 4 -40 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 -40 -48 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 40 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 40 -48 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "",
].join("\n");

function sheetTexts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map((match) =>
    (match[1] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  );
}

function sheetPaths(svg: string, kind: string): string[] {
  return [...svg.matchAll(/<path class="([^"]*)" d="([^"]*)"\/>/gu)]
    .filter((match) => (match[1] ?? "").split(" ")[0] === kind)
    .map((match) => match[2] ?? "");
}

it("prints a plan of tables drawn on the canvas, a road plate with track laid across it and a user's own cottage: tables dimensioned in studs and cm, every placement numbered in plan order, track by its outline, and a key that totals the parts list", async () => {
  const { editor, backend, container } = await startEditor(
    [],
    new BundleDirectoryFetcher(),
    [],
    (bound) =>
      bound
        .rebind(MODEL_IMPORTER)
        .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER))),
  );
  const plans = container.get(PLAN_SERVICE);
  const { planId } = plans.drawTable({ minX: -640, minZ: -640, maxX: 640, maxZ: 640 });
  plans.drawTable({ minX: 640, minZ: -640, maxX: 1280, maxZ: 640 });
  const place = placer(editor, backend);
  await place(ROAD_STRAIGHT, 0, 0);
  await supportChecked(editor);
  trackDrawer(editor, backend)([-480, 0], [480, 0]);
  await editor.importModelFile({
    name: "my-cottage.ldr",
    bytes: new TextEncoder().encode(MY_COTTAGE),
  });
  const cottage = editor.snapshot().modelImport?.item ?? "";
  await place(cottage, 960, 320);
  editor.chooseItem(null);
  await supportChecked(editor);

  const svg = container.get(PLAN_SHEET_SERVICE).printable(editor, planId);
  const bom = await container.get(BOM_SERVICE).billOfMaterials(editor, { kind: "plan", planId });
  const texts = sheetTexts(svg);
  const key = texts.slice(texts.indexOf("Key: numbers on the plan") + 4);
  const rows = Array.from({ length: 5 }, (_, i) => key.slice(i * 3, i * 3 + 3));

  expect(texts).toEqual(
    expect.arrayContaining([
      "64 studs · 51.2 cm",
      "32 studs · 25.6 cm",
      "room 96 studs · 76.8 cm",
      "Parts list: 15 parts in 5 part and colour lines, from 5 placements",
      expect.stringMatching(/^Not buildable as planned yet: /u),
    ]),
  );
  expect(rows).toEqual([
    ["1", "1", expect.stringMatching(/^44336p04 .* at 0, 0$/u)],
    ["2", "11", expect.stringMatching(/^my-cottage\.ldr.* at 960, 320$/u)],
    ["3", "1", expect.stringMatching(/^Train Track 9V Straight #1/u)],
    ["4", "1", expect.stringMatching(/^Train Track 9V Straight #2/u)],
    ["5", "1", expect.stringMatching(/^Train Track 9V Straight #3/u)],
  ]);
  expect(key.slice(15, 17)).toEqual(["15", "Total: 5 placements"]);
  expect({ parts: bom.parts, placements: bom.placements, lines: bom.ldraw.length }).toEqual({
    parts: 15,
    placements: 5,
    lines: 5,
  });

  expect(sheetPaths(svg, "model")).toHaveLength(2);
  expect(sheetPaths(svg, "track").map((d) => d.split("M").length - 1)).toEqual([8, 8, 8]);
  expect(svg).toContain('class="roadway"');
  expect(sheetPaths(svg, "ramp")).toHaveLength(4);
}, 120_000);

const SEAT_LEVEL_MODULE = "mils-plain";

it("re-plans a track drag in flight against the new obstacles when a seat-level import's studs land, and shows it before the pointer moves again", async () => {
  const importer = new GatedModelImporter();
  const { editor, backend, container } = await startEditor(
    [],
    new BundleDirectoryFetcher(),
    [],
    (bound) => bound.rebind(MODEL_IMPORTER).toConstantValue(importer),
  );
  const record = await container
    .get(PART_BUNDLE_LOADER)
    .loadModelRecord("standard", SEAT_LEVEL_MODULE);
  importer.serve(importedRecord("module.mpd", record));
  await editor.importModelFile({
    name: "module.mpd",
    bytes: new TextEncoder().encode("0 a plain module, its studs still being checked\n"),
  });
  await placer(editor, backend)(editor.snapshot().modelImport?.item ?? "", -12_800, -12_800);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [320, 320], [2_240, 320]);
  const [west, east] = editor.dump().trackEnds.toSorted((a, b) => a.xLdu - b.xLdu);
  if (!west || !east) throw new Error("the run left no open ends");
  backend.aim(east.xLdu, east.zLdu);
  editor.dragStart(0, 0);
  backend.aim(west.xLdu, west.zLdu);
  editor.dragMove(0, 0);
  const whilePending = editor.snapshot().track?.drag?.closure;

  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  const landed = editor.snapshot().track?.drag?.closure;
  editor.dragMove(0, 0);

  expect(whilePending).toBe("pending");
  expect(landed).not.toBe("pending");
  expect(landed).toBe(editor.snapshot().track?.drag?.closure);
}, 120_000);

async function trackOwnerEditor() {
  const importer = new GatedModelImporter();
  const started = await startEditor([], new BundleDirectoryFetcher(), [], (bound) => {
    bound.rebind(MODEL_IMPORTER).toConstantValue(importer);
    bound.rebind(INDEXED_DB).toConstantValue(new IDBFactory());
  });
  const record = await started.container
    .get(PART_BUNDLE_LOADER)
    .loadModelRecord("standard", PLACEABLE_SET);
  importer.serve(importedRecord("carrier.mpd", record));
  return { ...started, importer };
}

function trackFacts(editor: IEditor) {
  const track = editor.snapshot().track;
  return {
    ends: editor.dump().trackEnds,
    openEnds: track?.openEnds,
    gaps: track?.gaps,
    switches: track?.switches,
    bom: track?.bom,
    joins: track?.joins,
    models: [track?.modelPieces, track?.runFramePieces, track?.offField, track?.unanchored],
    crossings: track?.crossings,
  };
}

async function reopenedFresh(editor: IEditor) {
  const { bytes } = await editor.exportWorld();
  const fresh = await trackOwnerEditor();
  fresh.importer.release();
  expect(await fresh.editor.importWorld(bytes)).toBe(true);
  await vi.waitFor(() => {
    expect(fresh.editor.snapshot().placements).toBe(editor.snapshot().placements);
    expect(fresh.editor.snapshot().studChecks).toBe(0);
  });
  return fresh;
}

function laySwitchAt(editor: IEditor, backend: AimedBackend, x: number, z: number): void {
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
}

function throwFirstSwitch(editor: IEditor, backend: AimedBackend): void {
  const lever = editor.snapshot().track?.switches[0];
  if (!lever) throw new Error("no switch to throw");
  editor.chooseItem(TRACK_ITEM_ID);
  backend.aim(lever.xLdu, lever.zLdu);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
  editor.dragEnd(0, 0, 0);
}

it("gives the track view after each kind of edit that a fresh editor gives on reopening the saved world", async () => {
  const { editor, backend, importer } = await trackOwnerEditor();
  const checked: string[] = [];
  let previous = trackFacts(editor);
  const matchesReopened = async (
    edit: string,
    changes: ReadonlyArray<keyof ReturnType<typeof trackFacts>>,
  ) => {
    const facts = trackFacts(editor);
    for (const field of changes) {
      expect(facts[field], `${edit} changes ${field}`).not.toEqual(previous[field]);
    }
    previous = facts;
    const fresh = await reopenedFresh(editor);
    expect(facts, `${edit}`).toEqual(trackFacts(fresh.editor));
    checked.push(edit);
  };

  laySwitchAt(editor, backend, 0, 0);
  const end = editor.dump().trackEnds.find((open) => open.heading === 0);
  if (!end) throw new Error("the switch has no end at heading 0");
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(
    editor,
    backend,
    [onLattice(end.xLdu), onLattice(end.zLdu)],
    [onLattice(end.xLdu) + 96 * STUD, onLattice(end.zLdu)],
  );
  await matchesReopened("lay", ["ends", "bom", "joins"]);
  throwFirstSwitch(editor, backend);
  await matchesReopened("switch throw", ["switches"]);
  editor.undo(0);
  await matchesReopened("undo", ["switches"]);
  editor.redo(0);
  await matchesReopened("redo", ["switches"]);
  await vi.waitFor(() => expect(editor.snapshot().world?.save).toBe("saved"));
  const first = editor.snapshot().world?.id;
  if (!first) throw new Error("no current world");
  expect(await editor.newWorld("Other")).toBe(true);
  expect(await editor.openWorld(first)).toBe(true);
  await matchesReopened("openWorld", []);
  expect(await editor.importWorld((await editor.exportWorld()).bytes)).toBe(true);
  await matchesReopened("replaceWorld", []);
  const item = await importChecking(editor);
  await placer(editor, backend)(item, 0, 120 * STUD);
  await matchesReopened("import a model that carries track", ["models", "ends"]);
  importer.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));
  await matchesReopened("stud-landing swap", []);
  editor.chooseItem(null);
  selectAt(editor, backend, 0, 120 * STUD);
  editor.deleteSelection(0);
  await matchesReopened("remove the model", ["models", "ends"]);

  expect(checked).toHaveLength(9);
}, 300_000);

const FREE_SAMPLE: Ground = [0, -160 * STUD];
const NEAR_MISS_LAY: Ground = [3 * STUD, -158 * STUD];
const END_OFFSET_LDU = 5 * STUD;

function heldSamples(editor: IEditor): ReadonlyArray<Ground> {
  const samples: Ground[] = [FREE_SAMPLE];
  for (const end of editor.dump().trackEnds) {
    const x = onLattice(end.xLdu);
    const z = onLattice(end.zLdu);
    samples.push([x, z], [x + END_OFFSET_LDU, z]);
  }
  return samples;
}

function hoveredHeld(editor: IEditor, backend: AimedBackend, samples: ReadonlyArray<Ground>) {
  return samples.map(([x, z]) => {
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    const held = editor.snapshot().track?.held;
    return {
      at: [x, z],
      snapped: held?.snapped,
      joins: held?.joins,
      misses: held?.misses,
      ends: editor.dump().trackEnds,
    };
  });
}

it("snaps a held switch, and counts the ends it misses, as a fresh editor does after each edit made while holding it", async () => {
  const { editor, backend, importer } = await trackOwnerEditor();
  importer.release();
  const item = await importChecking(editor);
  await placer(editor, backend)(item, 0, 120 * STUD);
  laySwitchAt(editor, backend, 0, 0);
  const samples = heldSamples(editor);
  const piece = `${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`;
  const edits: ReadonlyArray<readonly [string, () => void]> = [
    [
      "lay beside the free sample",
      () => {
        backend.aim(...NEAR_MISS_LAY);
        editor.pointerMove(0, 0);
        editor.click(0, 0, 0);
      },
    ],
    ["undo the lay", () => editor.undo(0)],
    ["undo the switch", () => editor.undo(0)],
    ["undo the carrier", () => editor.undo(0)],
    ["redo the carrier", () => editor.redo(0)],
    ["redo the switch", () => editor.redo(0)],
  ];
  const missesAtFree: number[] = [];
  for (const [edit, made] of edits) {
    editor.chooseItem(piece);
    hoveredHeld(editor, backend, samples.toReversed());
    made();
    expect(editor.snapshot().activeItem, `${edit}`).toBe(piece);
    const after = hoveredHeld(editor, backend, samples);
    missesAtFree.push(after[0]?.misses ?? -1);
    const fresh = await reopenedFresh(editor);
    fresh.editor.chooseItem(piece);
    expect(after, `${edit}`).toEqual(hoveredHeld(fresh.editor, fresh.backend, samples));
  }

  expect(missesAtFree[0]).toBeGreaterThan(missesAtFree[1] ?? 0);
}, 300_000);

it("publishes nothing for a pointer move that stays on the same stud, and the new hover for one that leaves it", async () => {
  const { editor, backend } = await startEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${NINE_VOLT_STRAIGHT}`);
  backend.aim(0, 40 * STUD);
  editor.pointerMove(0, 0);
  const before = editor.snapshot();
  let published = 0;
  editor.subscribe(() => published++);

  backend.aim(STUD / 4, 40 * STUD);
  editor.pointerMove(0, 0);
  const stayed = { published, same: editor.snapshot() === before };
  backend.aim(STUD, 40 * STUD);
  editor.pointerMove(0, 0);

  expect(stayed).toEqual({ published: 0, same: true });
  expect(published).toBe(1);
  expect(editor.snapshot().hover).toMatchObject({ x: STUD, z: 40 * STUD });
}, 120_000);

const PIER_PLATES = 5;
const TALLEST_TRAIN = "10014-1";
const BRIDGE_PLATES = 39;
const BESIDE_BRIDGE_LDU = 6 * STUD;
const PIER_SIDE_SLOPE = 10;
const PIER_SIDE_INSET_LDU = 30;
const PIER_BRICK = "ldraw:3001";
const PIER_PLATE = "ldraw:3020";

async function raisedEditor(models: ReadonlyArray<string>, repository = new MemoryRepository()) {
  const started = await startEditor(models, new BundleDirectoryFetcher(), [], (bound) => {
    bound
      .rebind(MODEL_IMPORTER)
      .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
    bound.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  });
  const place = placer(started.editor, started.backend);
  for (const x of [-32, 0, 32]) {
    for (const z of [-32, 0, 32]) await place(BASEPLATE, x * STUD, z * STUD);
  }
  return started;
}

async function piersPlaced(editor: IEditor): Promise<void> {
  await vi.waitFor(() => expect(editor.snapshot().track?.placingPiers).toBe(false), {
    timeout: 60_000,
  });
}

async function layRaised(
  editor: IEditor,
  backend: AimedBackend,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> {
  dragTrack(editor, backend, from, to);
  await piersPlaced(editor);
}

function placedImports(editor: IEditor) {
  const { refs, placements } = editor.dump();
  return placements.refId.flatMap((ref, i) =>
    refs[ref]?.startsWith("import:")
      ? [
          {
            ref: refs[ref] ?? "",
            x: placements.x[i] ?? 0,
            z: placements.z[i] ?? 0,
            yPlates: placements.yPlates[i] ?? 0,
            rot: placements.rot[i] ?? 0,
          },
        ]
      : [],
  );
}

function catalogLabel(editor: IEditor, ref: string): string {
  return editor.snapshot().catalog.find((item) => item.id === ref)?.label ?? ref;
}

function laidHeights(editor: IEditor) {
  return editor.dump().laidTrack.map((piece) => [piece.yPlates, piece.rise ?? 0]);
}

function selectFromSide(editor: IEditor, backend: AimedBackend, x: number, z: number) {
  editor.chooseItem(null);
  backend.aim(x, z - PIER_SIDE_INSET_LDU, PIER_SIDE_SLOPE);
  editor.click(0, 0, 0);
  return editor.snapshot().selection?.primary ?? null;
}

it("lays raised runs on generated brick piers of real parts without announcing them as a model import, each piece held only by its anti-studs on a pier's studs: joined, reported unsupported once its pier is removed, and undone and redone with its piers as one edit", async () => {
  const { editor, backend, catalog } = await raisedEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(PIER_PLATES);
  await layRaised(editor, backend, [-32 * STUD, 0], [0, 0]);
  await layRaised(editor, backend, [16 * STUD, 0], [48 * STUD, 0]);
  await layRaised(editor, backend, [0, 0], [16 * STUD, 0]);
  const closed = editor.snapshot().track?.lastCommit;
  const announced = editor.snapshot().modelImport;
  const piers = placedImports(editor);
  const pierRef = piers[0]?.ref ?? "";
  const pier = catalog.placeables()[catalog.itemRefId(pierRef) ?? -1];
  const pierParts = Array.from(pier?.parts.partIndex ?? [], (index) => catalog.parts()[index]?.id);
  const supported = editor.snapshot().track?.unsupported;
  const laid = editor.dump().laidTrack.length;
  const heights = laidHeights(editor);
  const raisedLabels = editor.snapshot().labels.filter((label) => label.kind === "height");
  const removed = selectFromSide(editor, backend, piers[0]?.x ?? 0, piers[0]?.z ?? 0);
  editor.deleteSelection(0);
  const afterRemoval = editor.snapshot().track?.unsupported;
  editor.undo(0);
  const pierBack = editor.snapshot().track?.unsupported;
  const before = layoutState(editor);
  editor.undo(0);
  const undone = { laid: editor.dump().laidTrack.length, piers: placedImports(editor).length };
  editor.redo(0);

  expect(closed).toBe("joined");
  expect(announced).toBeNull();
  expect(catalogLabel(editor, pierRef)).toBe(`track-pier-${PIER_PLATES}-plates.ldr`);
  expect(pierParts.toSorted()).toEqual([PIER_BRICK, PIER_PLATE, PIER_PLATE]);
  expect(heights).toEqual(Array.from({ length: laid }, () => [PIER_PLATES, 0]));
  expect(piers).toHaveLength(laid);
  expect(piers.every((placed) => placed.ref === pierRef && placed.yPlates === 0)).toBe(true);
  expect(supported).toBe(0);
  expect(raisedLabels.length).toBeGreaterThan(0);
  expect(raisedLabels.every((label) => label.text.startsWith(`${PIER_PLATES} plates`))).toBe(true);
  expect(removed).toMatchObject({ kind: "model", item: pierRef });
  expect(afterRemoval).toBe(1);
  expect(pierBack).toBe(0);
  expect(undone).toEqual({ laid: laid - 1, piers: laid - 1 });
  expect(layoutState(editor)).toEqual(before);
}, 180_000);

function clearanceOutcome(editor: IEditor, ground: number) {
  const track = editor.snapshot().track;
  return {
    commit: track?.lastCommit,
    block: track?.lastBlock,
    raised: editor.dump().laidTrack.length - ground,
    lowClearance: track?.lowClearance,
    lastLow: track?.lastLowClearance,
  };
}

it("lays a bridge over laid track wherever its own height clears, reports one lower than the tallest train as a finding the plan lists, and refuses it only where a train standing below would be hit", async () => {
  const { editor, backend, catalog, container } = await raisedEditor([TALLEST_TRAIN]);
  const plans = container.get(PLAN_SERVICE);
  const { planId } = plans.drawTable({ minX: -960, minZ: -960, maxX: 960, maxZ: 960 });
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-8 * STUD, -40 * STUD], [-8 * STUD, 40 * STUD]);
  const ground = editor.dump().laidTrack.length;
  editor.raiseTrack(BRIDGE_PLATES - 1);
  await vi.waitFor(() => expect(editor.snapshot().track?.height.tallestTrain).not.toBeNull(), {
    timeout: 60_000,
  });
  const tallest = editor.snapshot().track?.height.tallestTrain;
  await layRaised(editor, backend, [-32 * STUD, 0], [16 * STUD, 0]);
  const low = clearanceOutcome(editor, ground);
  const hint = toolHints(editor.snapshot());
  const issues = plans
    .issues(planId)
    .filter((issue) => issue.rule === "clearance")
    .map((issue) => issue.message);
  const labels = editor
    .snapshot()
    .labels.filter((label) => label.kind === "height" && label.text.includes("clear"))
    .map((label) => label.text);
  await loadCatalogItem(catalog, CABOOSE);
  const place = placer(editor, backend);
  const underLowBridge = await place(CABOOSE, -8 * STUD, -BESIDE_BRIDGE_LDU);
  editor.chooseItem(null);
  editor.undo(0);
  const issuesUndone = plans.issues(planId).filter((issue) => issue.rule === "clearance");
  const seated = await place(CABOOSE, -8 * STUD, -BESIDE_BRIDGE_LDU);
  editor.chooseItem(TRACK_ITEM_ID);
  await layRaised(editor, backend, [-32 * STUD, 0], [16 * STUD, 0]);
  const throughTrain = clearanceOutcome(editor, ground);
  editor.undo(0);
  editor.raiseTrack(1);
  await layRaised(editor, backend, [-32 * STUD, 0], [16 * STUD, 0]);
  const overTrain = clearanceOutcome(editor, ground);
  const caboose = editor.snapshot().catalog.find((item) => item.id === CABOOSE)?.label ?? CABOOSE;
  const tooLow = `too low for the tallest train: ${TALLEST_TRAIN} needs ${BRIDGE_PLATES} plates, this bridge has ${BRIDGE_PLATES - 1}`;

  expect(tallest?.model).toBe(TALLEST_TRAIN);
  expect(tallest?.heightLdu).toBeCloseTo(282.92, 2);
  expect(low).toEqual({
    commit: "laid",
    block: null,
    raised: 3,
    lowClearance: 1,
    lastLow: {
      pieces: 1,
      needPlates: BRIDGE_PLATES,
      hasPlates: BRIDGE_PLATES - 1,
      train: TALLEST_TRAIN,
    },
  });
  expect(hint).toMatchObject({ tone: "warn", title: "Laid too low", detail: tooLow });
  expect(issues).toEqual([expect.stringContaining(tooLow)]);
  expect(issuesUndone).toEqual([]);
  expect(labels).toEqual([`35 plates (112 mm) clear: too low for ${TALLEST_TRAIN}`]);
  expect(underLowBridge).toMatchObject({
    refusedClicks: 1,
    reason: expect.stringContaining("would run into raised track"),
  });
  expect(seated).toMatchObject({ refusedClicks: 1 });
  expect(trainsOf(editor)).toEqual([[CABOOSE, true]]);
  expect(throughTrain).toMatchObject({
    commit: "laid",
    block: { kind: "model", label: caboose, unseated: false },
    raised: 1,
  });
  expect(overTrain).toMatchObject({ commit: "laid", block: null, raised: 3, lowClearance: 0 });
}, 180_000);

const MY_PIER = `0 My viaduct pier
0 Name: my-viaduct-pier.ldr
0 Author: A Builder
1 15 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 3022.dat
1 15 0 -16 0 1 0 0 0 1 0 0 0 1 3022.dat
`;

it("holds raised track on a user's own pier of official parts exactly like a generated one, and builds piers only where nothing holds a piece already", async () => {
  const { editor, backend } = await raisedEditor([]);
  const imported = await editor.importModelFile({
    name: "my-viaduct-pier.ldr",
    bytes: new TextEncoder().encode(MY_PIER),
  });
  const mine = editor.snapshot().modelImport?.item ?? "";
  const placed = placerNow(editor, backend)(mine, -8 * STUD, 0);
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(PIER_PLATES);
  await layRaised(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  const imports = placedImports(editor);

  expect(imported).toBe(true);
  expect(placed).toMatchObject({ refusedClicks: 0 });
  expect(imports.filter((pier) => pier.ref === mine)).toHaveLength(1);
  expect(imports.filter((pier) => pier.ref !== mine)).toHaveLength(1);
  expect(laidHeights(editor)).toEqual([
    [PIER_PLATES, 0],
    [PIER_PLATES, 0],
  ]);
  expect(editor.snapshot().track?.unsupported).toBe(0);
}, 180_000);

it("ramps a run from a raised end toward the drawing height one plate per straight on generated piers under its raised ends, so it counts as supported until a pier under one of its joints is removed, and refuses a join it can't climb to in its pieces as too steep", async () => {
  const { editor, backend } = await raisedEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [32 * STUD, 0], [48 * STUD, 0]);
  editor.raiseTrack(PIER_PLATES);
  await layRaised(editor, backend, [-48 * STUD, 0], [-32 * STUD, 0]);
  await layRaised(editor, backend, [-32 * STUD, 0], [32 * STUD, 0]);
  const steep = editor.snapshot().track?.lastCommit;
  const levelPiers = new Set(placedImports(editor).map((pier) => `${pier.x},${pier.z}`));
  editor.raiseTrack(-PIER_PLATES);
  await layRaised(editor, backend, [-32 * STUD, 0], [16 * STUD, 0]);
  const ramp = laidHeights(editor).slice(2);
  const rampPiers = placedImports(editor).filter((pier) => !levelPiers.has(`${pier.x},${pier.z}`));
  const rested = editor.snapshot().track?.unsupported;
  const joint = rampPiers.find((pier) => pier.x === 0);
  selectFromSide(editor, backend, joint?.x ?? 0, joint?.z ?? 0);
  editor.deleteSelection(0);
  const jointBare = editor.snapshot().track?.unsupported;

  expect(steep).toBe("refused-too-steep");
  expect(ramp).toEqual([
    [PIER_PLATES, -1],
    [PIER_PLATES - 1, -1],
    [PIER_PLATES - 2, -1],
  ]);
  expect(
    rampPiers.map((pier) => [pier.x, pier.yPlates]).toSorted(([a = 0], [b = 0]) => a - b),
  ).toEqual([
    [-16 * STUD, 0],
    [0, 0],
    [16 * STUD, 0],
  ]);
  expect(rested).toBe(0);
  expect(jointBare).toBe(2);
}, 180_000);

const MY_RAMP_PIER = `0 My ramp pier
0 Name: my-ramp-pier.ldr
0 Author: A Builder
1 15 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 3022.dat
`;

it("holds a ramp joint on a user's own pier of official parts as on a generated one: the pieces meeting there are unsupported while it has no pier, and supported again once the user's pier seats their end rows at the joint's height", async () => {
  const { editor, backend } = await raisedEditor([]);
  await editor.importModelFile({
    name: "my-ramp-pier.ldr",
    bytes: new TextEncoder().encode(MY_RAMP_PIER),
  });
  const mine = editor.snapshot().modelImport?.item ?? "";
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(PIER_PLATES);
  await layRaised(editor, backend, [-48 * STUD, 0], [-32 * STUD, 0]);
  const levelPiers = new Set(placedImports(editor).map((pier) => `${pier.x},${pier.z}`));
  editor.raiseTrack(-PIER_PLATES);
  await layRaised(editor, backend, [-32 * STUD, 0], [16 * STUD, 0]);
  const joint = placedImports(editor).find(
    (pier) => !levelPiers.has(`${pier.x},${pier.z}`) && pier.x === -16 * STUD,
  );
  selectFromSide(editor, backend, joint?.x ?? 0, joint?.z ?? 0);
  editor.deleteSelection(0);
  const bare = editor.snapshot().track?.unsupported;
  editor.setPlacementMode("precise");
  await chosen(editor, mine);
  const placed = placerNow(editor, backend)(mine, -16 * STUD, -3 * STUD);

  expect(bare).toBe(2);
  expect(placed).toMatchObject({ refusedClicks: 0 });
  expect(placedImports(editor).filter((pier) => pier.ref === mine)).toHaveLength(1);
  expect(editor.snapshot().track?.unsupported).toBe(0);
}, 180_000);

class StudsLandLaterImporter implements IModelImporter {
  private readonly gate = Promise.withResolvers<void>();

  constructor(private readonly inner: IModelImporter) {}

  release(): void {
    this.gate.resolve();
  }

  async importText(
    fileName: string,
    text: string,
    lod?: BundleLod,
    onPlaced?: PlacementListener,
  ): Promise<ImportResult> {
    const result = await this.inner.importText(fileName, text, lod);
    if (!result.bake) throw new Error(`${fileName} has no bake`);
    const { bake, report, studio: _studio, ...shape } = result;
    const { studCover: _studCover, ...placement } = bake;
    onPlaced?.({
      ...shape,
      sections: report.sections,
      refusedConnectorRecords: report.refusedConnectorRecords,
      bake: placement,
    });
    await this.gate.promise;
    return result;
  }

  importStudio(): Promise<ImportResult> {
    throw new Error("piers are LDraw files");
  }

  rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return this.inner.rollingDiagnostics([], "standard");
  }
}

it("waits for a generated pier's studs to be checked before laying the raised run on it, then lays the run and its piers together", async () => {
  let importer: StudsLandLaterImporter | null = null;
  const started = await startEditor([], new BundleDirectoryFetcher(), [], (bound) => {
    importer = new StudsLandLaterImporter(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
    bound.rebind(MODEL_IMPORTER).toConstantValue(importer);
  });
  const { editor, backend } = started;
  const place = placer(editor, backend);
  for (const x of [-32, 0, 32]) await place(BASEPLATE, x * STUD, 0);
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(PIER_PLATES);
  dragTrack(editor, backend, [-16 * STUD, 0], [16 * STUD, 0]);
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(1));
  const waiting = {
    placing: editor.snapshot().track?.placingPiers,
    laid: editor.dump().laidTrack.length,
    piers: placedImports(editor).length,
  };
  (importer as StudsLandLaterImporter | null)?.release();
  await vi.waitFor(() => expect(editor.snapshot().track?.placingPiers).toBe(false));

  expect(waiting).toEqual({ placing: true, laid: 0, piers: 0 });
  expect(laidHeights(editor)).toEqual([
    [PIER_PLATES, 0],
    [PIER_PLATES, 0],
  ]);
  expect(placedImports(editor)).toHaveLength(2);
  expect(editor.snapshot().track?.unsupported).toBe(0);
}, 180_000);

const ROOF_BRICK = "1 4 40 -311 10 1 0 0 0 1 0 0 0 1 3005.dat";
const BRICK_LDU = 24;

async function myTallCaboose(): Promise<Uint8Array> {
  const official = await pinnedOmrModel("10014-1.mpd");
  const lines = official.replaceAll("10014 - ", "my tall caboose - ").split("\n");
  const car = lines.findIndex((line) => line.startsWith("0 FILE my tall caboose - train car"));
  lines.splice(car + 1, 0, ROOF_BRICK);
  return new TextEncoder().encode(lines.join("\n"));
}

it("measures the tallest train from every train in the catalog, and again when a user imports a taller one, which it then names", async () => {
  const { editor } = await raisedEditor([TALLEST_TRAIN]);
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(1);
  const tallest = () => editor.snapshot().track?.height.tallestTrain ?? null;
  await vi.waitFor(() => expect(tallest()).not.toBeNull(), { timeout: 60_000 });
  const bundled = tallest();
  const imported = await editor.importModelFile({
    name: "my-tall-caboose.mpd",
    bytes: await myTallCaboose(),
  });
  await vi.waitFor(() => expect(tallest()?.model).toBe("my-tall-caboose.mpd"), { timeout: 60_000 });

  expect(imported).toBe(true);
  expect(bundled?.model).toBe(TALLEST_TRAIN);
  expect(tallest()?.heightLdu).toBeGreaterThanOrEqual((bundled?.heightLdu ?? 0) + BRICK_LDU);
}, 180_000);

function byPlace(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return a.x - b.x || a.z - b.z;
}

it("reopens a saved world with its raised run, its generated piers and a ramp's rises exactly as laid, the run still held by its piers", async () => {
  const { editor, backend } = await raisedEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-48 * STUD, -16 * STUD], [-32 * STUD, -16 * STUD]);
  editor.raiseTrack(PIER_PLATES);
  await layRaised(editor, backend, [-32 * STUD, -16 * STUD], [16 * STUD, -16 * STUD]);
  await layRaised(editor, backend, [-16 * STUD, 16 * STUD], [16 * STUD, 16 * STUD]);
  const laid = { state: layoutState(editor), unsupported: editor.snapshot().track?.unsupported };
  const piers = placedImports(editor).toSorted(byPlace);
  const first = editor.snapshot().world?.id ?? "";
  await editor.newWorld("Second");
  const fresh = editor.dump().laidTrack.length;
  const reopened = await editor.openWorld(first);
  await vi.waitFor(() => expect(editor.snapshot().track?.unsupported).toBe(laid.unsupported), {
    timeout: 30_000,
  });

  expect(laid.state.laidTrack.some((piece) => (piece.rise ?? 0) !== 0)).toBe(true);
  expect(placedImports(editor).toSorted(byPlace)).toEqual(piers);
  expect({ fresh, reopened }).toEqual({ fresh: 0, reopened: true });
  expect({ state: layoutState(editor), unsupported: editor.snapshot().track?.unsupported }).toEqual(
    laid,
  );
}, 180_000);

async function raisedEditorOn(repository: MemoryRepository) {
  return startEditor([], new BundleDirectoryFetcher(), [], (bound) => {
    bound
      .rebind(MODEL_IMPORTER)
      .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
    bound.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  });
}

it("reports a reopened world's raised run as held by its piers as soon as it opens, and once their studs are checked when they check later, without the track tool open", async () => {
  const repository = new MemoryRepository();
  const first = await raisedEditor([], repository);
  first.editor.chooseItem(TRACK_ITEM_ID);
  first.editor.raiseTrack(PIER_PLATES);
  await layRaised(first.editor, first.backend, [-16 * STUD, 0], [16 * STUD, 0]);
  first.editor.chooseItem(null);
  const laid = first.editor.snapshot().track?.unsupported;
  await vi.waitFor(() => expect(first.editor.snapshot().world?.save).toBe("saved"));
  const reopened = await raisedEditorOn(repository);
  await vi.waitFor(() => expect(reopened.editor.snapshot().studChecks).toBe(0));
  const opened = reopened.editor.snapshot().track?.unsupported;
  let importer: StudsLandLaterImporter | null = null;
  const { editor } = await startEditor([], new BundleDirectoryFetcher(), [], (bound) => {
    importer = new StudsLandLaterImporter(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
    bound.rebind(MODEL_IMPORTER).toConstantValue(importer);
    bound.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  });
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBeGreaterThan(0));
  const checking = editor.snapshot().track?.unsupported;
  (importer as StudsLandLaterImporter | null)?.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0));

  expect(laid).toBe(0);
  expect(opened).toBe(laid);
  expect(checking).not.toBe(laid);
  await vi.waitFor(() => expect(editor.snapshot().track?.unsupported).toBe(laid));
  expect(editor.snapshot().mode).not.toBe("track");
}, 180_000);

const MY_STREET = userRoadFile("my-street.ldr", ["1 72 0 0 0 1 0 0 0 1 0 0 0 1 69958.dat"]);
const ROW_X = -1280;

function editorOnRepository(
  repository: MemoryRepository,
  importer: (inThread: IModelImporter) => IModelImporter,
) {
  return startEditor([PLAIN_MODULE_MODEL], new BundleDirectoryFetcher(), [], (bound) => {
    const loader = bound.get(PART_BUNDLE_LOADER);
    const records = { read: (partId: string) => loader.readPartConnectors("standard", partId) };
    bound
      .rebind(MODEL_IMPORTER)
      .toConstantValue(importer(new InThreadModelImporter(loader, records)));
    bound.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  });
}

async function openedWithStudsChecked(repository: MemoryRepository, landing: "early" | "late") {
  let held: StudsLandLaterImporter | null = null;
  const started = await editorOnRepository(repository, (inThread) => {
    held = new StudsLandLaterImporter(inThread);
    if (landing === "early") held.release();
    return held;
  });
  const { editor, backend, container } = started;
  const checking = editor.snapshot().studChecks;
  (held as StudsLandLaterImporter | null)?.release();
  await vi.waitFor(() => expect(editor.snapshot().studChecks).toBe(0), { timeout: 60_000 });
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: 4000,
    roomDepthMm: 4000,
    originChunkX: -2,
    originChunkZ: -2,
  });
  await vi.waitFor(() => expect(plans.unmeasuredCount(planId)).toBe(0), { timeout: 60_000 });
  await vi.waitFor(
    () => {
      const { farTier, meshes } = editor.snapshot();
      expect({ farTier, settled: meshesSettled(meshes) }).toEqual({
        farTier: "ready",
        settled: true,
      });
    },
    { timeout: 60_000 },
  );
  const issues = plans.issues(planId).map((issue) => issue.message);
  const chunks = [...backend.chunks].toSorted(([a], [b]) => a - b);
  expect(selectAt(editor, backend, 320, 500)?.item).toBe(PLAIN_MODULE);
  editor.deleteSelection(0);
  return {
    checking,
    opened: {
      dump: editor.dump(),
      chunks,
      issues,
      refusal: editor.snapshot().selectionRefusal,
    },
  };
}

it("opens a world that places a user's own file the same whether its studs are checked before or after it opens", async () => {
  const repository = new MemoryRepository();
  const saving = await editorOnRepository(repository, (inThread) => inThread);
  const street = await importUserFile(saving.editor, "my-street.ldr", MY_STREET);
  await loadCatalogItem(saving.catalog, PLAIN_MODULE);
  const place = placer(saving.editor, saving.backend);
  await place(street, ROW_X, 200);
  await place(RECESSED_ROAD_PLATE, ROW_X, 600);
  await place(street, ROW_X, 1000);
  await place(PLAIN_MODULE, 320, 320);
  await place(street, 160, 160);
  await place(RECESSED_ROAD_PLATE, 480, 160);
  saving.editor.chooseItem(null);
  const placed = posesOf(saving.editor);
  await vi.waitFor(() => expect(saving.editor.snapshot().world?.save).toBe("saved"));

  const early = await openedWithStudsChecked(repository, "early");
  const late = await openedWithStudsChecked(repository, "late");

  expect(placed.filter((pose) => !pose.endsWith(" y0"))).toHaveLength(2);
  expect({ early: early.checking, late: late.checking }).toEqual({ early: 0, late: 1 });
  expect(late.opened.issues.length).toBeGreaterThan(2);
  expect(early.opened.refusal).toContain("my-street.ldr rests on it");
  expect(late.opened).toEqual(early.opened);
}, 240_000);

function previewHeightAt(editor: IEditor): readonly [number, number] | null {
  const label = editor.snapshot().labels.find((shown) => shown.id === "height:preview");
  return label ? [label.x, label.z] : null;
}

function eastmostEnd(editor: IEditor): readonly [number, number] {
  const ends = editor.dump().trackEnds;
  const east = ends.reduce((a, b) => (b.xLdu > a.xLdu ? b : a), ends[0] ?? { xLdu: 0, zLdu: 0 });
  return [east.xLdu, east.zLdu];
}

it("shows a raised preview's ghost and height where the previewed run ends, on every move of a growing drag and for the extension chosen next", async () => {
  const { editor, backend } = await startEditor([]);
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(PIER_PLATES);
  backend.aim(0, 0);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
  const shownWhileDragging = [16, 32, 48].map((studs) => {
    backend.aim(studs * STUD, 0);
    editor.dragMove(0, 0);
    return { height: previewHeightAt(editor), ghostPieces: backend.ghostInstances };
  });
  editor.dragEnd(0, 0, 0);
  await piersPlaced(editor);
  const draggedPieces = editor.dump().laidTrack.length;
  const dragged = eastmostEnd(editor);
  backend.aim(...dragged);
  editor.pointerMove(0, 0);
  const offered = editor.snapshot().track?.extend?.choices ?? [];
  editor.selectTrackChoice(offered.findIndex((choice) => choice.kind === "straight"));
  const shownForExtension = {
    height: previewHeightAt(editor),
    ghostPieces: backend.ghostInstances,
  };
  editor.extendTrack(null, 0);
  await piersPlaced(editor);

  expect(shownWhileDragging.map((shown) => shown.ghostPieces)).toEqual([1, 2, draggedPieces]);
  expect(new Set(shownWhileDragging.map((shown) => String(shown.height))).size).toBe(3);
  expect(shownWhileDragging.at(-1)?.height).toEqual(dragged);
  expect(shownForExtension).toEqual({
    height: eastmostEnd(editor),
    ghostPieces: editor.dump().laidTrack.length - draggedPieces,
  });
}, 120_000);

const STEEP_RAMP_PLATES = 2;

function laidHeightTexts(editor: IEditor): ReadonlySet<string> {
  return new Set(
    editor
      .snapshot()
      .labels.filter((label) => label.kind === "height" && label.id !== "height:preview")
      .map((label) => label.text),
  );
}

async function drawnWithHeightSet(late: boolean) {
  const { editor, backend } = await startEditor([]);
  const shown = () => ({
    height: editor.snapshot().track?.height,
    preview: previewHeightAt(editor),
    ghostPieces: backend.ghostInstances,
  });
  const dragFromEnd = async (
    from: readonly [number, number],
    to: readonly [number, number],
    change: () => void,
  ) => {
    if (!late) change();
    backend.aim(...from);
    editor.pointerMove(0, 0);
    editor.dragStart(0, 0);
    backend.aim(...to);
    editor.dragMove(0, 0);
    if (late) change();
    const dragging = shown();
    editor.dragEnd(0, 0, 0);
    await piersPlaced(editor);
    return dragging;
  };
  const hoverAt = (at: readonly [number, number], change: () => void) => {
    if (!late) change();
    backend.aim(...at);
    editor.pointerMove(0, 0);
    if (late) change();
    return { ...shown(), hover: editor.snapshot().hover };
  };
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-48 * STUD, 0], [-16 * STUD, 0]);
  editor.setTrackRampPlates(STEEP_RAMP_PLATES);
  const raisedMidDrag = await dragFromEnd([-16 * STUD, 0], [32 * STUD, 0], () =>
    editor.raiseTrack(PIER_PLATES),
  );
  const rampedMidDrag = await dragFromEnd([-48 * STUD, 0], [-96 * STUD, 0], () =>
    editor.setTrackRampPlates(1),
  );
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
  const held = hoverAt([0, 48 * STUD], () => editor.raiseTrack(1));
  editor.click(0, 0, 0);
  await piersPlaced(editor);
  editor.chooseItem(TRACK_ITEM_ID);
  const readout = hoverAt([0, -48 * STUD], () => editor.setTrackRampPlates(STEEP_RAMP_PLATES));
  const laid = laidHeights(editor);
  const heldLabels = laidHeightTexts(editor);
  editor.undo(0);
  const undoneLabels = laidHeightTexts(editor);
  return { raisedMidDrag, rampedMidDrag, held, readout, laid, heldLabels, undoneLabels };
}

it("draws drags in flight, a held piece and the height readout at a drawing height or ramp rate changed under them, as if it had been set first", async () => {
  const early = await drawnWithHeightSet(false);
  const late = await drawnWithHeightSet(true);

  expect(early.held.hover?.yPlates).toBe(PIER_PLATES + 1);
  expect(early.readout.height?.rampPlates).toBe(STEEP_RAMP_PLATES);
  expect([...early.heldLabels].some((text) => text.startsWith(`${PIER_PLATES + 1} plates`))).toBe(
    true,
  );
  expect([...early.undoneLabels].some((text) => text.startsWith(`${PIER_PLATES + 1} plates`))).toBe(
    false,
  );
  expect(early.laid.some(([yPlates = 0, rise = 0]) => yPlates > 0 && rise > 0)).toBe(true);
  expect(late).toEqual(early);
}, 180_000);

const TUNNEL_WALL_SIDE_LDU = 140;
const SECOND_RUN_Z = 40 * STUD;

function tunnelFile(name: string, wallBricks: number): Uint8Array {
  const wall = (side: number) =>
    Array.from(
      { length: wallBricks },
      (_, k) => `1 7 ${side} ${-BRICK_LDU * (k + 1)} 0 0 0 1 0 1 0 -1 0 0 2456.dat`,
    );
  const roofY = -BRICK_LDU * wallBricks - PLATE_LDU;
  return userRoadFile(name, [
    ...wall(-TUNNEL_WALL_SIDE_LDU),
    ...wall(TUNNEL_WALL_SIDE_LDU),
    `1 72 0 ${roofY} 0 1 0 0 0 1 0 0 0 1 3027.dat`,
  ]);
}

async function heldAlongTrack(
  editor: IEditor,
  backend: AimedBackend,
  frame: () => Promise<void>,
  item: string,
  x: number,
  z = 0,
) {
  await chosen(editor, item);
  if (editor.snapshot().ghostRot % 2 === 0) editor.rotate(0, 1);
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  await settledHover(editor, frame);
  return editor.snapshot().hover?.refusal ?? null;
}

it("refuses a train set where its body meets a model over the track and a model held through a standing train, naming the other, while a tunnel tall enough takes the train", async () => {
  const { editor, backend, frame, catalog } = await startImportingEditor(undefined, [
    LOCOMOTIVE.slice(4),
  ]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-64 * STUD, 0], [64 * STUD, 0]);
  dragTrack(editor, backend, [-64 * STUD, SECOND_RUN_Z], [64 * STUD, SECOND_RUN_Z]);
  editor.chooseItem(null);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  const low = await importUserFile(editor, "my-low-tunnel.ldr", tunnelFile("my-low-tunnel.ldr", 3));
  const tall = await importUserFile(editor, "my-tunnel.ldr", tunnelFile("my-tunnel.ldr", 12));
  const place = settledPlacer(editor, backend);

  const standing = await place(LOCOMOTIVE, 0, 0);
  const lowOverTrain = await heldAlongTrack(editor, backend, frame, low, 0);
  const tallOverTrain = await heldAlongTrack(editor, backend, frame, tall, 0);
  editor.click(0, 0, 0);
  const tunnelsAfterTall = editor.snapshot().placements;
  await heldAlongTrack(editor, backend, frame, low, 0, SECOND_RUN_Z);
  editor.click(0, 0, 0);
  const underLowTunnel = await place(LOCOMOTIVE, 0, SECOND_RUN_Z);

  expect({
    standing,
    lowOverTrain,
    tallOverTrain,
    tunnelsAfterTall,
    underLowTunnel,
    trains: editor.snapshot().trains.length,
  }).toEqual({
    standing: { placements: 0, refusedClicks: 0, reason: null },
    lowOverTrain: `my-low-tunnel.ldr would cut through ${LOCOMOTIVE_LABEL} standing there.`,
    tallOverTrain: null,
    tunnelsAfterTall: 1,
    underLowTunnel: {
      placements: 2,
      refusedClicks: 1,
      reason: `${LOCOMOTIVE_LABEL} would run into my-low-tunnel.ldr there. Put it where it clears every model.`,
    },
    trains: 1,
  });
}, 180_000);

const PLATFORM_CENTRE_LDU = 100;
const UNDER_THE_OVERHANG_BRICKS = 4;

function platformFile(name: string, bricks: number): Uint8Array {
  return userRoadFile(
    name,
    Array.from(
      { length: bricks },
      (_, k) => `1 7 0 ${-BRICK_LDU * (k + 1)} 0 0 0 1 0 1 0 -1 0 0 2456.dat`,
    ),
  );
}

it("takes a station platform beside the track under a train body's overhang, setting the train by it and the platform by the standing train, while a platform reaching the body is refused", async () => {
  const { editor, backend, frame, catalog } = await startImportingEditor(undefined, [
    LOCOMOTIVE.slice(4),
  ]);
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-64 * STUD, 0], [64 * STUD, 0]);
  dragTrack(editor, backend, [-64 * STUD, SECOND_RUN_Z], [64 * STUD, SECOND_RUN_Z]);
  editor.chooseItem(null);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  const low = await importUserFile(
    editor,
    "my-platform.ldr",
    platformFile("my-platform.ldr", UNDER_THE_OVERHANG_BRICKS),
  );
  const high = await importUserFile(
    editor,
    "my-high-platform.ldr",
    platformFile("my-high-platform.ldr", UNDER_THE_OVERHANG_BRICKS + 1),
  );
  const place = settledPlacer(editor, backend);

  await heldAlongTrack(editor, backend, frame, low, 0, SECOND_RUN_Z + PLATFORM_CENTRE_LDU);
  editor.click(0, 0, 0);
  const byPlatform = await place(LOCOMOTIVE, 0, SECOND_RUN_Z);
  await place(LOCOMOTIVE, 0, 0);
  const lowByTrain = await heldAlongTrack(editor, backend, frame, low, 0, PLATFORM_CENTRE_LDU);
  const highByTrain = await heldAlongTrack(editor, backend, frame, high, 0, -PLATFORM_CENTRE_LDU);

  expect({ byPlatform, lowByTrain, highByTrain, trains: editor.snapshot().trains.length }).toEqual({
    byPlatform: { placements: 1, refusedClicks: 0, reason: null },
    lowByTrain: null,
    highByTrain: `my-high-platform.ldr would cut through ${LOCOMOTIVE_LABEL} standing there.`,
    trains: 2,
  });
}, 180_000);

const TUNNEL_ALONG_LDU = 500;
const THROUGH_TUNNEL_TICKS = 240;

it("stops a running train before a user's own tunnel too low for it, naming the tunnel, and runs a train on through one tall enough", async () => {
  const sim = new InThreadSim();
  const { editor, backend, frame, container, catalog } = await startEditor(
    [LOCOMOTIVE.slice(4)],
    new BundleDirectoryFetcher(),
    [],
    (bound) => {
      bound
        .rebind(MODEL_IMPORTER)
        .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
      bound.rebind(SIM_CLIENT).toConstantValue(sim);
    },
  );
  editor.chooseItem(TRACK_ITEM_ID);
  dragTrack(editor, backend, [-64 * STUD, 0], [64 * STUD, 0]);
  dragTrack(editor, backend, [-64 * STUD, SECOND_RUN_Z], [64 * STUD, SECOND_RUN_Z]);
  editor.chooseItem(null);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  const low = await importUserFile(editor, "my-low-tunnel.ldr", tunnelFile("my-low-tunnel.ldr", 3));
  const tall = await importUserFile(editor, "my-tunnel.ldr", tunnelFile("my-tunnel.ldr", 12));
  for (const [item, z] of [
    [low, 0],
    [tall, SECOND_RUN_Z],
  ] as const) {
    for (const x of [-TUNNEL_ALONG_LDU, TUNNEL_ALONG_LDU]) {
      await heldAlongTrack(editor, backend, frame, item, x, z);
      editor.click(0, 0, 0);
    }
  }
  const place = settledPlacer(editor, backend);
  await place(LOCOMOTIVE, 0, 0);
  await place(LOCOMOTIVE, 0, SECOND_RUN_Z);
  editor.chooseItem(null);
  const play = container.get(TRAIN_PLAY);

  await play.start();
  play.drive(TRAIN_SPEED_LDU_PER_S);
  play.chooseDriven(1);
  play.drive(TRAIN_SPEED_LDU_PER_S);
  sim.advance(THROUGH_TUNNEL_TICKS);
  play.chooseDriven(0);
  const { notice, trains, status } = play.snapshot();
  play.stop();
  const [underLow, throughTall] = trains;

  expect({ status, placements: editor.snapshot().placements, notice }).toEqual({
    status: "running",
    placements: 4,
    notice: `${LOCOMOTIVE_LABEL} stopped: it would run into my-low-tunnel.ldr.`,
  });
  expect(underLow).toMatchObject({ blockedBy: "my-low-tunnel.ldr", speedLduPerS: 0 });
  expect(Math.abs(underLow?.xLdu ?? 0)).toBeGreaterThan(0);
  expect(Math.abs(underLow?.xLdu ?? 0) + (underLow?.lengthLdu ?? 0) / 2).toBeLessThan(
    TUNNEL_ALONG_LDU,
  );
  expect(throughTall).toMatchObject({ blockedBy: null, derailSpeedLduPerS: 0 });
  expect(Math.abs(throughTall?.xLdu ?? 0)).toBeGreaterThan(TUNNEL_ALONG_LDU);
}, 240_000);

const LOOP_HALF_LDU = 72 * STUD;
const LEVEL_HALF_LDU = 40 * STUD;
const WHOLE_TRAIN_LEVEL_LDU = 15 * STUD;
const LOOP_RADIUS_LDU = 800;
const RAMP_CLIMB_PLATES = 4;
const RAMP_PLATES_A_PIECE = 2;
const ARC_POINTS = 24;
const LAP_SAMPLE_TICKS = 30;
const LAP_TICKS = 4800;

function strokeTrack(
  editor: IEditor,
  backend: AimedBackend,
  points: ReadonlyArray<readonly [number, number]>,
): void {
  const [first, ...rest] = points;
  if (!first) return;
  backend.aim(...first);
  editor.pointerMove(0, 0);
  expect(editor.dragStart(0, 0)).toBe(true);
  for (const point of rest) {
    backend.aim(...point);
    editor.dragMove(0, 0);
  }
  editor.dragEnd(0, 0, 0);
}

function arcPoints(
  centreX: number,
  from: number,
  to: number,
): ReadonlyArray<readonly [number, number]> {
  return Array.from({ length: ARC_POINTS + 1 }, (_, k) => {
    const angle = from + ((to - from) * k) / ARC_POINTS;
    return [
      Math.round(centreX + LOOP_RADIUS_LDU * Math.cos(angle)),
      Math.round(LOOP_RADIUS_LDU * Math.sin(angle)),
    ] as const;
  });
}

async function rampedLoop(sim: InThreadSim) {
  const started = await startEditor(
    [LOCOMOTIVE.slice(4)],
    new BundleDirectoryFetcher(),
    [],
    (bound) => {
      bound
        .rebind(MODEL_IMPORTER)
        .toConstantValue(new InThreadModelImporter(bound.get(PART_BUNDLE_LOADER)));
      bound.rebind(SIM_CLIENT).toConstantValue(sim);
    },
  );
  const { editor, backend } = started;
  const place = placer(editor, backend);
  for (const x of [-96, -64, -32, 0, 32, 64, 96]) {
    for (const z of [-32, 0, 32]) await place(BASEPLATE, x * STUD, z * STUD);
  }
  editor.chooseItem(TRACK_ITEM_ID);
  editor.setTrackRampPlates(RAMP_PLATES_A_PIECE);
  dragTrack(editor, backend, [-LOOP_HALF_LDU, LOOP_RADIUS_LDU], [LOOP_HALF_LDU, LOOP_RADIUS_LDU]);
  strokeTrack(editor, backend, arcPoints(LOOP_HALF_LDU, Math.PI / 2, -Math.PI / 2));
  editor.raiseTrack(RAMP_CLIMB_PLATES);
  await layRaised(
    editor,
    backend,
    [LOOP_HALF_LDU, -LOOP_RADIUS_LDU],
    [-LEVEL_HALF_LDU, -LOOP_RADIUS_LDU],
  );
  editor.raiseTrack(-RAMP_CLIMB_PLATES);
  await layRaised(
    editor,
    backend,
    [-LEVEL_HALF_LDU, -LOOP_RADIUS_LDU],
    [-LOOP_HALF_LDU, -LOOP_RADIUS_LDU],
  );
  strokeTrack(editor, backend, arcPoints(-LOOP_HALF_LDU, -Math.PI / 2, -(3 * Math.PI) / 2));
  await piersPlaced(editor);
  editor.chooseItem(null);
  return started;
}

const RAISED_LDU = RAMP_CLIMB_PLATES * PLATE_LDU;
const RAMP_MIDDLE_LDU = LOOP_HALF_LDU - 8 * STUD;

function bodiesOnSide(backend: HeadlessBackend, side: number): ReadonlyArray<number> {
  return [...backend.vehicles]
    .filter(([, pose]) => Math.sign(pose[2] ?? 0) === side)
    .map(([id]) => id);
}

function drawnHeights(backend: HeadlessBackend): ReadonlyMap<number, number> {
  return new Map([...backend.vehicles].map(([id, pose]) => [id, pose[1] ?? 0]));
}

function everyAnimationFrame(): () => void {
  const waiting: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    waiting.push(callback);
    return waiting.length;
  });
  return () => {
    for (const callback of waiting.splice(0)) callback(performance.now());
  };
}

it("runs a train whole laps of a loop that ramps up over generated piers and back down, drawn on the ramps' rails, never stopping at a pier", async () => {
  const sim = new InThreadSim();
  const { editor, backend, container, catalog } = await rampedLoop(sim);
  const track = editor.snapshot().track;
  const piers = placedImports(editor).length;
  await loadCatalogItem(catalog, LOCOMOTIVE);
  await settledPlacer(editor, backend)(LOCOMOTIVE, 0, LOOP_RADIUS_LDU);
  editor.chooseItem(null);
  const play = container.get(TRAIN_PLAY);
  const frame = everyAnimationFrame();
  await play.start();
  frame();
  const onGround = drawnHeights(backend);
  let running: ReadonlyArray<number> = [];
  play.drive(TRAIN_SPEED_LDU_PER_S);
  const stops = new Set<string>();
  let raised: ReadonlyMap<number, number> | null = null;
  let farSide = false;
  let lapped = false;
  for (let tick = 0; tick < LAP_TICKS && !lapped; tick += LAP_SAMPLE_TICKS) {
    sim.advance(LAP_SAMPLE_TICKS);
    play.chooseDriven(0);
    const view = play.snapshot().trains[0];
    if (view?.blockedBy) stops.add(view.blockedBy);
    const x = view?.xLdu ?? 0;
    const z = view?.zLdu ?? 0;
    if (z < 0 && Math.abs(x) < WHOLE_TRAIN_LEVEL_LDU && !raised) {
      frame();
      raised = drawnHeights(backend);
      running = bodiesOnSide(backend, -1);
      farSide = true;
    }
    lapped = farSide && z > 0 && x > 0 && x < LOOP_HALF_LDU;
  }
  play.stop();
  const lifted = running.map(
    (id) => (raised?.get(id) ?? Number.NaN) - (onGround.get(id) ?? Number.NaN),
  );

  expect({ openEnds: track?.openEnds, unsupported: track?.unsupported }).toEqual({
    openEnds: 0,
    unsupported: 0,
  });
  expect(piers).toBeGreaterThan(0);
  expect([...stops]).toEqual([]);
  expect(lapped).toBe(true);
  expect(lifted.length).toBeGreaterThan(0);
  for (const rise of lifted) expect(rise).toBeCloseTo(RAISED_LDU, 9);
}, 300_000);

it("sets a train on raised track and on a ramp where it fits, drawn on their rails", async () => {
  const sim = new InThreadSim();
  const { editor, backend, catalog } = await rampedLoop(sim);
  await loadCatalogItem(catalog, LOCOMOTIVE);
  const place = settledPlacer(editor, backend);
  await place(LOCOMOTIVE, 0, LOOP_RADIUS_LDU);
  const placed = editor.snapshot().placements;
  const onRaised = await place(LOCOMOTIVE, 0, -LOOP_RADIUS_LDU);
  const groundTrain = bodiesOnSide(backend, 1);
  const raisedTrain = bodiesOnSide(backend, -1);
  const heights = drawnHeights(backend);
  const sortedHeights = (ids: ReadonlyArray<number>) =>
    ids.map((id) => heights.get(id) ?? Number.NaN).toSorted((a, b) => a - b);
  const lifted = sortedHeights(raisedTrain).map(
    (y, k) => y - (sortedHeights(groundTrain)[k] ?? Number.NaN),
  );
  const bothStanding = trainsOf(editor);
  editor.undo(0);
  const onRamp = await place(LOCOMOTIVE, RAMP_MIDDLE_LDU, -LOOP_RADIUS_LDU);

  expect(onRaised).toEqual({ placements: placed, refusedClicks: 0, reason: null });
  expect(onRamp).toEqual({ placements: placed, refusedClicks: 0, reason: null });
  expect(bothStanding).toEqual([
    [LOCOMOTIVE, true],
    [LOCOMOTIVE, true],
  ]);
  expect(trainsOf(editor)).toEqual([
    [LOCOMOTIVE, true],
    [LOCOMOTIVE, true],
  ]);
  expect(raisedTrain).toHaveLength(groundTrain.length);
  expect(lifted.length).toBeGreaterThan(0);
  for (const rise of lifted) expect(rise).toBeCloseTo(RAISED_LDU, 9);
}, 300_000);

const crossingFacts = decodedOrThrow(
  decode(LevelCrossingFacts, crossingJson),
  "level-crossing.json",
);
const SESSION_EDITS = 40;
const FREE_SPOTS: ReadonlyArray<PlanPoint> = [
  [-1280, 0],
  [1920, 0],
  [3200, 0],
  [3200, 640],
  [-1280, 1600],
  [1280, 1600],
  [-3200, 3200],
  [3200, 3200],
  [0, 4800],
  [1920, 4800],
  [-1920, 4800],
  [4480, 1600],
];

function seededSession(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function rankedRoads(editor: IEditor, catalog: IPlaceableCatalog): RoadPlacement[] {
  return editor.dump().roadPlacements.map((placed) => {
    const refId = catalog.itemRefId(placed.item);
    const surface = refId === null ? null : catalog.placeables()[refId]?.road;
    if (!surface) throw new Error(`${placed.item} has no road surface`);
    return {
      id: placed.id,
      x: placed.x,
      z: placed.z,
      yLdu: placed.yPlates * PLATE_LDU,
      rot: placed.rot,
      surface,
    };
  });
}

function crossingRampParts(catalog: IPlaceableCatalog): ReadonlyArray<RampPart> {
  return crossingFacts.ramps.map((ramp) => {
    const outline = catalog.parts().find((part) => part.id === ramp.part)?.outline;
    if (!outline) throw new Error(`ramp ${ramp.part} has no outline`);
    return { facts: ramp, outline };
  });
}

function expectFullRebuild(editor: IEditor, container: Container, catalog: IPlaceableCatalog) {
  const dump = editor.dump();
  const roads = rankedRoads(editor, catalog);
  expect(dump.roads).toEqual(new RoadNetwork(roads).report());
  const pieces = container.get(TRACK_WORLD).drawing()?.crossingPieces() ?? [];
  const tracks = pieces.map((piece): CrossingTrack => {
    const system = crossingFacts.systems.find((entry) => entry.system === piece.system);
    if (!system) throw new Error(`no rail top for ${piece.system}`);
    return { outline: piece.outline, bedLdu: piece.bedLdu, railTopLdu: system.railTopLdu };
  });
  const expected =
    roads.length === 0 || pieces.length === 0
      ? []
      : levelCrossings(roads, tracks, crossingRampParts(catalog));
  expect(
    dump.crossings.map(({ tracks: placements, roads: ranks, roadwayCells }) => ({
      placements,
      ranks,
      roadwayCells,
    })),
  ).toEqual(
    expected.map((crossing) => ({
      placements: crossing.tracks.map((t) => pieces[t]?.placement ?? 0),
      ranks: crossing.roads,
      roadwayCells: crossing.roadwayCells,
    })),
  );
  return dump.crossings.length;
}

const LDRAW_DECIMALS = 6;
const RUN_OFF_THE_LATTICE_LDU = 0.3;
const RUN_STRAIGHT = "ldraw:74746";
const BASEPLATE_UNDER_THE_RUN = "1 2 320 0 160 1 0 0 0 1 0 0 0 1 3811.dat";

async function offLatticeRunFile(loader: IPartBundleLoader): Promise<Uint8Array> {
  const bundle = await loader.load("standard", (part) => part.role === "track");
  const origin = pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);
  const { count, partIndex, matrices } = instancesAt(
    bundle,
    chainedPoses(bundle, origin, [RUN_STRAIGHT, RUN_STRAIGHT]),
  );
  const lines = Array.from({ length: count }, (_, i) => {
    const m = Array.from(matrices.subarray(i * 12, i * 12 + 12));
    const at = (row: number, column: number) => m[row * 4 + column] ?? 0;
    const part = bundle.parts[partIndex[i] ?? 0]?.id.replace("ldraw:", "") ?? "";
    const entries = [at(0, 3) + RUN_OFF_THE_LATTICE_LDU, -at(1, 3), at(2, 3)];
    entries.push(at(0, 0), -at(0, 1), at(0, 2));
    entries.push(-at(1, 0), at(1, 1), -at(1, 2));
    entries.push(at(2, 0), -at(2, 1), at(2, 2));
    return `1 7 ${entries.map((value) => value.toFixed(LDRAW_DECIMALS)).join(" ")} ${part}.dat`;
  });
  return userRoadFile("my-off-lattice-run.ldr", [BASEPLATE_UNDER_THE_RUN, ...lines]);
}

function rampsByCrossing(editor: IEditor) {
  return new Map(
    editor.dump().crossings.map((crossing) => [JSON.stringify(crossing.tracks), crossing.ramps]),
  );
}

it("keeps the road report, the road placements and the level crossings after every edit of a seeded session exactly as a full rebuild over the editor's road list, and the ramps as a reopened editor seats them, through sets, road plates, a user's own street and brick, track and road strokes, deletes, moves, turns, drags, undo, redo and reloads", async () => {
  const repository = new MemoryRepository();
  let session = await startImportingEditor(() => repository, [PLACEABLE_SET]);
  const street = await importUserFile(
    session.editor,
    "my-street-with-grass.ldr",
    userRoadFile("my-street-with-grass.ldr", [
      "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336p04.dat",
      "1 2 640 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    ]),
  );
  const brick = await importUserFile(
    session.editor,
    "my-brick.ldr",
    userRoadFile("my-brick.ldr", ["1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3004.dat"]),
  );
  await loadCatalogItem(session.catalog, SET);
  let place = placer(session.editor, session.backend);
  await place(ROAD_STRAIGHT, 0, 0);
  await place(BASEPLATE_32, 640, 0);
  await place(street, 320, 1600);
  await supportChecked(session.editor);
  const random = seededSession(0x5e55);
  const free = [...FREE_SPOTS];
  const roadAt = (): PlanPoint | null => {
    const roads = session.editor.dump().roadPlacements;
    const road = roads[Math.floor(random() * roads.length)];
    return road ? [road.x, road.z] : null;
  };
  const seen = {
    crossingsChanged: 0,
    roadsChanged: 0,
    reloads: 0,
    mostCrossings: 0,
    rampSpots: 0,
  };
  const reopen = async (): Promise<void> => {
    session.editor.chooseItem(null);
    const stored = session.editor.dump().placements.refId.length;
    await vi.waitFor(() => expect(repository.storedPlacements()).toBe(stored), { timeout: 60_000 });
    const ramps = rampsByCrossing(session.editor);
    session = await startImportingEditor(() => repository, [PLACEABLE_SET]);
    await supportChecked(session.editor);
    expect(rampsByCrossing(session.editor)).toEqual(ramps);
    place = placer(session.editor, session.backend);
    seen.reloads++;
  };
  trackDrawer(session.editor, session.backend)([-480, 0], [480, 0]);
  trackDrawer(session.editor, session.backend)([-480, 1600], [480, 1600]);
  expectFullRebuild(session.editor, session.container, session.catalog);
  const seated = session.editor.dump();
  const ramp = seated.crossings[0]?.ramps[0];
  if (!ramp) throw new Error("the first crossing has no ramp");
  await place(brick, ramp.x, ramp.z);
  expectFullRebuild(session.editor, session.container, session.catalog);
  expect(session.editor.dump().roadPlacements).toEqual(seated.roadPlacements);
  expect(session.editor.dump().crossings).not.toEqual(seated.crossings);
  await reopen();
  session.editor.undo(0);
  expectFullRebuild(session.editor, session.container, session.catalog);
  await reopen();
  const offLatticeRun = await importUserFile(
    session.editor,
    "my-off-lattice-run.ldr",
    await offLatticeRunFile(session.container.get(PART_BUNDLE_LOADER)),
  );
  const [runSpot] = free.splice(free.length - 1, 1);
  if (!runSpot) throw new Error("no free spot for the off-lattice run");
  await place(offLatticeRun, ...runSpot);
  expect(session.editor.snapshot().track?.runFramePieces).toBeGreaterThan(0);
  expectFullRebuild(session.editor, session.container, session.catalog);
  await reopen();
  for (let edit = 0; edit < SESSION_EDITS; edit++) {
    const { editor, backend } = session;
    const before = {
      roads: JSON.stringify(editor.dump().roads),
      crossings: JSON.stringify(editor.dump().crossings),
    };
    const roll = random();
    const at = roadAt();
    if (roll < 0.16 && free.length > 0) {
      const [spot] = free.splice(Math.floor(random() * free.length), 1);
      if (spot) await place(pick([ROAD_STRAIGHT, ROAD_STRAIGHT, street, SET], random), ...spot);
    } else if (roll < 0.3) {
      const [x, z] = at ?? [0, 0];
      const across = random() < 0.5;
      const far = random() < 0.25 ? 6400 : 0;
      trackDrawer(editor, backend)(
        across ? [x - 480 + far, z] : [x + far, z - 480],
        across ? [x + 480 + far, z] : [x + far, z + 480],
      );
    } else if (roll < 0.36 && at) {
      roadStrokeResult(editor, backend, [at[0] - 320, at[1] + 960], [at[0] + 320, at[1] + 960]);
    } else if (roll < 0.46 && at) {
      if (selectAt(editor, backend, ...at)) editor.deleteSelection(0);
    } else if (roll < 0.54 && at) {
      if (selectAt(editor, backend, ...at)) {
        editor.moveSelectionTo(
          Math.floor(at[0] / STUD_LDU) + 32 * Math.floor(random() * 3 - 1),
          Math.floor(at[1] / STUD_LDU) + 32,
          0,
        );
      }
    } else if (roll < 0.6 && at) {
      if (selectAt(editor, backend, ...at)) editor.rotate(0, 1);
    } else if (roll < 0.66 && at) {
      if (selectAt(editor, backend, ...at)) dragGroup(editor, backend, at, [at[0] + 640, at[1]]);
    } else if (roll < 0.7 && at && free.length > 0) {
      const [spot] = free.splice(0, 1);
      if (spot && selectAt(editor, backend, ...at)) {
        await place(street, ...spot);
        selectAt(editor, backend, ...at);
        backend.aim(...at);
        editor.selectDragStart(0, 0, false);
        backend.aim(at[0], at[1] + 640);
        editor.pointerMove(0, 0);
        editor.selectDragMove(0, 0);
        await vi.waitFor(
          () => {
            if (editor.snapshot().studChecks > 0)
              throw new Error("the street's studs are still pending");
          },
          { timeout: 60_000 },
        );
        editor.selectDragMove(0, 0);
        editor.selectDragEnd(0, 0, 0);
      }
    } else if (roll < 0.76) {
      const spots = editor.dump().crossings.flatMap((crossing) => crossing.ramps);
      const spot = spots[Math.floor(random() * spots.length)];
      if (spot && editor.dump().crossings.length > 1) {
        await place(brick, spot.x, spot.z);
        expectFullRebuild(session.editor, session.container, session.catalog);
        await reopen();
        session.editor.undo(0);
        expectFullRebuild(session.editor, session.container, session.catalog);
        await reopen();
        seen.rampSpots++;
      }
    } else if (roll < 0.86) editor.undo(0);
    else if (roll < 0.94) editor.redo(0);
    else await reopen();
    const crossings = expectFullRebuild(session.editor, session.container, session.catalog);
    const after = session.editor.dump();
    if (JSON.stringify(after.roads) !== before.roads) seen.roadsChanged++;
    if (JSON.stringify(after.crossings) !== before.crossings) seen.crossingsChanged++;
    seen.mostCrossings = Math.max(seen.mostCrossings, crossings);
  }
  expect(seen.roadsChanged).toBeGreaterThan(SESSION_EDITS / 4);
  expect(seen.crossingsChanged).toBeGreaterThan(SESSION_EDITS / 8);
  expect(seen.mostCrossings).toBeGreaterThan(1);
  expect(seen.reloads).toBeGreaterThan(0);
  expect(seen.rampSpots).toBeGreaterThan(0);
}, 900_000);

function pick<T>(choices: ReadonlyArray<T>, random: () => number): T {
  const choice = choices[Math.floor(random() * choices.length)];
  if (choice === undefined) throw new Error("nothing to pick from");
  return choice;
}

const RAMP_CHUNK_KEYS_BELOW = rampChunkKey(0, 0) / 2;

it("opens a world of track over a baseplate without ever drawing ramps for a crossing it doesn't have, though the world it replaces had a road where that track runs", async () => {
  const repository = new MemoryRepository();
  const { editor, backend } = await startImportingEditor(() => repository);
  await placer(editor, backend)(BASEPLATE_32, 0, 0);
  trackDrawer(editor, backend)([-480, 0], [480, 0]);
  expect(editor.dump().crossings).toEqual([]);
  await vi.waitFor(() => expect(repository.storedTrack()).toBeGreaterThan(0));
  const trackOnly = editor.snapshot().world?.id;
  if (!trackOnly) throw new Error("no current world");
  expect(await editor.newWorld("Roads")).toBe(true);
  await placer(editor, backend)(ROAD_STRAIGHT, 0, 0);
  expect(editor.dump().roadPlacements).toHaveLength(1);
  const uploadsBefore = backend.chunksSet.length;
  expect(await editor.openWorld(trackOnly)).toBe(true);
  const rampUploads = backend.chunksSet
    .slice(uploadsBefore)
    .filter((key) => key < RAMP_CHUNK_KEYS_BELOW);
  expect({ crossings: editor.dump().crossings, rampUploads }).toEqual({
    crossings: [],
    rampUploads: [],
  });
}, 240_000);

const SUPPORT_SESSION_STEPS = 40;
const SUPPORT_SESSION_SEED = 0x5a99_07e1;
const PLATFORM_PLATES = 3;
const ABOVE_GROUND_TRACK_PLATES = 6;
const PLATFORM_AT: PlanPoint = [2560, 0];
const PLATFORM_EDGE_Z = 120;
const PLATFORM_ROWS_Z = [-240, 240];
const SWITCH_SPOTS: ReadonlyArray<PlanPoint> = [-3840, -2560, -1280, 0, 1280, 3840].map((x) => [
  x,
  -3840,
]);
const REOPEN_STEP = 9;
const FRESH_EDITOR_STEP = 19;
const SESSION_EDIT_KINDS = [
  "ground stroke",
  "baseplate placed, moved, turned or removed",
  "raised stroke",
  "switch lay",
  "lever throw",
  "platform moved, turned or removed",
  "brick removed or placed",
  "train removed or placed",
  "undo",
  "redo",
] as const;

const TRAIN_RUN_Z = 2560;
const BRICK_RUN_Z = -2560;
const BRICK_OFF_RUN_LDU = 20 * STUD;
const SWITCH_AT: PlanPoint = [-2560, 0];
const RUN_FILE_AT: PlanPoint = [-2560, 2560];
const FREE_LANES_Z = [-1280, 1280, 3840];
const SESSION_TABLE = { minX: -5120, minZ: -5120, maxX: 5120, maxZ: 5120 };
const PLATFORM_BRICKS_X = [-280, -200, -120, -40, 40, 120, 200, 280];
const PLATFORM_BRICKS_Z = [
  -300, -260, -220, -180, -140, -100, -60, -20, 20, 60, 100, 140, 180, 220, 260, 300,
];
const RUN_HALF_LDU = 480;
const PLATFORM_STROKE_HALF_LDU = 240;
const PLATFORM_SHIFT_LDU = 8 * STUD;
const SHIFT_STEPS = 5;
const SHIFT_STEP_LDU = 4 * STUD;
const MOVE_CHANCE = 0.5;
const TURN_CHANCE = 0.7;
const BASEPLATE_AT: PlanPoint = [0, -1280];
const BASEPLATE_CORNER_LDU = 240;
const BASEPLATE_SHIFT_LDU = 32 * STUD;

function shuffledKinds(random: () => number): Array<(typeof SESSION_EDIT_KINDS)[number]> {
  const kinds = [...SESSION_EDIT_KINDS];
  for (let k = kinds.length - 1; k > 0; k--) {
    const other = Math.floor(random() * (k + 1));
    const kind = kinds[k];
    const swapped = kinds[other];
    if (kind === undefined || swapped === undefined) continue;
    kinds[k] = swapped;
    kinds[other] = kind;
  }
  return kinds;
}

function brickTopPlatform(): Uint8Array {
  return userRoadFile(
    "my-platform.ldr",
    PLATFORM_BRICKS_X.flatMap((x) =>
      PLATFORM_BRICKS_Z.map((z) => `1 4 ${x} 0 ${z} 1 0 0 0 1 0 0 0 1 3001.dat`),
    ),
  );
}

function sessionEditor(repository: MemoryRepository) {
  return startImportingEditor(() => repository, [LOCOMOTIVE.slice(4)]);
}

function savedIn(editor: IEditor): Promise<void> {
  return vi.waitFor(() => expect(editor.snapshot().world?.save).toBe("saved"), {
    timeout: 60_000,
  });
}

async function settledSupport(editor: IEditor, plans: IPlanService): Promise<string> {
  const planId = plans.plans()[0]?.id ?? plans.drawTable(SESSION_TABLE).planId;
  await vi.waitFor(
    () => {
      expect(editor.dump().studChecks).toBe(0);
      expect(editor.snapshot().track?.placingPiers).toBe(false);
      expect(editor.snapshot().track?.unsupported).not.toBeNull();
      expect(plans.unmeasuredCount(planId)).toBe(0);
    },
    { timeout: 60_000 },
  );
  return planId;
}

function drawnAt(editor: IEditor, plates: number): void {
  editor.chooseItem(TRACK_ITEM_ID);
  editor.raiseTrack(plates - (editor.snapshot().track?.height.drawingPlates ?? 0));
}

function heldBlocks(
  editor: IEditor,
  backend: AimedBackend,
  plates: number,
  samples: ReadonlyArray<PlanPoint>,
) {
  drawnAt(editor, plates);
  editor.chooseItem(`${TRACK_PIECE_PREFIX}${RIGHT_SWITCH}`);
  return samples.map(([x, z]) => {
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    return editor.snapshot().track?.held?.blocked ?? null;
  });
}

async function supportObserved(
  editor: IEditor,
  backend: AimedBackend,
  plans: IPlanService,
  samples: ReadonlyArray<PlanPoint>,
) {
  const planId = await settledSupport(editor, plans);
  const drawing = editor.snapshot().track?.height.drawingPlates ?? 0;
  const atGround = heldBlocks(editor, backend, 0, samples);
  const aboveGroundTrack = heldBlocks(editor, backend, ABOVE_GROUND_TRACK_PLATES, samples);
  drawnAt(editor, drawing);
  editor.chooseItem(null);
  const track = editor.snapshot().track;
  return {
    issues: plans
      .issues(planId)
      .filter((issue) => issue.rule === "unsupported" || issue.rule === "clearance")
      .map((issue) => `${issue.rule}: ${issue.message}`)
      .toSorted(),
    unsupported: track?.unsupported ?? null,
    lowClearance: track?.lowClearance ?? null,
    atGround,
    aboveGroundTrack,
    trains: trainsOf(editor),
  };
}

async function freshlyComputed(
  editor: IEditor,
  repository: MemoryRepository,
  samples: ReadonlyArray<PlanPoint>,
) {
  await savedIn(editor);
  const fresh = await sessionEditor(repository);
  await vi.waitFor(() =>
    expect(fresh.editor.snapshot().placements).toBe(editor.snapshot().placements),
  );
  return supportObserved(fresh.editor, fresh.backend, fresh.container.get(PLAN_SERVICE), samples);
}

it("keeps track support, clearance, blocking and the trains after every edit of a seeded session exactly as a fresh editor computes them from the saved world, through an official baseplate, a user's platform, brick and off-lattice run, a standing train, raised and ground strokes, switch lays and throws, model moves and removals, undo, redo and reloads", async () => {
  const repository = new MemoryRepository();
  let session = await sessionEditor(repository);
  await loadCatalogItem(session.catalog, LOCOMOTIVE);
  const platform = await importUserFile(session.editor, "my-platform.ldr", brickTopPlatform());
  const brick = await importUserFile(
    session.editor,
    "my-brick.ldr",
    userRoadFile("my-brick.ldr", ["1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3004.dat"]),
  );
  const run = await importUserFile(
    session.editor,
    "my-off-lattice-run.ldr",
    await offLatticeRunFile(session.container.get(PART_BUNDLE_LOADER)),
  );
  const brickAt: PlanPoint = [0, BRICK_RUN_Z + BRICK_OFF_RUN_LDU];
  let platformAt: PlanPoint = PLATFORM_AT;
  let baseplateAt: PlanPoint = BASEPLATE_AT;
  const samples: ReadonlyArray<PlanPoint> = [
    [0, TRAIN_RUN_Z],
    brickAt,
    [PLATFORM_AT[0], PLATFORM_AT[1] + PLATFORM_EDGE_Z],
    [0, 0],
  ];
  const seen = {
    unsupportedRose: 0,
    unsupportedFell: 0,
    brickBlocks: 0,
    trainBlocks: 0,
    platformBlocks: 0,
    seatedOnPlatform: 0,
    leversThrown: 0,
    openedAgain: 0,
    freshEditors: 0,
    baseplateEdits: 0,
  };
  const tools = () => ({
    editor: session.editor,
    backend: session.backend,
    place: placer(session.editor, session.backend),
    draw: trackDrawer(session.editor, session.backend),
  });
  const raisedStroke = (offset: number, row: number) => {
    const { editor, draw } = tools();
    const before = editor.snapshot();
    drawnAt(editor, PLATFORM_PLATES);
    draw(
      [platformAt[0] - PLATFORM_STROKE_HALF_LDU + offset, platformAt[1] + row],
      [platformAt[0] + PLATFORM_STROKE_HALF_LDU + offset, platformAt[1] + row],
    );
    drawnAt(editor, 0);
    const after = editor.snapshot();
    if (
      (after.track?.pieces ?? 0) > (before.track?.pieces ?? 0) &&
      after.placements === before.placements
    ) {
      seen.seatedOnPlatform++;
    }
  };
  {
    const { editor, backend, place, draw } = tools();
    await place(BASEPLATE, ...baseplateAt);
    await place(platform, ...platformAt);
    raisedStroke(0, 0);
    draw([-RUN_HALF_LDU, TRAIN_RUN_Z], [RUN_HALF_LDU, TRAIN_RUN_Z]);
    await place(LOCOMOTIVE, 0, TRAIN_RUN_Z);
    draw([-RUN_HALF_LDU, BRICK_RUN_Z], [RUN_HALF_LDU, BRICK_RUN_Z]);
    await place(brick, ...brickAt);
    laySwitchAt(editor, backend, ...SWITCH_AT);
    await place(run, ...RUN_FILE_AT);
    editor.chooseItem(null);
  }
  const random = seededSession(SUPPORT_SESSION_SEED);
  const planned: Array<(typeof SESSION_EDIT_KINDS)[number]> = [];

  let previous = await supportObserved(
    session.editor,
    session.backend,
    session.container.get(PLAN_SERVICE),
    samples,
  );
  expect(previous).toEqual(await freshlyComputed(session.editor, repository, samples));
  for (let step = 0; step < SUPPORT_SESSION_STEPS; step++) {
    const { editor, backend, place, draw } = tools();
    if (planned.length === 0) planned.push(...shuffledKinds(random));
    const edit =
      step === REOPEN_STEP
        ? "world opened again"
        : step === FRESH_EDITOR_STEP
          ? "a fresh editor continues"
          : (planned.shift() ?? "undo");
    const lane = FREE_LANES_Z[Math.floor(random() * FREE_LANES_Z.length)] ?? 0;
    const shift =
      (Math.floor(random() * SHIFT_STEPS) - Math.floor(SHIFT_STEPS / 2)) * SHIFT_STEP_LDU;
    switch (edit) {
      case "ground stroke":
        draw([shift - RUN_HALF_LDU, lane], [shift + RUN_HALF_LDU, lane]);
        break;
      case "raised stroke":
        raisedStroke(shift, PLATFORM_ROWS_Z[Math.floor(random() * PLATFORM_ROWS_Z.length)] ?? 0);
        break;
      case "switch lay":
        laySwitchAt(
          editor,
          backend,
          ...(SWITCH_SPOTS[Math.floor(random() * SWITCH_SPOTS.length)] ?? SWITCH_AT),
        );
        break;
      case "lever throw":
        if ((editor.snapshot().track?.switches.length ?? 0) > 0) {
          const levers = JSON.stringify(editor.snapshot().track?.switches);
          throwFirstSwitch(editor, backend);
          if (JSON.stringify(editor.snapshot().track?.switches) !== levers) seen.leversThrown++;
        }
        break;
      case "platform moved, turned or removed": {
        const picked = selectAt(editor, backend, platformAt[0], platformAt[1] + PLATFORM_EDGE_Z);
        if (picked?.kind !== "model") break;
        const how = random();
        if (how < MOVE_CHANCE) {
          const dx = random() < 0.5 ? -PLATFORM_SHIFT_LDU : PLATFORM_SHIFT_LDU;
          editor.moveSelectionBy(dx, 0, 0);
          if (editor.snapshot().selectionRefusal === null)
            platformAt = [platformAt[0] + dx, platformAt[1]];
        } else if (how < TURN_CHANCE) editor.rotate(0, 1);
        else {
          editor.deleteSelection(0);
          planned.unshift("undo");
        }
        break;
      }
      case "baseplate placed, moved, turned or removed": {
        const picked = selectAt(
          editor,
          backend,
          baseplateAt[0] + BASEPLATE_CORNER_LDU,
          baseplateAt[1] + BASEPLATE_CORNER_LDU,
        );
        if (picked?.kind !== "model") {
          await place(BASEPLATE, ...baseplateAt);
          break;
        }
        seen.baseplateEdits++;
        const how = random();
        if (how < MOVE_CHANCE) {
          const dx = random() < 0.5 ? -BASEPLATE_SHIFT_LDU : BASEPLATE_SHIFT_LDU;
          editor.moveSelectionBy(dx, 0, 0);
          if (editor.snapshot().selectionRefusal === null)
            baseplateAt = [baseplateAt[0] + dx, baseplateAt[1]];
        } else if (how < TURN_CHANCE) editor.rotate(0, 1);
        else editor.deleteSelection(0);
        break;
      }
      case "brick removed or placed": {
        const picked = selectAt(editor, backend, ...brickAt);
        if (picked?.kind === "model") editor.deleteSelection(0);
        else await place(brick, ...brickAt);
        break;
      }
      case "train removed or placed":
        if (editor.snapshot().trains.length > 0) editor.removeTrain(0, 0);
        else await place(LOCOMOTIVE, 0, TRAIN_RUN_Z);
        break;
      case "undo":
        editor.undo(0);
        break;
      case "redo":
        editor.redo(0);
        break;
      case "world opened again": {
        await savedIn(editor);
        const id = editor.snapshot().world?.id ?? "";
        if (!(await editor.newWorld("Other"))) throw new Error("a new world wasn't opened");
        if (!(await editor.openWorld(id))) throw new Error(`world ${id} didn't open again`);
        seen.openedAgain++;
        break;
      }
      case "a fresh editor continues":
        await savedIn(editor);
        session = await sessionEditor(repository);
        seen.freshEditors++;
        break;
      default: {
        const unplanned: never = edit;
        throw new Error(`unplanned edit ${String(unplanned)}`);
      }
    }
    const observed = await supportObserved(
      session.editor,
      session.backend,
      session.container.get(PLAN_SERVICE),
      samples,
    );
    expect(observed, `step ${step}: ${edit}`).toEqual(
      await freshlyComputed(session.editor, repository, samples),
    );
    const unsupported = observed.unsupported ?? 0;
    if (unsupported > (previous.unsupported ?? 0)) seen.unsupportedRose++;
    if (unsupported < (previous.unsupported ?? 0)) seen.unsupportedFell++;
    const blocks = [...observed.atGround, ...observed.aboveGroundTrack];
    if (blocks.some((block) => block?.kind === "model" && block.label === "my-brick.ldr"))
      seen.brickBlocks++;
    if (blocks.some((block) => block?.kind === "model" && block.label === "my-platform.ldr"))
      seen.platformBlocks++;
    if (
      observed.aboveGroundTrack.some(
        (block) => block?.kind === "model" && block.label === LOCOMOTIVE_LABEL,
      )
    ) {
      seen.trainBlocks++;
    }
    previous = observed;
  }
  for (const [kind, count] of Object.entries(seen)) expect(count, `${kind}`).toBeGreaterThan(0);
}, 900_000);
