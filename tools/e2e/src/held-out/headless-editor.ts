import { ASSET_FETCHER, type IAssetFetcher, type PartAsset } from "@brr/catalog";
import {
  EDITOR,
  IMPORT_WORKER_POOL,
  mainThreadModules,
  PLAN_SERVICE,
  type IEditor,
  type IImportWorkerPool,
  type ImportRun,
  type IPlanService,
} from "@brr/client";
import {
  BrickCompiler,
  importStudioFile,
  layoutParts,
  LdrawMirror,
  ModelImportEngine,
  type BlueBrickBudgetImport,
  type FetchFunction,
  type IBakeHelper,
  type ImportResult,
  type LayoutPart,
  type LayoutPartsRequest,
  type RollingDiagnosticsRows,
} from "@brr/import";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ISceneBackend,
  type LookSettings,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import type { Decoded } from "@brr/schema/decode";
import type { PlanArchive } from "@brr/schema/plan";
import {
  noteShardEntry,
  shardEntry,
  shardName,
  worldManifest,
  type ImportedFile,
  type NoteShardV2,
  type WorldArchive,
  type WorldFiles,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldShardV2,
} from "@brr/schema/world";
import {
  WORLD_REPOSITORY,
  type IWorldRepository,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";
import { CANVAS_HEIGHT, CANVAS_WIDTH, VIEW_HALF_WIDTH_LDU } from "./headless-camera.ts";
import { SliceClock } from "./slice-clock.ts";

const RAY_HEIGHT_LDU = 10_000;
const UNFETCHED_BUNDLE_URL = "https://bundle.invalid/";
const NO_BAKE_HELPERS: ReadonlyArray<IBakeHelper> = [];
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

export class AimedBackend implements ISceneBackend {
  constructor(private readonly clock: SliceClock) {}

  private aimX = 0;
  private aimZ = 0;
  private viewHalfWidthLdu = VIEW_HALF_WIDTH_LDU;

  viewHalfWidth(ldu: number): void {
    this.viewHalfWidthLdu = ldu;
  }

  aim(x: number, z: number): void {
    this.aimX = x;
    this.aimZ = z;
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

  setPalette(_palette: PartPalette): void {}
  addParts(_parts: ReadonlyArray<PartAsset>): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(_key: number, _chunk: ChunkInstances): void {}
  deleteChunk(): void {}
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {
    this.clock.published();
  }
  setGhostVerdict(): void {}
  setSelectionBox(): void {}
  setSelectionBoxes(): void {}
  setGround(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}

  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([
      this.aimX + ndcX * this.viewHalfWidthLdu,
      RAY_HEIGHT_LDU,
      this.aimZ - (ndcY * this.viewHalfWidthLdu * CANVAS_HEIGHT) / CANVAS_WIDTH,
      0,
      -1,
      0,
    ]);
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
  setFarModel(): void {}
}

class BundleDirectoryFetcher implements IAssetFetcher {
  constructor(private readonly root: string) {}

  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(join(this.root, path));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8");
  }
}

interface MemoryWorld {
  header: WorldHeader;
  readonly shards: Map<string, WorldShardV2>;
  readonly notes: Map<string, NoteShardV2>;
}

type WorldArchives = Pick<
  IWorldRepository,
  "packArchive" | "readArchive" | "readWorldFiles" | "packPlanArchive" | "readPlanArchive"
>;

class MemoryWorldRepository implements IWorldRepository {
  private readonly worlds = new Map<string, MemoryWorld>();
  private readonly files = new Map<string, ImportedFile>();
  private nextId = 1;

  constructor(private readonly archives: WorldArchives) {}

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

  async shardFiles(): Promise<never[]> {
    return [];
  }

  packArchive(archive: WorldArchive): Uint8Array {
    return this.archives.packArchive(archive);
  }

  readArchive(bytes: Uint8Array): Promise<Decoded<WorldArchive>> {
    return this.archives.readArchive(bytes);
  }

  readWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<Decoded<WorldFiles>> {
    return this.archives.readWorldFiles(files);
  }

  packPlanArchive(archive: PlanArchive): Uint8Array {
    return this.archives.packPlanArchive(archive);
  }

  readPlanArchive(bytes: Uint8Array): Promise<Decoded<PlanArchive>> {
    return this.archives.readPlanArchive(bytes);
  }

  async putImportedFile(file: ImportedFile): Promise<void> {
    this.files.set(file.sha256, file);
  }

  async importedFile(sha256: string): Promise<ImportedFile | undefined> {
    return this.files.get(sha256);
  }
}

class InProcessImportPool implements IImportWorkerPool {
  constructor(
    private readonly bundle: Bundle,
    private readonly fetchUrl: FetchFunction,
  ) {}

  async run(request: ImportRun): Promise<ImportResult> {
    const compiler = new BrickCompiler(this.bundle.compiler);
    const mirror = new LdrawMirror(this.bundle.source, this.fetchUrl);
    const engine = new ModelImportEngine(
      compiler,
      mirror,
      this.bundle.connectors,
      this.bundle.records,
      () => performance.now(),
      NO_BAKE_HELPERS,
      null,
    );
    const { input } = request;
    switch (input.kind) {
      case "ldraw":
        return engine.importText(input.job);
      case "studio":
        return importStudioFile(engine, compiler, mirror, input);
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${String(unhandled)}`);
      }
    }
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return {};
  }

  async layoutParts({
    fileName,
    text,
  }: Omit<LayoutPartsRequest, "kind">): Promise<ReadonlyArray<LayoutPart>> {
    return layoutParts(new BrickCompiler(this.bundle.compiler), fileName, text);
  }

  async blueBrickBudget(): Promise<BlueBrickBudgetImport> {
    throw new Error("the held-out harness reads no BlueBrick budgets");
  }
}

export interface HeadlessEditor {
  readonly editor: IEditor;
  readonly backend: AimedBackend;
  readonly frame: () => Promise<void>;
  readonly clock: SliceClock;
  readonly plans: IPlanService;
}

const scheduledFrames: FrameRequestCallback[] = [];

function scheduleFrame(callback: FrameRequestCallback): number {
  scheduledFrames.push(callback);
  return scheduledFrames.length;
}

async function runScheduledFrames(): Promise<void> {
  const due = scheduledFrames.splice(0);
  const startMs = performance.now();
  for (const callback of due) callback(startMs);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function startHeadlessEditor(
  bundleRoot: string,
  bundle: Bundle,
  fetchUrl: FetchFunction,
): Promise<HeadlessEditor> {
  globalThis.requestAnimationFrame = scheduleFrame;
  const clock = new SliceClock();
  const backend = new AimedBackend(clock);
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: UNFETCHED_BUNDLE_URL,
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher(bundleRoot));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(IMPORT_WORKER_POOL).toConstantValue(new InProcessImportPool(bundle, fetchUrl));
  const archives = container.get(WORLD_REPOSITORY);
  container.rebind(WORLD_REPOSITORY).toConstantValue(new MemoryWorldRepository(archives));
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: CANVAS_WIDTH,
    clientHeight: CANVAS_HEIGHT,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  return { editor, backend, frame: runScheduledFrames, clock, plans: container.get(PLAN_SERVICE) };
}
