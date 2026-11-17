import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type BricklinkPartCandidates,
  type CatalogCrosswalk,
  type CompiledPartGlb,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type FarModelPlacement,
  type PartPalette,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { STUD_LDU, ZETA16_ORDER } from "@brr/math";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { commandEnabled, type CommandId } from "../commands/editor-commands.ts";
import { EDITOR, RUN_SCENE, SIM_CLIENT } from "../tokens.ts";
import type { ISimClient, SimTickCost } from "../sim/sim-client.ts";
import {
  loadSession,
  type SimBenchResult,
  type SimFrameMessage,
  type SimLoad,
  type SimLoaded,
} from "@brr/sim";
import { TRACK_ITEM_ID, type IEditor } from "./editor.ts";

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

  constructor(
    private readonly files: IAssetFetcher,
    private readonly failing: (path: string) => boolean = () => false,
  ) {}

  private async track<T>(path: string, read: () => Promise<T>): Promise<T> {
    this.requests++;
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
  setPalette(palette: PartPalette): void {
    const far = palette.far?.parts.map((part) => part.id).join("\n");
    if (far !== undefined && far !== palette.detailed.parts.map((part) => part.id).join("\n")) {
      throw new Error("the palette's geometry sets do not list the same parts");
    }
  }
  setChunk(): void {}
  deleteChunk(): void {}
  ghost: ChunkInstances | null = null;
  setGhost(model: ChunkInstances | null): void {
    this.ghost = model;
  }
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  readonly vehicles = new Map<number, ReadonlyArray<number>>();
  setVehicle(vehicle: number): void {
    this.vehicles.set(vehicle, []);
  }
  setVehiclePose(vehicle: number, x: number, y: number, z: number, yaw: number): void {
    this.vehicles.set(vehicle, [x, y, z, yaw]);
  }
  deleteVehicle(vehicle: number): void {
    this.vehicles.delete(vehicle);
  }
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
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  readonly farModels = new Set<number>();
  setFarModel(id: number, placement: FarModelPlacement | null): void {
    if (placement) this.farModels.add(id);
    else this.farModels.delete(id);
  }
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
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
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
  return { editor, backend, manifest: await realLoader.loadManifest("standard") };
}

it("starts with every model in the bundle while keeping at most 16 bundle fetches in flight", async () => {
  const fetcher = new InFlightFetcher(new BundleDirectoryFetcher());
  const { editor, manifest } = await startEditor(null, fetcher);

  expect(fetcher.maxInFlight).toBeLessThanOrEqual(16);
  expect(fetcher.maxInFlight).toBeGreaterThan(1);
  expect(fetcher.requests).toBeGreaterThan(manifest.models.length);
  expect(editor.snapshot().error).toBeNull();
  expect(editor.snapshot().status).toBe("ready");
  expect(editor.snapshot().farTierError).toBeNull();
}, 300_000);

it("starts without the far tier when its files cannot be fetched", async () => {
  const fetcher = new InFlightFetcher(new BundleDirectoryFetcher(), (path) =>
    path.startsWith("far/"),
  );
  const { editor } = await startEditor([PLACEABLE_SET], fetcher);

  const snapshot = editor.snapshot();
  expect(snapshot.status).toBe("ready");
  expect(snapshot.error).toBeNull();
  expect(snapshot.farTierError).toContain("Failed to fetch");
  expect(snapshot.catalog.map((item) => item.id)).toContain(`omr:${PLACEABLE_SET}`);
}, 120_000);

