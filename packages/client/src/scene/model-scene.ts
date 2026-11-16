import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { BomCounter } from "@brr/domain";
import { inject, injectable } from "inversify";
import { chunkKey } from "@brr/math";
import { sceneRegion, type BomInput, type BomScope, type IBomSource } from "../bom/bom-service.ts";
import { ColorTable, showChunks, type IViewerScene, type SceneSummary } from "./viewer-scene.ts";
import { withStuds } from "./stud-stream.ts";

export interface IModelScene extends IViewerScene, IBomSource {
  selectModel(name: string): void;
}

const ORBIT_DISTANCE_FACTOR = 2.8;
const ORBIT_ELEVATION_FACTOR = 0.9;
const MIN_ORBIT_RADIUS_LDU = 200;
const MODEL_ORIGIN = 0;

interface LoadedModel {
  readonly lod: BundleLod;
  readonly partIds: ReadonlyArray<string>;
  readonly ldrawColors: ReadonlyArray<number>;
  readonly instanceCount: number;
  readonly partIndex: Uint16Array;
  readonly ldrawColor: Uint16Array;
}

@injectable()
export class ModelScene implements IModelScene {
  private modelName = "";
  private centreX = 0;
  private centreY = 0;
  private centreZ = 0;
  private radius = MIN_ORBIT_RADIUS_LDU;
  private loaded: LoadedModel | null = null;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  selectModel(name: string): void {
    this.modelName = name;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const { bundle, entry, model } = await this.loader.loadModel(lod, this.modelName);
    const colors = new ColorTable(bundle);
    this.loaded = {
      lod,
      partIds: bundle.parts.map((part) => part.id),
      ldrawColors: bundle.colors.map((color) => color.code),
      instanceCount: model.instanceCount,
      partIndex: model.partIndex,
      ldrawColor: model.ldrawColor,
    };
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

  bomInput(scope: BomScope): BomInput {
    const loaded = this.loaded;
    if (!loaded) throw new Error("the model scene has not loaded a model");
    const counter = new BomCounter(loaded.partIds, loaded.ldrawColors);
    const region = sceneRegion(scope);
    const included =
      region === null ||
      (MODEL_ORIGIN >= region.minX &&
        MODEL_ORIGIN < region.maxX &&
        MODEL_ORIGIN >= region.minZ &&
        MODEL_ORIGIN < region.maxZ);
    if (included) {
      counter.addInstances(loaded.partIndex, loaded.ldrawColor, loaded.instanceCount, 1);
    }
    return { name: this.modelName, lod: loaded.lod, placements: included ? 1 : 0, counter };
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
