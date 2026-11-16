import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import { SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { buildPartDisplay } from "./part-display.ts";
import { CHUNK_LDU, placementsToInstances } from "./placements.ts";
import { withStuds } from "./stud-stream.ts";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";

const ORBIT_RADIUS_LDU = 1050;
const ORBIT_HEIGHT_LDU = 560;
const LOOK_AT_HEIGHT_LDU = 30;

@injectable()
export class PartDisplayScene implements IViewerScene {
  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  async load(lod: BundleLod): Promise<SceneSummary> {
    const bundle = await this.loader.load(lod);
    const colors = new ColorTable(bundle);
    const chunks = buildPartDisplay(bundle, colors).map((chunk) => ({
      key: chunk.key,
      instances: withStuds(placementsToInstances(chunk), bundle.parts, colors, undefined),
    }));
    return showChunks(this.backend, bundle, undefined, colors, chunks, null);
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
}
