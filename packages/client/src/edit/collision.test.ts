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
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { STUD_LDU } from "@brr/math";
import type { BundleLod, BundleManifest } from "@brr/schema/bundle";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR } from "../tokens.ts";
import { TRACK_ITEM_ID, type IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const GREEN_GROCER = "10185-1";
const MARKET_STREET = "10190-1";
const BASEPLATE = "ldraw:3811";
const MODULE_LDU = 640;
const TRACK_HALF_WIDTH_LDU = 80;
const RUN_LDU = 240;
const NDC_TO_LDU = 10_000;
const RAY_START_Y = 1000;

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
  async init(): Promise<BackendInfo> {
    return { requestedApi: "webgl2", activeApi: "webgl2", adapter: "none", backgroundSrgb: 0 };
  }
  setPalette(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
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

async function startEditor(models: ReadonlyArray<string>): Promise<IEditor> {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, models));
  container.rebind(SCENE_BACKEND).toConstantValue(new TopDownBackend());
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1 });
  return editor;
}

function hoverAt(editor: IEditor, x: number, z: number): string | null {
  editor.pointerMove(x / NDC_TO_LDU, z / NDC_TO_LDU);
  const ghost = editor.snapshot().ghost;
  if (!ghost) throw new Error(`no ghost at ${x}, ${z}`);
  return ghost.refusal === null ? null : `${ghost.refusal.rule}: ${ghost.refusal.message}`;
}

function chooseGroup(editor: IEditor, group: string): void {
  const item = editor.snapshot().catalog.find((entry) => entry.group === group);
  if (!item) throw new Error(`the catalog has no ${group}`);
  editor.chooseItem(item.id);
}

function turnTo(editor: IEditor, rot: number): void {
  while (editor.snapshot().ghostRot !== rot) editor.rotate(0);
}

it("joins real modular buildings with the Technic pins inside their neighbour's pin holes, and refuses real parts that would intersect", async () => {
  const editor = await startEditor([GREEN_GROCER, MARKET_STREET]);
  expect(editor.snapshot().error).toBeNull();

  editor.chooseItem(`omr:${GREEN_GROCER}`);
  expect(hoverAt(editor, 0, 0)).toBeNull();
  editor.click(0, 0, 0);
  const grocer = editor.snapshot().hover;
  if (!grocer) throw new Error("the Green Grocer has no pose");
  const besideItsPins = { x: grocer.x, z: grocer.z - MODULE_LDU };

  editor.chooseItem(`omr:${MARKET_STREET}`);
  turnTo(editor, 3);
  expect(hoverAt(editor, besideItsPins.x, besideItsPins.z)).toMatch(
    /^overlap: 10190-1 would intersect 10185-1 at x -?\d+, z -?\d+ LDU .* fills 7\.75 to 10\.19 LDU above the baseplate tops, and 10185-1 fills 7\.75 to 10\.19 LDU\.$/,
  );
  turnTo(editor, 0);
  expect(hoverAt(editor, besideItsPins.x, besideItsPins.z)).toMatch(
    /^overlap: 10190-1 would intersect 10185-1 .* and 10185-1 fills 7\.75 to 10\.19 LDU\.$/,
  );
  for (const dx of [MODULE_LDU, -MODULE_LDU]) {
    expect(hoverAt(editor, grocer.x + dx, grocer.z)).toBeNull();
  }
  expect(hoverAt(editor, grocer.x + MODULE_LDU / 2, grocer.z)).toMatch(
    /^overlap: 10190-1 would intersect 10185-1 /,
  );

  turnTo(editor, 1);
  expect(hoverAt(editor, besideItsPins.x, besideItsPins.z)).toBeNull();
  editor.click(besideItsPins.x / NDC_TO_LDU, besideItsPins.z / NDC_TO_LDU, 0);
  expect(editor.snapshot().placements).toBe(2);
}, 120_000);

function layRun(editor: IEditor, from: readonly [number, number], to: readonly [number, number]) {
  editor.pointerMove(from[0] / NDC_TO_LDU, from[1] / NDC_TO_LDU);
  editor.dragStart(from[0] / NDC_TO_LDU, from[1] / NDC_TO_LDU);
  editor.dragMove(to[0] / NDC_TO_LDU, to[1] / NDC_TO_LDU);
  editor.dragEnd(to[0] / NDC_TO_LDU, to[1] / NDC_TO_LDU, 0);
  return editor.snapshot();
}

it("lays track on baseplate studs flush against a real building, and refuses a run that cuts into it", async () => {
  const editor = await startEditor([GREEN_GROCER]);
  expect(editor.snapshot().error).toBeNull();
  editor.chooseItem(`omr:${GREEN_GROCER}`);
  expect(hoverAt(editor, 0, 0)).toBeNull();
  editor.click(0, 0, 0);
  const grocer = editor.snapshot().hover;
  if (!grocer) throw new Error("the Green Grocer has no pose");
  chooseGroup(editor, BASEPLATE);
  expect(hoverAt(editor, grocer.x + MODULE_LDU, grocer.z)).toBeNull();
  editor.click((grocer.x + MODULE_LDU) / NDC_TO_LDU, grocer.z / NDC_TO_LDU, 0);
  expect(editor.snapshot().placements).toBe(2);

  editor.chooseItem(TRACK_ITEM_ID);
  const edgeX = grocer.x + MODULE_LDU / 2;
  const cutting = layRun(
    editor,
    [edgeX + TRACK_HALF_WIDTH_LDU - STUD_LDU, grocer.z - RUN_LDU],
    [edgeX + TRACK_HALF_WIDTH_LDU - STUD_LDU, grocer.z + RUN_LDU],
  );
  expect(cutting.track?.lastCommit).toBe("refused-overlap");
  expect(cutting.lastRefusal?.message).toMatch(/would intersect 10185-1 at x -?\d+, z -?\d+ LDU/);
  const flush = layRun(
    editor,
    [edgeX + TRACK_HALF_WIDTH_LDU, grocer.z - RUN_LDU],
    [edgeX + TRACK_HALF_WIDTH_LDU, grocer.z + RUN_LDU],
  );
  expect(flush.track?.lastCommit).toBe("laid");
  expect(flush.track?.pieces).toBeGreaterThan(0);
}, 120_000);
