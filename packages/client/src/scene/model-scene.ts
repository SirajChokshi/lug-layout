import type { BundleLod } from "@brr/schema/bundle";
import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { chunkKey } from "@brr/math";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";
import { withStuds } from "./stud-stream.ts";

export type ModelView = "orbit" | "top" | "below";

export interface ModelCamera {
  readonly distanceLdu: number | null;
  readonly zoom: boolean;
}

export interface IModelScene extends IViewerScene {
  selectModel(name: string, view: ModelView): void;
  configureCamera(camera: ModelCamera): void;
}

const ORBIT_DISTANCE_FACTOR = 2.8;
const ORBIT_ELEVATION_FACTOR = 0.9;
const ELEVATION_PER_DISTANCE = ORBIT_ELEVATION_FACTOR / ORBIT_DISTANCE_FACTOR;
const MIN_ORBIT_RADIUS_LDU = 200;
const TOP_VIEW_DISTANCE_FACTOR = 3.2;
const TOP_VIEW_TILT_LDU = 0.001;
const ZOOM_NEAREST_RADIUS_FACTOR = 1.2;
const ZOOM_FARTHEST_LDU = 40_000;
const ZOOM_TURNS_PER_PERIOD = 0.25;
const MODEL_ORIGIN = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
const FAR_MODEL_INDEX = 0;
const FAR_MODEL_ID = 0;

@injectable()
export class ModelScene implements IModelScene {
  private modelName = "";
  private view: ModelView = "orbit";
  private camera: ModelCamera = { distanceLdu: null, zoom: false };
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

  configureCamera(camera: ModelCamera): void {
    this.camera = camera;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const [{ bundle, entry, model }, far] = await Promise.all([
      this.loader.loadModel(lod, this.modelName),
      this.loader.loadModel("far", this.modelName),
    ]);
    const farMesh = far.farMesh;
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
      model.studCover,
    );
    const key = chunkKey(0, 0);
    const summary = showChunks(
      this.backend,
      bundle,
      far.bundle,
      colors,
      [
        {
          key,
          instances: farMesh
            ? { ...chunk, voxelized: new Uint8Array(model.instanceCount).fill(1) }
            : chunk,
        },
      ],
      {
        name: entry.name,
        source: entry.source,
        sections: model.sections,
      },
      farMesh,
    );
    if (!farMesh) return summary;
    this.backend.setFarModel(FAR_MODEL_ID, {
      modelIndex: FAR_MODEL_INDEX,
      originX: 0,
      originZ: 0,
      matrix: MODEL_ORIGIN,
      chunkKeys: [key],
    });
    return summary;
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

  private zoomDistance(t: number): number {
    const nearest = this.radius * ZOOM_NEAREST_RADIUS_FACTOR;
    const outward = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI);
    return nearest * (ZOOM_FARTHEST_LDU / nearest) ** outward;
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
    const turns = this.camera.zoom ? t * ZOOM_TURNS_PER_PERIOD : t;
    const angle = turns * 2 * Math.PI;
    const distance = this.camera.zoom
      ? this.zoomDistance(t)
      : (this.camera.distanceLdu ?? this.radius * ORBIT_DISTANCE_FACTOR);
    this.backend.setView(
      this.centreX + distance * Math.cos(angle),
      this.centreY + (this.view === "below" ? -1 : 1) * distance * ELEVATION_PER_DISTANCE,
      this.centreZ + distance * Math.sin(angle),
      this.centreX,
      this.centreY,
      this.centreZ,
    );
  }
}
