import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { chunkKey } from "./placements.ts";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";
import { withStuds } from "./stud-stream.ts";

export interface IModelScene extends IViewerScene {
  selectModel(name: string): void;
}

const ORBIT_DISTANCE_FACTOR = 2.2;
const ORBIT_ELEVATION_FACTOR = 0.9;
const MIN_ORBIT_RADIUS_LDU = 200;

@injectable()
export class ModelScene implements IModelScene {
  private modelName = "";
  private centreX = 0;
  private centreY = 0;
  private centreZ = 0;
  private radius = MIN_ORBIT_RADIUS_LDU;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  selectModel(name: string): void {
    this.modelName = name;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const bundle = await this.loader.load(lod);
    const entry = bundle.models.find((model) => model.name === this.modelName);
    if (!entry) {
      const available = bundle.models.map((model) => model.name).join(", ");
      throw new Error(`model "${this.modelName}" is not in the bundle (available: ${available})`);
    }
    const model = await this.loader.loadModel(lod, entry);
    const colors = new ColorTable(bundle);
    const colorIndex = new Uint16Array(model.instanceCount);
    for (let i = 0; i < model.instanceCount; i++) {
      colorIndex[i] = colors.indexOfCode(model.ldrawColor[i] ?? 0);
    }
    this.frame(model.matrices, model.instanceCount);
    const chunk = withStuds(
      {
        originX: 0,
        originZ: 0,
        count: model.instanceCount,
        partIndex: model.partIndex,
        colorIndex,
        matrices: model.matrices,
      },
      bundle.parts,
      colors,
      undefined,
    );
    return showChunks(
      this.backend,
      bundle,
      undefined,
      colors,
      [{ key: chunkKey(0, 0), instances: chunk }],
      {
        name: entry.name,
        source: entry.source,
        sections: model.sections,
      },
    );
  }

  private frame(matrices: Float32Array, count: number): void {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let i = 0; i < count; i++) {
      sumX += matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0;
      sumY += matrices[i * INSTANCE_MATRIX_FLOATS + 7] ?? 0;
      sumZ += matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0;
    }
    const n = Math.max(count, 1);
    this.centreX = sumX / n;
    this.centreY = sumY / n;
    this.centreZ = sumZ / n;
    let furthest = 0;
    for (let i = 0; i < count; i++) {
      const dx = (matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0) - this.centreX;
      const dz = (matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0) - this.centreZ;
      furthest = Math.max(furthest, Math.hypot(dx, dz));
    }
    this.radius = Math.max(furthest, MIN_ORBIT_RADIUS_LDU);
  }

  setCamera(t: number): void {
    const angle = t * 2 * Math.PI;
    const distance = this.radius * ORBIT_DISTANCE_FACTOR;
    this.backend.setView(
      this.centreX + distance * Math.cos(angle),
      this.centreY + this.radius * ORBIT_ELEVATION_FACTOR,
      this.centreZ + distance * Math.sin(angle),
      this.centreX,
      this.centreY,
      this.centreZ,
    );
  }
}
