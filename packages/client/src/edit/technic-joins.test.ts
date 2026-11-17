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
import { STUD_LDU } from "@brr/math";
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type EdgeMarker,
  type ISceneBackend,
  type LookSettings,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";
import type { IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const MODULE = "mils-plain";
const NDC_TO_LDU = 10_000;
const RAY_START_Y = 1000;
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

class TopDownBackend implements ISceneBackend {
  markers: ReadonlyArray<EdgeMarker> = [];

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
  setMarkers(markers: ReadonlyArray<EdgeMarker>): void {
    this.markers = markers;
  }
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(): void {}
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    out.set([ndcX * NDC_TO_LDU, RAY_START_Y, ndcY * NDC_TO_LDU, 0, -1, 0]);
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

async function startEditor(backend: ISceneBackend): Promise<IEditor> {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, [MODULE]));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK });
  return editor;
}

function aimAt(editor: IEditor, xStuds: number, zStuds: number): void {
  editor.pointerMove((xStuds * STUD_LDU) / NDC_TO_LDU, (zStuds * STUD_LDU) / NDC_TO_LDU);
}

function pinMarkers(markers: ReadonlyArray<EdgeMarker>): number {
  return markers.filter(({ kind }) => kind === "pin").length;
}

it("pins a MILS module where the module grid seats it beside another, from the holes in both templates' edges, draws those pins, and places it there", async () => {
  const backend = new TopDownBackend();
  const editor = await startEditor(backend);
  expect(editor.snapshot().error).toBeNull();
  const gridStuds = editor.snapshot().baseplateGridStuds ?? 0;
  expect(gridStuds).toBeGreaterThan(0);
  editor.chooseItem(`generated:${MODULE}`);
  aimAt(editor, 0, 0);
  editor.click(0, 0, 0);
  expect(editor.snapshot().placements).toBe(1);
  const flushX =
    editor.snapshot().catalog.find((item) => item.id === `generated:${MODULE}`)?.studsWide ?? 0;

  aimAt(editor, flushX, 0);
  const flush = editor.snapshot();
  const pins = flush.ghost?.technicJoins ?? 0;
  expect(pins).toBeGreaterThan(0);
  expect(pinMarkers(backend.markers)).toBe(pins);

  aimAt(editor, flushX, gridStuds);
  const offset = editor.snapshot();
  expect(offset.moduleFit).toMatchObject({
    column: flush.moduleFit?.column,
    row: flush.moduleFit?.row,
  });
  expect(offset.ghost?.technicJoins).toBe(pins);
  expect(offset.hover).toEqual(flush.hover);
  expect(offset.ghost?.refusal).toBeNull();

  aimAt(editor, 2 * flushX + gridStuds, 0);
  expect(editor.snapshot().ghost?.technicJoins).toBe(0);
  expect(pinMarkers(backend.markers)).toBe(0);

  aimAt(editor, flushX, gridStuds);
  editor.click((flushX * STUD_LDU) / NDC_TO_LDU, (gridStuds * STUD_LDU) / NDC_TO_LDU, 0);
  const { placements } = editor.dump();
  const poses = placements.x.map((x, i) => [x, placements.z[i]]);
  expect(poses).toContainEqual([flush.hover?.x, flush.hover?.z]);
  expect(poses).toHaveLength(2);
}, 120_000);