it("offers a stud-less train as rolling stock for the track instead of skipping it as a set", async () => {
  const { editor } = await startEditor();

  const snapshot = editor.snapshot();
  expect(snapshot.error).toBeNull();
  expect(snapshot.status).toBe("ready");
  const items = snapshot.catalog.map((item) => [item.id, item.kind]);
  expect(items).toContainEqual([`omr:${PLACEABLE_SET}`, "model"]);
  expect(items).toContainEqual([`rolling-stock:omr:${STUDLESS_SET}`, "rolling-stock"]);
  expect(items.map(([id]) => id)).not.toContain(`omr:${STUDLESS_SET}`);
  expect(snapshot.catalogSkipped).toEqual([]);
  expect(snapshot.credits?.models.map((credit) => credit.name)).toContain(STUDLESS_SET);
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

it("loads every MILS module template, including the rail module whose joiners reach past its baseplate", async () => {
  const bundled = await new BundleDirectoryFetcher().text("standard/manifest.json");
  const modules = (JSON.parse(bundled) as BundleManifest).models
    .filter((model) => model.role === "mils-module")
    .map((model) => model.name);
  expect(modules).toContain("mils-rail-straight");
  const { editor } = await startEditor(modules);

  const snapshot = editor.snapshot();
  expect(snapshot.error).toBeNull();
  expect(snapshot.status).toBe("ready");
  expect(
    snapshot.catalog.filter((item) => item.kind === "mils-module").map((item) => item.id),
  ).toEqual(modules.map((name) => `generated:${name}`));
}, 120_000);

it("undoes, redoes, rotates and deletes placed MILS modules, keeping the module joins current", async () => {
  const { editor, backend } = await startEditor(["mils-road-straight", "mils-road-curve"]);
  const moduleLdu = 640;
  const placeAt = (item: string, column: number, row: number) => {
    editor.chooseItem(item);
    backend.aim(column * moduleLdu + moduleLdu / 2, row * moduleLdu + moduleLdu / 2);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
  };
  const counts = () => {
    const { placements, modules, error } = editor.snapshot();
    return { placements, joined: modules.joined, open: modules.open, error };
  };
  placeAt("generated:mils-road-straight", 0, 0);
  placeAt("generated:mils-road-curve", 1, 0);
  expect(counts()).toEqual({ placements: 2, joined: 2, open: 6, error: null });

  editor.undo(0);
  expect(counts()).toEqual({ placements: 1, joined: 0, open: 4, error: null });
  editor.redo(0);
  expect(counts()).toEqual({ placements: 2, joined: 2, open: 6, error: null });

  editor.chooseItem(null);
  backend.aim(moduleLdu * 1.5, moduleLdu / 2);
  editor.click(0, 0, 0);
  expect(editor.snapshot().selection?.item).toBe("generated:mils-road-curve");
  editor.rotate(0);
  expect(counts().placements).toBe(2);
  expect(editor.snapshot().modules.joined + editor.snapshot().modules.mismatched).toBe(2);
  editor.undo(0);
  expect(counts()).toEqual({ placements: 2, joined: 2, open: 6, error: null });
  editor.deleteSelection(0);
  expect(counts()).toEqual({ placements: 1, joined: 0, open: 4, error: null });
}, 120_000);

interface MemoryWorld {
  header: WorldHeader;
  readonly shards: Map<string, WorldShardV1>;
}

class FlakyRepository implements IWorldRepository {
  failSaves = false;
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

async function editorWithRepository(models: ReadonlyArray<string>) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, models));
  const backend = new HeadlessBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const repository = new FlakyRepository();
  container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  expect(editor.snapshot().status).toBe("ready");
  return { editor, backend, repository };
}

async function editorWithFailingSaves() {
  const { editor, backend, repository } = await editorWithRepository([]);
  editor.chooseItem(BASEPLATE);
  editor.click(0, 0, 0);
  await vi.waitFor(() => expect(repository.storedPlacements()).toBe(1));
  repository.failSaves = true;
  backend.aim(640, 0);
  editor.click(0, 0, 0);
  await vi.waitFor(() => expect(editor.snapshot().world?.save).toBe("failed"));
  return { editor, repository };
}

describe("unsaved edits after a failed save", () => {
  it.each([
    ["New", (editor: IEditor) => editor.newWorld("Other")],
    ["Import", (editor: IEditor) => editor.importWorld(new Uint8Array())],
  ])("refuses %s and keeps the world and its edits", async (_action, act) => {
    const { editor } = await editorWithFailingSaves();

    expect(await act(editor)).toBe(false);

    const snapshot = editor.snapshot();
    expect(snapshot.world?.name).toBe("World 1");
    expect(snapshot.placements).toBe(2);
    expect(snapshot.unsavedEdits).toBe(true);
    expect(snapshot.fileError).toContain("has unsaved edits (saving failed: QuotaExceededError)");
  });

  it("refuses Open of another world, then saves everything on Retry and lets the switch through", async () => {
    const { editor, repository } = await editorWithFailingSaves();
    const other = repository.seed({
      name: "Other",
      bundleVersion: "test",
      view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0, pitch: 0.75 },
      disclaimer: "disclaimer",
    });

    expect(await editor.openWorld(other.id)).toBe(false);
    expect(editor.snapshot().world?.name).toBe("World 1");

    repository.failSaves = false;
    await editor.retrySave();
    expect(repository.storedPlacements()).toBe(2);
    expect(editor.snapshot().unsavedEdits).toBe(false);
    expect(editor.snapshot().world?.save).toBe("saved");

    expect(await editor.openWorld(other.id)).toBe(true);
    expect(editor.snapshot().world?.name).toBe("Other");
  });
});

