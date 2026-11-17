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
const GROCER = "omr:10185-1";
const MARKET = "omr:10190-1";
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

async function startEditor(
  backend: ISceneBackend,
  models: ReadonlyArray<string> = [MODULE],
): Promise<IEditor> {
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

it("stands a modular flush against a neighbour whose Technic holes take its protruding pins, and says which turn would pin", async () => {
  const editor = await startEditor(new TopDownBackend(), ["10185-1", "10190-1"]);
  expect(editor.snapshot().error).toBeNull();
  editor.chooseItem(GROCER);
  aimAt(editor, 0, 0);
  editor.click(0, 0, 0);
  const depth = editor.snapshot().catalog.find((item) => item.id === GROCER)?.baseplate?.studsDeep;
  if (depth === undefined) throw new Error(`${GROCER} has no baseplate`);

  editor.chooseItem(MARKET);
  aimAt(editor, 0, -depth);
  const asLoaded = editor.snapshot().ghost;
  expect(asLoaded?.technicJoins).toBe(0);
  const turns = asLoaded?.technicTurn?.turns ?? 0;
  expect(turns).toBeGreaterThan(0);

  for (let t = 0; t < turns; t++) editor.rotate(0);
  aimAt(editor, 0, -depth);
  const turned = editor.snapshot();
  expect(turned.ghost?.refusal).toBeNull();
  expect(turned.ghost?.technicJoins).toBe(asLoaded?.technicTurn?.joins);

  const gridStuds = editor.snapshot().baseplateGridStuds ?? 0;
  aimAt(editor, gridStuds - 1, -depth);
  const pulled = editor.snapshot();
  expect(pulled.ghost?.snappedToTechnic).toBe(true);
  expect(pulled.ghost?.technicJoins).toBe(turned.ghost?.technicJoins);
  expect(pulled.hover).toEqual(turned.hover);

  editor.click(((gridStuds - 1) * STUD_LDU) / NDC_TO_LDU, (-depth * STUD_LDU) / NDC_TO_LDU, 0);
  expect(editor.snapshot().placements).toBe(2);
  const { placements } = editor.dump();
  expect(placements.x.map((x, i) => [x, placements.z[i]])).toContainEqual([
    turned.hover?.x,
    turned.hover?.z,
  ]);
}, 120_000);

it("refuses a modular where a Technic pin would go into a wall with no free hole, either way round", async () => {
  const editor = await startEditor(new TopDownBackend(), ["10185-1", "10218-1", "10190-1"]);
  editor.chooseItem(GROCER);
  aimAt(editor, 0, 0);
  editor.click(0, 0, 0);
  const depth = editor.snapshot().catalog.find((item) => item.id === GROCER)?.baseplate?.studsDeep;
  if (depth === undefined) throw new Error(`${GROCER} has no baseplate`);

  const aimTurned = (id: string, turns: number, x: number, z: number) => {
    editor.chooseItem(id);
    while (editor.snapshot().ghostRot !== turns) editor.rotate(0);
    aimAt(editor, x, z);
    const { ghost, hover } = editor.snapshot();
    return { pins: ghost?.technicJoins, rule: ghost?.refusal?.rule, hover };
  };
  const intoHeldWall = aimTurned("omr:10218-1", 3, 0, -depth);
  expect(intoHeldWall).toMatchObject({
    pins: 0,
    rule: "overlap",
    hover: { x: 0, z: -depth * STUD_LDU },
  });
  const intoPlacedWall = aimTurned(MARKET, 2, depth, 0);
  expect(intoPlacedWall).toMatchObject({
    pins: 0,
    rule: "overlap",
    hover: { x: depth * STUD_LDU, z: 0 },
  });
  editor.click((depth * STUD_LDU) / NDC_TO_LDU, 0, 0);
  expect(editor.snapshot().placements).toBe(1);
}, 120_000);
