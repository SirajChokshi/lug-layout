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
import { PLATE_LDU } from "@brr/math";
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
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const PLACEABLE_SET = "7936-1";
const RAY_HEIGHT_LDU = 10_000;
const STUDLESS_SET = "10016-1";
const BUILDING_SET = "2150-1";
const SET_ON_3811 = "10264-1";
const MILS_SURFACE_PLATES = 4;
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

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
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startEditor(models: ReadonlyArray<string> = [PLACEABLE_SET, STUDLESS_SET]) {
  const backend = new HeadlessBackend();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
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

  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK });
  return { editor, backend, manifest: await realLoader.loadManifest("standard") };
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

type StartedEditor = Awaited<ReturnType<typeof startEditor>>;

function placeAndSelect({ editor, backend }: StartedEditor, item: string, x: number, z: number) {
  const placedBefore = editor.snapshot().placements;
  editor.chooseItem(item);
  backend.aim(x, z);
  editor.pointerMove(0, 0);
  editor.click(0, 0, 0);
  editor.chooseItem(null);
  editor.click(0, 0, 0);
  const { placements, selection, lastRefusal } = editor.snapshot();
  expect({ placements, lastRefusal }).toEqual({ placements: placedBefore + 1, lastRefusal: null });
  expect(selection?.item).toBe(item);
  return selection?.box ?? null;
}

it("rests a building on a MILS module's 4-plate surface, exactly 32 LDU above the baseplate tops", async () => {
  const started = await startEditor(["mils-plain", BUILDING_SET]);

  const module = placeAndSelect(started, "generated:mils-plain", 320, 320);
  const building = placeAndSelect(started, `omr:${BUILDING_SET}`, 320, 320);

  expect(module?.maxY).toBe(MILS_SURFACE_PLATES * PLATE_LDU);
  expect(building?.minY).toBe(MILS_SURFACE_PLATES * PLATE_LDU);
}, 120_000);

it("seats a set built on a 3811 level with a standalone 3811, and rests a building flush on a 3811's top face", async () => {
  const started = await startEditor([SET_ON_3811, BUILDING_SET]);
  const baseplate = started.editor.snapshot().catalog.find((item) => item.group === "ldraw:3811");
  expect(baseplate).toBeDefined();

  const standalone = placeAndSelect(started, baseplate?.id ?? "", 2_000, 320);
  const building = placeAndSelect(started, `omr:${BUILDING_SET}`, 2_000, 320);
  const set = placeAndSelect(started, `omr:${SET_ON_3811}`, 4_000, 320);

  expect(building?.minY).toBe(standalone?.maxY);
  expect(set?.minY).toBe(standalone?.minY);
}, 120_000);