it.each([2, 3])(
  "chains %i rail modules end to end, flush on the ground with their rail edges joined",
  async (count) => {
    const { editor, backend } = await startEditor(["mils-rail-straight"]);
    const moduleLdu = 640;
    for (let column = 0; column < count; column++) {
      editor.chooseItem("generated:mils-rail-straight");
      backend.aim(column * moduleLdu + moduleLdu / 2, moduleLdu / 2);
      editor.pointerMove(0, 0);
      editor.click(0, 0, 0);
    }
    const { placements } = editor.dump();
    const { modules, lastRefusal, error } = editor.snapshot();
    const columns = Array.from({ length: count }, (_, column) => column);
    expect({
      x: placements.x.toSorted((a, b) => a - b),
      yPlates: placements.yPlates,
      seams: modules.joined / 2,
      mismatched: modules.mismatched,
      lastRefusal,
      error,
    }).toEqual({
      x: columns.map((column) => column * moduleLdu + moduleLdu / 2),
      yPlates: columns.map(() => 0),
      seams: count - 1,
      mismatched: 0,
      lastRefusal: null,
      error: null,
    });
  },
  120_000,
);

const RAIL_MODULE = "generated:mils-rail-straight";
const RAIL_LABEL = "Rail Module Straight (project rule, not MILS)";

function placer(editor: IEditor, backend: HeadlessBackend) {
  return (item: string, x: number, z: number) => {
    editor.chooseItem(item);
    backend.aim(x, z);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    const { placements, refusals, lastRefusal } = editor.snapshot();
    return { placements, refusals, reason: lastRefusal?.message ?? null };
  };
}

it("refuses a 10264-1 Corner Garage in a rail module's track end in either order, and takes it beside a terrain edge", async () => {
  const { editor, backend } = await startEditor(["mils-rail-straight", "10264-1"]);
  const place = placer(editor, backend);
  const garage = "omr:10264-1";

  place(RAIL_MODULE, 320, 320);
  const intoTrackEnd = place(garage, 960, 320);
  editor.rotate(0);
  editor.rotate(0);
  const besideTerrain = place(garage, 320, 960);
  editor.undo(0);
  editor.undo(0);
  editor.rotate(0);
  editor.rotate(0);
  place(garage, 960, 320);
  const trackEndIntoGarage = place(RAIL_MODULE, 320, 320);

  expect({ intoTrackEnd, besideTerrain, trackEndIntoGarage }).toEqual({
    intoTrackEnd: {
      placements: 1,
      refusals: 1,
      reason: expect.stringContaining(`the track end of ${RAIL_LABEL}`),
    },
    besideTerrain: { placements: 2, refusals: 1, reason: expect.any(String) },
    trackEndIntoGarage: {
      placements: 1,
      refusals: 2,
      reason: expect.stringContaining(`${RAIL_LABEL}: its track end would run into 10264-1`),
    },
  });
}, 120_000);

it("measures a set's volume from where its parts start, so 10190-1's hanging pins fill below the plate above them", async () => {
  const { editor, backend } = await startEditor(["mils-plain", "10190-1"]);
  const place = placer(editor, backend);
  place("omr:10190-1", 320, 320);
  expect(place("generated:mils-plain", 960, 320)).toEqual({
    placements: 1,
    refusals: 1,
    reason: expect.stringContaining("and 10190-1 Market Street (2007) fills 6 to 24 LDU."),
  });
}, 120_000);

