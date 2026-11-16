import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type FrameStats,
  type ISceneBackend,
  type SceneBackendConfig,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { buildPartDisplay } from "./part-display.ts";
import { CHUNK_LDU, placementsToInstances } from "./placements.ts";
import { withStuds } from "./stud-stream.ts";
import {
  ColorTable,
  partPalette,
  summarize,
  type IViewerScene,
  type SceneSummary,
} from "./viewer-scene.ts";

const ORBIT_RADIUS_LDU = 1050;
const ORBIT_HEIGHT_LDU = 560;
const LOOK_AT_HEIGHT_LDU = 30;

@injectable()
export class PartDisplayScene implements IViewerScene {
  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
  ) {}

  attach(config: SceneBackendConfig): Promise<BackendInfo> {
    return this.backend.init(config);
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const [bundle, far] = await Promise.all([this.loader.load(lod), this.loader.load("far")]);
    const colors = new ColorTable(bundle);
    const chunks = buildPartDisplay(bundle, colors);
    const instances = chunks.map((chunk) =>
      withStuds(placementsToInstances(chunk), bundle.parts, colors, undefined),
    );
    this.backend.setPalette(partPalette(bundle, far, colors));
    chunks.forEach((chunk, i) => {
      const built = instances[i];
      if (built) this.backend.setChunk(chunk.key, built);
    });
    return summarize(
      bundle,
      chunks,
      instances.map((chunk) => chunk.studs),
      null,
    );
  }

  setCamera(t: number): void {
    const angle = t * 2 * Math.PI;
    const centreX = CHUNK_LDU * 1.25;
    const centreZ = CHUNK_LDU / 2;
    this.backend.setView(
      centreX + ORBIT_RADIUS_LDU * Math.cos(angle),
      ORBIT_HEIGHT_LDU,
      centreZ + ORBIT_RADIUS_LDU * Math.sin(angle),
      centreX,
      LOOK_AT_HEIGHT_LDU,
      centreZ,
    );
  }

  resize(width: number, height: number): void {
    this.backend.resize(width, height);
  }

  renderFrame(out: FrameStats): void {
    this.backend.renderFrame(out);
  }

  waitForGpu(): Promise<void> {
    return this.backend.waitForGpu();
  }

  bufferMemory(): BufferMemory {
    return this.backend.bufferMemory();
  }
}
