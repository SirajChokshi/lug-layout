import { ASSET_FETCHER, type IAssetFetcher, type PartAsset } from "@brr/catalog";
import {
  EDITOR,
  IMPORT_WORKER_POOL,
  mainThreadModules,
  type IEditor,
  type IImportWorkerPool,
  type ImportRun,
} from "@brr/client";
import {
  BrickCompiler,
  importStudioFile,
  LdrawMirror,
  ModelImportEngine,
  type FetchFunction,
  type IBakeHelper,
  type ImportResult,
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
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";

const RAY_HEIGHT_LDU = 10_000;
const NO_BAKE_HELPERS: ReadonlyArray<IBakeHelper> = [];
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 480;
const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

export class AimedBackend implements ISceneBackend {
  private aimX = 0;
  private aimZ = 0;

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
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}

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
}

export interface HeadlessEditor {
  readonly editor: IEditor;
  readonly backend: AimedBackend;
}

export async function startHeadlessEditor(
  bundleRoot: string,
  bundle: Bundle,
  fetchUrl: FetchFunction,
): Promise<HeadlessEditor> {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = () => 0;
  }
  const backend = new AimedBackend();
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher(bundleRoot));
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(IMPORT_WORKER_POOL).toConstantValue(new InProcessImportPool(bundle, fetchUrl));
  const editor = container.get(EDITOR);
  const canvas = {
    clientWidth: CANVAS_WIDTH,
    clientHeight: CANVAS_HEIGHT,
    dataset: {},
  } as unknown as HTMLCanvasElement;
  await editor.start(canvas, { api: "webgl2", pixelRatio: 1, look: NO_LOOK, tier: null });
  return { editor, backend };
}