it("refuses a rail edge against a plain or road module in either order, and joins terrain edges beside it", async () => {
  const { editor, backend } = await startEditor([
    "mils-rail-straight",
    "mils-plain",
    "mils-road-straight",
  ]);
  const place = placer(editor, backend);
  const facingRail = expect.stringContaining(`would face the rail edge of ${RAIL_LABEL}`);

  place(RAIL_MODULE, 320, 320);
  const plainOnRail = place("generated:mils-plain", 960, 320);
  const roadOnRail = place("generated:mils-road-straight", 960, 320);
  const plainOnTerrain = place("generated:mils-plain", 320, 960);
  editor.undo(0);
  editor.undo(0);
  editor.setSnapModules(false);
  place("generated:mils-plain", 960, 320);
  const railOnPlain = place(RAIL_MODULE, 320, 320);

  expect({ plainOnRail, roadOnRail, plainOnTerrain, railOnPlain }).toEqual({
    plainOnRail: { placements: 1, refusals: 1, reason: facingRail },
    roadOnRail: { placements: 1, refusals: 2, reason: facingRail },
    plainOnTerrain: { placements: 2, refusals: 2, reason: facingRail },
    railOnPlain: {
      placements: 1,
      refusals: 3,
      reason: expect.stringContaining(
        `${RAIL_LABEL}: its rail edge on the maxX side would face the terrain edge of MILS Basic Terrain Module`,
      ),
    },
  });
}, 120_000);

it.each([
  {
    name: "a MILS curve beside a MILS straight",
    models: ["mils-road-straight", "mils-road-curve"],
    placed: "generated:mils-road-straight",
    held: "generated:mils-road-curve",
    heldAt: [960, 320],
  },
  {
    name: "a road curve at a road straight's open end",
    models: [],
    placed: "ldraw:44336p04@72",
    held: "ldraw:44342p02@72",
    heldAt: [320, 960],
  },
] as const)(
  "R cycles the fitting turns of $name, and the click lays the turn the ghost shows",
  async ({ models, placed, held, heldAt }) => {
    const { editor, backend } = await startEditor(models);
    editor.chooseItem(placed);
    backend.aim(320, 320);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    editor.chooseItem(held);
    backend.aim(heldAt[0], heldAt[1]);
    editor.pointerMove(0, 0);
    const shown = () => {
      const { ghostRot, moduleFit, snap } = editor.snapshot();
      return { ghostRot, fit: moduleFit?.rot ?? (snap?.state === "snapped" ? ghostRot : null) };
    };
    const turns = [shown()];
    for (let press = 0; press < 4; press++) {
      editor.rotate(0);
      turns.push(shown());
    }
    for (const turn of turns) expect(turn.fit).toBe(turn.ghostRot);
    const rots = turns.map((turn) => turn.ghostRot);
    expect(new Set(rots).size).toBe(2);
    expect(rots.filter((rot, i) => i > 0 && rot === rots[i - 1])).toEqual([]);
    editor.click(0, 0, 0);
    const { placements } = editor.dump();
    expect(placements.rot.at(-1)).toBe(rots.at(-1));
  },
  120_000,
);

