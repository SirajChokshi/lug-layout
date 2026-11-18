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
  type PartBundle,
  type PartFilter,
  type PartMesh,
  type PartShapeRecord,
  type StudPrimitiveAsset,
} from "@brr/catalog";
import type { BundleIndex, BundleLod, BundleManifest, CatalogPart } from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
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
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { commandEnabled, startPlay, type CommandId } from "../commands/editor-commands.ts";
import { toolHints } from "../commands/tool-hints.ts";
import type { ImportResult } from "@brr/import";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import { EDITOR, MODEL_IMPORTER, TRAIN_PLAY } from "../tokens.ts";
import type { EditorSnapshot, IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const PLACEABLE_SET = "7936-1";
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

class ModelSubsetLoader implements IPartBundleLoader {
  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly models: ReadonlyArray<string>,
  ) {}

  loadManifestFile(): Promise<string> {
    return this.loader.loadManifestFile();
  }

  async loadIndex(lod: BundleLod): Promise<BundleIndex> {
    const index = await this.loader.loadIndex(lod);
    return { ...index, models: index.models.filter((m) => this.models.includes(m.name)) };
  }

  loadStudPrimitives(lod: BundleLod): Promise<ReadonlyArray<StudPrimitiveAsset>> {
    return this.loader.loadStudPrimitives(lod);
  }

  loadPartShape(lod: BundleLod, part: CatalogPart): Promise<PartShapeRecord> {
    return this.loader.loadPartShape(lod, part);
  }

  loadModelRecord(lod: BundleLod, name: string): Promise<ModelRecord> {
    return this.loader.loadModelRecord(lod, name);
  }

  loadPartMesh(lod: BundleLod, file: string, priority: FetchPriority): Promise<PartMesh> {
    return this.loader.loadPartMesh(lod, file, priority);
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
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
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
  setFarModel(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startEditor(
  models: ReadonlyArray<string> | null = [PLACEABLE_SET, STUDLESS_SET],
  fetcher: IAssetFetcher = new BundleDirectoryFetcher(),
) {
  const backend = new HeadlessBackend();
  vi.stubGlobal("requestAnimationFrame", () => 0);
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
    container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, models));
  }
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;

  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  return { editor, backend, container, manifest: await realLoader.loadManifest("standard") };
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

it("loads a set's record only once it is picked, refuses clicks until then, and fetches its meshes once placed", async () => {
  const fetcher = new InFlightFetcher(new BundleDirectoryFetcher());
  const { editor, backend, manifest } = await startEditor([PLACEABLE_SET], fetcher);
  const set = `omr:${PLACEABLE_SET}`;
  const record = `standard/${manifest.models.find((model) => model.name === PLACEABLE_SET)?.file}`;
  const place = placer(editor, backend);

  expect(fetcher.paths).not.toContain(record);
  const whileLoading = place(set, 640, 640);
  expect(whileLoading).toEqual({
    placements: 0,
    refusedClicks: 1,
    reason: expect.stringContaining("is still loading"),
  });
  expect(await editor.prefetch(set)).toBe(true);
  expect(fetcher.paths).toContain(record);

  expect(place(set, 640, 640)).toMatchObject({ placements: 1, refusedClicks: 1 });
  await vi.waitFor(() => {
    const { meshes } = editor.snapshot();
    expect(meshes.wanted).toBeGreaterThan(0);
    expect(meshes.loaded).toBe(meshes.wanted);
  });
  expect(await partMeshes(fetcher.paths, "standard")).toHaveLength(editor.snapshot().meshes.wanted);
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
  const { editor, backend, container } = await startEditor([PLACEABLE_SET, "10205-1", "10133-1"]);
  const play = container.get(TRAIN_PLAY);
  const place = placer(editor, backend);
  const set = `omr:${PLACEABLE_SET}`;
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
  for (const item of [set, myOwnTrain, locomotive]) expect(await editor.prefetch(item)).toBe(true);
  place(set, 0, 0);
  const setPlaced = trains();
  place(myOwnTrain, 1600, 0);
  const myOwnTrainPlaced = trains();
  place(locomotive, 0, 1600);
  place(myOwnTrain, 1600, 1600);
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

function placer(editor: IEditor, backend: HeadlessBackend) {
  return (item: string, x: number, z: number) => {
    editor.chooseItem(item);
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    const { placements, refusedClicks, lastRefusal } = editor.snapshot();
    return { placements, refusedClicks, reason: lastRefusal?.reason ?? null };
  };
}

it("R cycles the fitting turns of a road curve at a road straight's open end, and the click lays the turn the ghost shows", async () => {
  const { editor, backend } = await startEditor([]);
  editor.chooseItem("ldraw:44336p04@72");
  backend.aim(320, 320);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  editor.chooseItem("ldraw:44342p02@72");
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

function selectAt(editor: IEditor, backend: HeadlessBackend, x: number, z: number) {
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
  const { editor, backend } = await startEditor([PLACEABLE_SET]);
  const place = placer(editor, backend);
  const set = `omr:${PLACEABLE_SET}`;
  expect(await editor.prefetch(set)).toBe(true);
  place(BASEPLATE, 0, 0);
  place(set, 0, 0);
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
  place(straight, 320, 320);
  place(straight, 320, 960);
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

it("offers none of the editing commands on a selection in a world another tab holds", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, []));
  container.rebind(SCENE_BACKEND).toConstantValue(new HeadlessBackend());
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

  editor.chooseItem(BASEPLATE);
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
}, 120_000);

const NO_LATTICE_REASON = "no stud lattice from the bake";

function refusedBake(fileName: string): ImportResult {
  return {
    report: {
      fileName,
      mirror: { repo: "", commit: "", root: "" },
      lod: "standard",
      sections: [],
      instanceCount: 0,
      drawnInstanceCount: 0,
      parts: [],
      inlineParts: [],
      looseGeometry: [],
      unknownColors: [],
      directColors: [],
      compileRounds: 0,
      bakeRounds: 1,
      bakeIssue: NO_LATTICE_REASON,
      fetched: { requests: 0, found: 0, notFound: 0, bytes: 0 },
      timings: { readMs: 0, resolveMs: 0, bakeMs: 0, totalMs: 0 },
    },
    partIds: [],
    instanceCount: 0,
    partIndex: new Uint32Array(),
    ldrawColor: new Uint32Array(),
    matrices: new Float32Array(),
    compiled: [],
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
  editor.chooseItem(BASEPLATE);

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

it("shows the stud totals of whichever world is open: none after New World, the placed ones again on reopening", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, []));
  container.rebind(SCENE_BACKEND).toConstantValue(new HeadlessBackend());
  const repository = new MemoryRepository();
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });

  editor.chooseItem(BASEPLATE);
  editor.click(0, 0, 0);
  const placed = editor.snapshot().studs;
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(1));
  const first = editor.snapshot().world?.id;
  if (!first) throw new Error("no current world");
  expect(await editor.newWorld("Second")).toBe(true);
  const fresh = editor.snapshot().studs;
  expect(await editor.openWorld(first)).toBe(true);

  expect(placed?.drawn).toBeGreaterThan(0);
  expect({ fresh, reopened: editor.snapshot().studs }).toEqual({
    fresh: { drawn: 0, culledInsideModels: 0, culledUnderFootprints: 0 },
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
    const { editor, backend } = await startEditor(["mils-plain", PLACEABLE_SET]);
    expect(await editor.prefetch(PLAIN_MODULE)).toBe(true);
    expect(await editor.prefetch(SET)).toBe(true);
    const place = placer(editor, backend);
    place(BASEPLATE, 0, 0);
    editor.chooseItem(held);
    backend.aim(at[0], at[1]);
    editor.pointerMove(0, 0);
    const ghostRefusal = editor.snapshot().hover?.refusal ?? null;
    const outcome = place(held, at[0], at[1]);

    expect({ outcome, ghostRefusal }).toEqual(expected);
  },
  120_000,
);

it("refuses to turn a 16 x 32 baseplate into the 3811 beside it", async () => {
  const { editor, backend } = await startEditor([]);
  const place = placer(editor, backend);
  const narrow = "ldraw:3857@2";
  const item = editor.snapshot().catalog.find((entry) => entry.id === narrow);
  if (!item) throw new Error(`${narrow} is not in the catalog`);
  editor.chooseItem(narrow);
  if (item.studsWide > item.studsDeep) editor.rotate(0);
  const halfWidth = (Math.min(item.studsWide, item.studsDeep) * 20) / 2;
  place(BASEPLATE, 0, 0);
  const flush = place(narrow, 320 + halfWidth, 0);
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
  const { editor, backend } = await startEditor(["mils-plain", PLACEABLE_SET]);
  expect(await editor.prefetch(PLAIN_MODULE)).toBe(true);
  expect(await editor.prefetch(SET)).toBe(true);
  const place = placer(editor, backend);
  place(PLAIN_MODULE, 320, 320);
  place(SET, 320, 320);
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
    const { editor, backend } = await startEditor(["mils-plain", PLACEABLE_SET]);
    expect(await editor.prefetch(PLAIN_MODULE)).toBe(true);
    expect(await editor.prefetch(SET)).toBe(true);
    const place = placer(editor, backend);
    for (const [item, x, z] of lay) place(item, x, z);
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
