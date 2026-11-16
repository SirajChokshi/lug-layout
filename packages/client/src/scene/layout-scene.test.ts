import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import { CHUNK_LDU } from "@brr/math";
import {
  INSTANCE_MATRIX_FLOATS,
  SCENE_BACKEND,
  type BufferMemory,
  type ChunkInstances,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { LAYOUT_SCENE } from "../tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const TILE_SIDE_LDU = 4 * CHUNK_LDU;

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
  readonly chunks = new Map<number, ChunkInstances>();
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
  }
  setSuperChunk(): void {}
  setSuperChunkVisible(): void {}
  deleteSuperChunk(): void {}
  studPitchPx(): number {
    return 0;
  }
  forceTier(): void {}
  setFarModel(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setPlanOverlays(): void {}
  setIssueBoxes(): void {}
  rayThrough(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
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

it.each([1, 2])(
  "builds %i tiles per side of the 4×4 bench layout, buildable and with every part inside them",
  async (tiles) => {
    const container = new Container();
    container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
    const backend = new RecordingBackend();
    container.rebind(SCENE_BACKEND).toConstantValue(backend);
    container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
    const scene = container.get(LAYOUT_SCENE);
    scene.configure({ camera: "aerial", tiles });

    const summary = await scene.load("standard");
    const side = tiles * TILE_SIDE_LDU;

    expect(summary.modules).toBe(backend.chunks.size);
    let outside = 0;
    for (const chunk of backend.chunks.values()) {
      for (let i = 0; i < chunk.count; i++) {
        const x = chunk.originX + (chunk.matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0);
        const z = chunk.originZ + (chunk.matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0);
        if (x < 0 || z < 0 || x > side || z > side) outside++;
      }
    }
    expect(outside).toBe(0);
  },
);
