import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type FarModelPlacement,
  type ISceneBackend,
  type LookSettings,
  type PartPalette,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { MODEL_SCENE } from "../tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

const NO_LOOK: LookSettings = {
  plastic: false,
  gtao: false,
  outlines: false,
  bevel: false,
  shadows: false,
  oit: false,
};

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

class RecordingBackend implements ISceneBackend {
  readonly chunks: ChunkInstances[] = [];
  readonly farModels: Array<FarModelPlacement | null> = [];
  palette: PartPalette | null = null;

  async init(): Promise<BackendInfo> {
    return {
      requestedApi: "webgl2",
      activeApi: "webgl2",
      adapter: "none",
      backgroundSrgb: 0,
      look: NO_LOOK,
    };
  }
  setPalette(palette: PartPalette): void {
    this.palette = palette;
  }
  setChunk(_key: number, instances: ChunkInstances): void {
    this.chunks.push(instances);
  }
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(): void {}
  rayThrough(): void {}
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
  setTrackEnds(): void {}
  forceTier(): void {}
  setFarModel(_id: number, placement: FarModelPlacement | null): void {
    this.farModels.push(placement);
  }
}

function voxelizedCount(chunks: ReadonlyArray<ChunkInstances>): number {
  return chunks.reduce(
    (sum, chunk) => sum + (chunk.voxelized?.reduce((n, flag) => n + flag, 0) ?? 0),
    0,
  );
}

function instanceCount(chunks: ReadonlyArray<ChunkInstances>): number {
  return chunks.reduce((sum, chunk) => sum + chunk.count, 0);
}

it.each([
  { model: "10016-1", hasFarMesh: false },
  { model: "7936-1", hasFarMesh: true },
])(
  "loads $model in the model viewer, with a voxel far tier only when the bake made one",
  async ({ model, hasFarMesh }) => {
    const container = new Container();
    container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
    container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
    const backend = new RecordingBackend();
    container.rebind(SCENE_BACKEND).toConstantValue(backend);
    const scene = container.get(MODEL_SCENE);
    scene.selectModel(model, "orbit");

    const summary = await scene.load("standard");

    expect(instanceCount(backend.chunks)).toBeGreaterThan(0);
    expect(summary.farModel !== null).toBe(hasFarMesh);
    expect((backend.palette?.farModels?.length ?? 0) > 0).toBe(hasFarMesh);
    expect(backend.farModels.length > 0).toBe(hasFarMesh);
    expect(voxelizedCount(backend.chunks)).toBe(hasFarMesh ? instanceCount(backend.chunks) : 0);
  },
  120_000,
);
