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
import { mainThreadModules } from "../client.module.ts";
import type { IEditor } from "../edit/editor.ts";
import { EDITOR } from "../tokens.ts";

const TOP_DOWN_SPAN_LDU = 4000;
const canvas = {
  clientWidth: 640,
  clientHeight: 480,
  dataset: {},
} as unknown as HTMLCanvasElement;

export class ModelSubsetLoader implements IPartBundleLoader {
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

export class HeadlessBackend implements ISceneBackend {
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
    out.set([ndcX * TOP_DOWN_SPAN_LDU, TOP_DOWN_SPAN_LDU, ndcY * TOP_DOWN_SPAN_LDU, 0, -1, 0]);
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

export interface HeadlessEditor {
  readonly container: Container;
  readonly editor: IEditor;
  readonly manifest: BundleManifest;
}

export function headlessContainer(
  fetcher: IAssetFetcher,
  models: ReadonlyArray<string>,
): Container {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const realLoader = container.get(PART_BUNDLE_LOADER);
  container.rebind(PART_BUNDLE_LOADER).toConstantValue(new ModelSubsetLoader(realLoader, models));
  container.rebind(SCENE_BACKEND).toConstantValue(new HeadlessBackend());
  return container;
}

export async function startHeadlessEditor(container: Container): Promise<HeadlessEditor> {
  const editor = container.get(EDITOR);
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1 });
  const manifest = await container.get(PART_BUNDLE_LOADER).loadManifest("standard");
  return { container, editor, manifest };
}

export function ndcOf(xLdu: number, zLdu: number): readonly [number, number] {
  return [xLdu / TOP_DOWN_SPAN_LDU, zLdu / TOP_DOWN_SPAN_LDU];
}

export class EditorHand {
  private clock = 0;

  constructor(private readonly editor: IEditor) {}

  time(): number {
    return this.clock++;
  }

  click(xLdu: number, zLdu: number): void {
    this.editor.pointerMove(...ndcOf(xLdu, zLdu));
    this.editor.click(...ndcOf(xLdu, zLdu), this.time());
  }

  drag(from: readonly [number, number], to: readonly [number, number]): boolean {
    this.editor.pointerMove(...ndcOf(...from));
    if (!this.editor.dragStart(...ndcOf(...from))) return false;
    this.editor.dragMove(...ndcOf(...to));
    this.editor.dragEnd(...ndcOf(...to), this.time());
    return true;
  }
}
