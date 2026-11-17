import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type BundleLod,
  type BundleManifest,
  type CompiledPartGlb,
  type IAssetFetcher,
  type ImportContext,
  type IPartBundleLoader,
  type ModelBundle,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const PLACEABLE_SET = "7936-1";
const STUDLESS_SET = "10016-1";
const NDC_SPAN_LDU = 10_000;
const CAMERA_HEIGHT_LDU = 2_000;

function ndc(x: number, z: number): readonly [number, number] {
  return [x / NDC_SPAN_LDU, -z / NDC_SPAN_LDU];
}

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
    return { requestedApi: "webgl2", activeApi: "webgl2", adapter: "none", backgroundSrgb: 0 };
  }
  setPalette(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setGhostTone(): void {}
  cueGhost(): void {}
  setSnapTargets(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(): void {}
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * NDC_SPAN_LDU, CAMERA_HEIGHT_LDU, -ndcY * NDC_SPAN_LDU, 0, -1, 0]);
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

async function startEditor() {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container
    .rebind(PART_BUNDLE_LOADER)
    .toConstantValue(new ModelSubsetLoader(realLoader, [PLACEABLE_SET, STUDLESS_SET]));
  container.rebind(SCENE_BACKEND).toConstantValue(new HeadlessBackend());
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;

  await editor.start(canvas, { api: "webgl2", pixelRatio: 1 });
  return { editor, manifest: await realLoader.loadManifest("standard") };
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

it("shows the ghost as blocked, with a reason, exactly where a click would be refused", async () => {
  const { editor } = await startEditor();
  const { catalog } = editor.snapshot();
  const road = catalog.find((item) => item.kind === "road-plate");
  const baseplate = catalog.find((item) => item.kind === "baseplate");
  const set = catalog.find((item) => item.id === `omr:${PLACEABLE_SET}`);
  if (!road || !baseplate || !set)
    throw new Error("the bundle lacks a road plate, baseplate or set");
  editor.chooseItem(road.id);
  editor.click(...ndc(0, 0), 0);
  expect(editor.snapshot().placements).toBe(1);

  const seen = new Set<string>();
  const clickMatchesGhost = (x: number, z: number): boolean => {
    const feedback = editor.snapshot().ghostFeedback;
    const refusalsBefore = editor.snapshot().refusals;
    editor.click(...ndc(x, z), 0);
    const refused = editor.snapshot().refusals > refusalsBefore;
    seen.add(feedback?.tone ?? "none");
    expect(feedback?.tone === "blocked").toBe(refused);
    expect(feedback?.message !== null).toBe(feedback?.tone !== "valid");
    return refused;
  };
  for (const item of [road, baseplate, set]) {
    editor.chooseItem(item.id);
    for (let x = -1_000; x <= 1_000; x += 140) {
      for (let z = -1_000; z <= 1_000; z += 140) {
        editor.pointerMove(...ndc(x, z));
        if (clickMatchesGhost(x, z)) continue;
        if (!clickMatchesGhost(x, z)) editor.undo(0);
        editor.undo(0);
      }
    }
  }
  expect([...seen].toSorted()).toEqual(["blocked", "snapped", "valid"]);
  expect(editor.snapshot().placements).toBe(1);
}, 120_000);
