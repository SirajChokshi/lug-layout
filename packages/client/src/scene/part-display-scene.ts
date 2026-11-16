import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type FrameStats,
  type ISceneBackend,
  type SceneBackendConfig,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { buildPartDisplay } from "./part-display.ts";
import { CHUNK_LDU, placementsToInstances } from "./placements.ts";
import { ColorTable, summarize, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";

const ORBIT_RADIUS_LDU = 760;
const ORBIT_HEIGHT_LDU = 420;
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
    const bundle = await this.loader.load(lod);
    const colors = new ColorTable();
    const chunks = buildPartDisplay(bundle, colors);
    this.backend.setPalette({
      parts: bundle.parts,
      studPrimitives: bundle.studPrimitives,
      colorsSrgb: colors.toSrgb(bundle),
    });
    for (const chunk of chunks) this.backend.setChunk(chunk.key, placementsToInstances(chunk));
    return summarize(bundle, chunks);
  }

  setCamera(t: number): void {
    const angle = t * 2 * Math.PI;
    const centreX = CHUNK_LDU * 0.8;
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
}
