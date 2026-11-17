import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
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
  WORLD_REPOSITORY,
  type IWorldRepository,
  type StoredWorld,
  type WorldChange,
} from "@brr/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR, PLAN_SERVICE } from "../tokens.ts";
import type { IEditor } from "./editor.ts";

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
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setGroundGrid(): void {}
  setGuides(): void {}
  projectToScreen(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
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
  setFarModel(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startEditor(models: ReadonlyArray<string> = [PLACEABLE_SET, STUDLESS_SET]) {
  const backend = new HeadlessBackend();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, models));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;

  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  return {
    editor,
    backend,
    plans: container.get(PLAN_SERVICE),
    manifest: await realLoader.loadManifest("standard"),
  };
}

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

async function editorWithFailingSaves() {
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
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  expect(editor.snapshot().status).toBe("ready");

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

it("undoes and redoes table edits in one timeline with placements", async () => {
  const { editor, backend, plans } = await startEditor();
  const baseplate = editor.snapshot().catalog.find((item) => item.id.startsWith("ldraw:3811@"));
  if (!baseplate) throw new Error("the bundle has no 3811");
  const placeAt = (x: number, z: number): void => {
    backend.aim(x, z);
    editor.chooseItem(baseplate.id);
    editor.click(0, 0, 0);
    editor.chooseItem(null);
  };
  const state = () => [
    editor.snapshot().placements,
    plans.snapshot().plans.map((plan) => plan.footprint.tables.map((t) => t.rect.width)),
  ];

  placeAt(320, 320);
  const { planId, tableId } = plans.drawTable({ minX: 0, minZ: 0, maxX: 1280, maxZ: 640 });
  plans.updateTable(planId, tableId, { rect: { x: 0, z: 0, width: 640, depth: 256 } });
  placeAt(960, 320);
  expect(state()).toEqual([2, [[640]]]);

  const undone = [];
  for (let i = 0; i < 4; i++) {
    undone.push([editor.snapshot().history.undo, ...state()]);
    editor.undo(0);
  }
  expect(undone).toEqual([
    ["place", 2, [[640]]],
    ["plan", 1, [[640]]],
    ["plan", 1, [[512]]],
    ["place", 1, []],
  ]);
  expect(state()).toEqual([0, []]);
  for (let i = 0; i < 4; i++) editor.redo(0);
  expect(state()).toEqual([2, [[640]]]);
  expect(editor.snapshot().history.redo).toBeNull();
}, 120_000);