it("takes a 10185-1 Green Grocer flush against a rail edge when none of its parts reach the track end", async () => {
  const { editor, backend } = await startEditor(["mils-rail-straight", "10185-1"]);
  const place = placer(editor, backend);
  place(RAIL_MODULE, 320, 320);
  editor.chooseItem("omr:10185-1");
  editor.rotate(0);
  editor.rotate(0);
  const flush = place("omr:10185-1", 960, 320);
  const { placements } = editor.dump();

  expect({ flush, yPlates: placements.yPlates, rot: placements.rot.toSorted() }).toEqual({
    flush: { placements: 2, refusals: 0, reason: null },
    yPlates: [0, 0],
    rot: [0, 2],
  });
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
  const repository = new FlakyRepository();
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
  const repository = new FlakyRepository();
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
it.each([
  {
    name: "a road curve snapped to a road straight's open end",
    models: [],
    placed: "ldraw:44336p04@72",
    held: "ldraw:44342p02@72",
    heldAt: [320, 960],
  },
  {
    name: "a rail module turned to face a rail module's rail edge",
    models: ["mils-rail-straight"],
    placed: RAIL_MODULE,
    held: RAIL_MODULE,
    heldAt: [960, 320],
  },
] as const)(
  "checks and places $name at the snapped turn, not the turn R chose",
  async ({ models, placed, held, heldAt }) => {
    const { editor, backend } = await startEditor(models);
    editor.chooseItem(placed);
    backend.aim(320, 320);
    editor.pointerMove(0, 0);
    editor.click(0, 0, 0);
    editor.chooseItem(held);
    backend.aim(heldAt[0], heldAt[1]);
    editor.pointerMove(0, 0);
    let chosen = editor.snapshot().ghostRot;
    for (let press = 0; press < 4 && editor.snapshot().ghostRot === chosen; press++) {
      chosen = (editor.snapshot().ghostRot + 1) % 4;
      editor.rotate(0);
    }
    const { ghostRot: snapped, ghost } = editor.snapshot();
    expect(snapped).not.toBe(chosen);
    expect(ghost?.refusal ?? null).toBeNull();
    editor.click(0, 0, 0);
    const { placements, refusals } = editor.snapshot();
    expect({ placements, refusals, rot: editor.dump().placements.rot.at(-1) }).toEqual({
      placements: 2,
      refusals: 0,
      rot: snapped,
    });
  },
  120_000,
);
const SET_WITH_TRACK = "10128-1";

function drawTrack(
  editor: IEditor,
  backend: HeadlessBackend,
  from: readonly [number, number],
  to: readonly [number, number],
) {
  editor.chooseItem(TRACK_ITEM_ID);
  backend.aim(...from);
  editor.pointerMove(0, 0);
  editor.dragStart(0, 0);
  backend.aim(...to);
  editor.dragMove(0, 0);
  editor.dragEnd(0, 0, 0);
  const track = editor.snapshot().track;
  editor.chooseItem(null);
  return { pieces: track?.pieces ?? 0, lastCommit: track?.lastCommit ?? null };
}

function placeItem(editor: IEditor, backend: HeadlessBackend, item: string, x: number, z: number) {
  editor.chooseItem(item);
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  editor.chooseItem(null);
}

describe("placement rules across a world switch", () => {
  it("starts another world without the last one's baseplates, volumes or track, and reloads all three with the saved world", async () => {
    const { editor, backend, repository } = await editorWithRepository([SET_WITH_TRACK]);
    placeItem(editor, backend, BASEPLATE, 0, 0);
    expect(drawTrack(editor, backend, [-300, 0], [20, 0])).toMatchObject({
      pieces: 1,
      lastCommit: "laid",
    });
    placeItem(editor, backend, `omr:${SET_WITH_TRACK}`, 3200, 0);
    const saved = editor.snapshot();
    expect(saved.placements).toBe(2);
    const farModels = backend.farModels.size;
    expect(farModels).toBe(1);
    const openEnds = saved.track?.openEnds ?? 0;
    expect(openEnds).toBeGreaterThan(2);
    const first = saved.world?.id;
    if (!first) throw new Error("the first world has no id");
    placeItem(editor, backend, BASEPLATE, 0, 0);
    expect(editor.snapshot().refusals).toBe(1);
    await vi.waitFor(() => expect(repository.storedPlacements()).toBe(2));

    expect(await editor.newWorld("Empty")).toBe(true);
    expect(editor.snapshot()).toMatchObject({ refusals: 0, lastRefusal: null });
    expect(editor.snapshot().track?.openEnds).toBe(0);
    expect(backend.farModels.size).toBe(0);
    expect(drawTrack(editor, backend, [-300, 0], [20, 0])).toMatchObject({
      pieces: 0,
      lastCommit: "refused-off-baseplate",
    });
    placeItem(editor, backend, BASEPLATE, 0, 0);
    expect(editor.snapshot().placements).toBe(1);

    expect(await editor.openWorld(first)).toBe(true);
    const reloaded = editor.snapshot();
    expect(reloaded.placements).toBe(2);
    expect(reloaded.track?.pieces).toBe(1);
    expect(reloaded.track?.openEnds).toBe(openEnds);
    expect(backend.farModels.size).toBe(farModels);

    const refusals = reloaded.refusals;
    placeItem(editor, backend, BASEPLATE, 0, 0);
    expect(editor.snapshot().placements).toBe(2);
    expect(editor.snapshot().refusals).toBe(refusals + 1);

    expect(drawTrack(editor, backend, [-140, -200], [-140, 120])).toMatchObject({
      pieces: 1,
      lastCommit: "refused-crosses-track",
    });

    backend.aim(200, 200);
    editor.click(0, 0, 0);
    expect(editor.snapshot().selection?.item).toBe(BASEPLATE);
    editor.deleteSelection(0);
    expect(editor.snapshot().placements).toBe(2);
    expect(editor.snapshot().lastRefusal?.rule).toBe("carries");
  }, 120_000);
});

const LOCOMOTIVE = "10133-1";
const CAR = "10017-1";
const ROLLING_STOCK_MODELS = [
  "10133-1",
  "10014-1",
  "10020-1",
  "10022-1_Dining-Car",
  "10025-1_Baggage-Car",
  "10205-1",
  "10013-1",
  "10016-1",
  "10017-1",
];
const BASEPLATE_ROW = [-1920, -1280, -640, 0, 640, 1280, 1920];
const ONTO_TRACK: ReadonlyArray<readonly [number, number]> = [
  [0, 10],
  [-1200, 800],
];
const TRACK_FROM: readonly [number, number] = [-1920, 0];
const TRACK_TO: readonly [number, number] = [1920, 0];

function stock(model: string): string {
  return `rolling-stock:omr:${model}`;
}

function layTestLine(editor: IEditor, backend: HeadlessBackend) {
  for (const x of BASEPLATE_ROW) placeItem(editor, backend, BASEPLATE, x, 0);
  return drawTrack(editor, backend, TRACK_FROM, TRACK_TO);
}

function layTestOval(editor: IEditor, backend: HeadlessBackend) {
  const side = 640;
  for (const x of [-2.5, -1.5, -0.5, 0.5, 1.5].map((k) => k * side)) {
    for (const z of [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map((k) => k * side)) {
      placeItem(editor, backend, BASEPLATE, x, z);
    }
  }
  drawTrack(editor, backend, [-400, 0], [400, 0]);
  const ends = editor.dump().trackEnds;
  const lattice = (ldu: number) => Math.round(ldu / STUD_LDU) * STUD_LDU;
  const east = ends.find((end) => end.heading === 0);
  const west = ends.find((end) => end.heading === ZETA16_ORDER / 2);
  if (!east || !west)
    throw new Error(`a straight run has an east and a west end: ${JSON.stringify(ends)}`);
  return drawTrack(
    editor,
    backend,
    [lattice(east.xLdu), lattice(east.zLdu)],
    [lattice(west.xLdu), lattice(west.zLdu)],
  );
}

function aimTrain(editor: IEditor, backend: HeadlessBackend, item: string, x: number, z: number) {
  if (editor.snapshot().activeItem !== item) editor.chooseItem(item);
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  return editor.snapshot().trains.ghost;
}

function placeTrain(editor: IEditor, backend: HeadlessBackend, item: string, x: number, z: number) {
  const ghost = aimTrain(editor, backend, item, x, z);
  editor.click(0, 0, 0);
  return ghost;
}

function vehiclePoses(backend: HeadlessBackend): ReadonlyArray<ReadonlyArray<number>> {
  return [...backend.vehicles.entries()].toSorted(([a], [b]) => a - b).map(([, pose]) => pose);
}

class InProcessSim implements ISimClient {
  private frame: SimFrameMessage | null = null;

  async load(load: SimLoad): Promise<SimLoaded> {
    const { session, loaded } = loadSession(load);
    const data = new Float64Array(session.layout.floats);
    session.writeFrame(data);
    this.frame = { tick: 0, stateHash: 0, batchTicks: 0, batchStepMs: 0, data };
    return loaded;
  }
  run(): void {}
  async command(): Promise<boolean> {
    return true;
  }
  latestFrame(): SimFrameMessage | null {
    return this.frame;
  }
  nextFrame(): Promise<SimFrameMessage> {
    return this.frame ? Promise.resolve(this.frame) : Promise.reject(new Error("not loaded"));
  }
  tickCost(): SimTickCost {
    return { ticks: 0, stepMs: 0, frames: 0 };
  }
  bench(): Promise<SimBenchResult> {
    return Promise.reject(new Error("no bench in this test"));
  }
}

describe("rolling stock on track", () => {
  it("stands every train model in the bundle whole on straight and curved track, axles on the centreline", async () => {
    const { editor, backend } = await startEditor(ROLLING_STOCK_MODELS);
    expect(layTestOval(editor, backend)).toEqual({ pieces: 20, lastCommit: "joined" });
    const stood = ROLLING_STOCK_MODELS.flatMap((model) =>
      ONTO_TRACK.map(([x, z]) => {
        const ghost = placeTrain(editor, backend, stock(model), x, z);
        const [train] = editor.dump().trains;
        const result = {
          model,
          x,
          ghost: ghost?.state,
          refusal: ghost?.refusal?.message ?? null,
          trains: editor.dump().trains.length,
          integerHead: Number.isInteger(train?.offsetLdu),
          onCentreline: (train?.axleOffCentreLdu ?? 1) < 1e-9,
          drawn: backend.vehicles.size > 0,
        };
        editor.undo(0);
        return result;
      }),
    );
    expect(stood).toEqual(
      ROLLING_STOCK_MODELS.flatMap((model) =>
        ONTO_TRACK.map(([x]) => ({
          model,
          x,
          ghost: "on-track",
          refusal: null,
          trains: 1,
          integerHead: true,
          onCentreline: true,
          drawn: true,
        })),
      ),
    );
    expect(backend.vehicles.size).toBe(0);
  }, 180_000);

  it("refuses rolling stock on baseplates, the bare table, and track another train holds", async () => {
    const { editor, backend } = await startEditor([LOCOMOTIVE, CAR]);
    layTestLine(editor, backend);
    placeTrain(editor, backend, stock(LOCOMOTIVE), 0, 0);
    expect(editor.dump().trains).toHaveLength(1);
    const attempts = (
      [
        [stock(CAR), 0, 200],
        [stock(CAR), 4000, 0],
        [stock(LOCOMOTIVE), 100, 0],
      ] as const
    ).map(([item, x, z]) => {
      const before = editor.snapshot().refusals;
      const ghost = placeTrain(editor, backend, item, x, z);
      return {
        state: ghost?.state,
        rule: ghost?.refusal?.rule,
        counted: editor.snapshot().refusals - before,
      };
    });
    expect(attempts).toEqual([
      { state: "off-track", rule: "rolling-stock", counted: 1 },
      { state: "off-track", rule: "rolling-stock", counted: 1 },
      { state: "on-track", rule: "rolling-stock", counted: 1 },
    ]);
    expect(editor.snapshot().lastRefusal?.message).toContain("already occupies");
    expect(editor.dump().trains.map((train) => train.cars.length)).toEqual([1]);
  }, 120_000);

  it("couples a car behind a train and undoes it in the one history with world edits", async () => {
    const { editor, backend } = await startEditor([LOCOMOTIVE, CAR]);
    layTestLine(editor, backend);
    placeTrain(editor, backend, stock(LOCOMOTIVE), 400, 0);
    const alone = vehiclePoses(backend);
    expect(aimTrain(editor, backend, stock(CAR), -300, 0)?.couplesTo).toBe(1);
    editor.click(0, 0, 0);
    const cars = () => editor.dump().trains.map((train) => train.cars.map((car) => car.model));
    expect(cars()).toEqual([[`omr:${LOCOMOTIVE}`, `omr:${CAR}`]]);
    expect(vehiclePoses(backend).slice(0, alone.length)).toEqual(alone);
    editor.chooseItem(null);
    placeItem(editor, backend, BASEPLATE, 0, 1280);
    expect(editor.snapshot().history).toMatchObject({ undo: "place", undoDepth: 10 });

    editor.undo(0);
    expect([editor.snapshot().placements, cars()]).toEqual([
      7,
      [[`omr:${LOCOMOTIVE}`, `omr:${CAR}`]],
    ]);
    editor.undo(0);
    expect(cars()).toEqual([[`omr:${LOCOMOTIVE}`]]);
    expect(vehiclePoses(backend)).toEqual(alone);
    editor.undo(0);
    expect([cars(), backend.vehicles.size]).toEqual([[], 0]);
    editor.redo(0);
    editor.redo(0);
    editor.redo(0);
    expect([editor.snapshot().placements, cars().length]).toEqual([8, 1]);

    backend.aim(400, 0);
    editor.click(0, 0, 0);
    expect(editor.snapshot().trains.selected).toBe(1);
    editor.deleteSelection(0);
    expect(cars()).toEqual([]);
    editor.undo(0);
    expect(cars()).toEqual([[`omr:${LOCOMOTIVE}`, `omr:${CAR}`]]);
  }, 120_000);

  it("refuses lifting track out from under a train, and keeps it on the rails when other track is lifted", async () => {
    const { editor, backend } = await startEditor([LOCOMOTIVE]);
    layTestLine(editor, backend);
    placeTrain(editor, backend, stock(LOCOMOTIVE), 0, 0);
    const [before] = editor.dump().trains;
    const poses = vehiclePoses(backend);
    const removePieceAt = (x: number) => {
      editor.chooseItem(TRACK_ITEM_ID);
      backend.aim(x, 0);
      editor.pointerMove(0, 0);
      editor.dragStart(0, 0);
      editor.dragEnd(0, 0, 0);
      editor.deleteSelection(0);
      editor.chooseItem(null);
      return editor.snapshot().track?.pieces;
    };
    expect(removePieceAt(0)).toBe(12);
    expect(editor.snapshot().lastRefusal?.rule).toBe("rolling-stock");
    expect(removePieceAt(-1440)).toBe(11);
    const [after] = editor.dump().trains;
    expect(after?.track).toBe((before?.track ?? 0) - 1);
    expect(after?.offsetLdu).toBe(before?.offsetLdu);
    expect(vehiclePoses(backend)).toEqual(poses);
  }, 120_000);

  it("saves the train with the world, reopens it in place, and the run viewer starts it exactly there", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const container = new Container();
    container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "disclaimer" }));
    container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
    const realLoader = container.get(PART_BUNDLE_LOADER);
    container
      .rebind(PART_BUNDLE_LOADER)
      .toConstantValue(new ModelSubsetLoader(realLoader, [LOCOMOTIVE, CAR]));
    const backend = new HeadlessBackend();
    container.rebind(SCENE_BACKEND).toConstantValue(backend);
    const repository = new FlakyRepository();
    container.rebind(WORLD_REPOSITORY).toConstantValue(repository);
    const editor = container.get(EDITOR);
    const canvas = {
      clientWidth: 640,
      clientHeight: 480,
      dataset: {},
    } as unknown as HTMLCanvasElement;
    await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
    layTestLine(editor, backend);
    placeTrain(editor, backend, stock(LOCOMOTIVE), 300, 0);
    placeTrain(editor, backend, stock(CAR), -400, 0);
    placeTrain(editor, backend, stock(CAR), 1700, 0);
    expect(editor.dump().trains.map((train) => train.cars.length)).toEqual([2, 1]);
    const placed = editor.dump().trains;
    const poses = vehiclePoses(backend);
    await vi.waitFor(() => expect(editor.snapshot().world?.save).toBe("saved"));
    const world = editor.snapshot().world?.id;
    if (!world) throw new Error("no saved world");

    expect(await editor.newWorld("Other")).toBe(true);
    expect([editor.dump().trains, backend.vehicles.size]).toEqual([[], 0]);
    expect(await editor.openWorld(world)).toBe(true);
    expect(editor.dump().trains).toEqual(placed);
    expect(vehiclePoses(backend)).toEqual(poses);

    const runBackend = new HeadlessBackend();
    container.rebind(SCENE_BACKEND).toConstantValue(runBackend);
    container.rebind(SIM_CLIENT).toConstantValue(new InProcessSim());
    const run = container.get(RUN_SCENE);
    run.configure({
      world,
      plan: "",
      consist: [],
      trains: [],
      speedLduPerS: 400,
      accelerationLduPerS2: 150,
      brakingLduPerS2: 300,
      follow: false,
      start: false,
      autopilotSeed: null,
      followDistanceLdu: 1400,
    });
    await run.load("standard");
    run.onFrame?.();
    const started = vehiclePoses(runBackend);
    expect(started).toHaveLength(poses.length);
    started.forEach((pose, i) =>
      pose.forEach((value, k) => expect(value).toBeCloseTo(poses[i]?.[k] ?? Number.NaN, 9)),
    );
  }, 120_000);
});
