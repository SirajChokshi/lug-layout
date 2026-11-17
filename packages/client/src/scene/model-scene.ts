import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { chunkKey } from "@brr/math";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";
import { withStuds } from "./stud-stream.ts";

export type ModelView = "orbit" | "top";

export interface IModelScene extends IViewerScene {
  selectModel(name: string, view: ModelView): void;
}

const ORBIT_DISTANCE_FACTOR = 2.8;
const ORBIT_ELEVATION_FACTOR = 0.9;
const MIN_ORBIT_RADIUS_LDU = 200;
const TOP_VIEW_DISTANCE_FACTOR = 3.2;
const TOP_VIEW_TILT_LDU = 0.001;

@injectable()
export class ModelScene implements IModelScene {
  private modelName = "";
  private view: ModelView = "orbit";
  private centreX = 0;
  private centreY = 0;
  private centreZ = 0;
  private radius = MIN_ORBIT_RADIUS_LDU;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  selectModel(name: string, view: ModelView): void {
    this.modelName = name;
    this.view = view;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const { bundle, entry, model } = await this.loader.loadModel(lod, this.modelName);
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
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = matrices[i * INSTANCE_MATRIX_FLOATS + 3 + axis * 4] ?? 0;
        min[axis] = Math.min(min[axis] ?? value, value);
        max[axis] = Math.max(max[axis] ?? value, value);
      }
    }
    const centre = (axis: number): number =>
      count > 0 ? ((min[axis] ?? 0) + (max[axis] ?? 0)) / 2 : 0;
    this.centreX = centre(0);
    this.centreY = centre(1);
    this.centreZ = centre(2);
    let furthest = 0;
    for (let i = 0; i < count; i++) {
      const dx = (matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0) - this.centreX;
      const dy = (matrices[i * INSTANCE_MATRIX_FLOATS + 7] ?? 0) - this.centreY;
      const dz = (matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0) - this.centreZ;
      furthest = Math.max(furthest, Math.hypot(dx, dy, dz));
    }
    this.radius = Math.max(furthest, MIN_ORBIT_RADIUS_LDU);
  }

  setCamera(t: number): void {
    if (this.view === "top") {
      this.backend.setView(
        this.centreX,
        this.centreY + this.radius * TOP_VIEW_DISTANCE_FACTOR,
        this.centreZ + TOP_VIEW_TILT_LDU,
        this.centreX,
        this.centreY,
        this.centreZ,
      );
      return;
    }
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
