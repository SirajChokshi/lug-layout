import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import {
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
import { PART_DISPLAY_SCENE } from "../tokens.ts";
import { PALETTE_PARTS } from "./viewer-scene.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

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
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  setChunk(_key: number, chunk: ChunkInstances): void {
    this.chunks.push(chunk);
  }
  deleteChunk(): void {}
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
  deleteVehicle(): void {}
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
  forceTier(): void {}
  setFarModel(): void {}
}

it("shows every palette part on the integer lattice when resolved through the real modules", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const backend = new RecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());

  await container.get(PART_DISPLAY_SCENE).load("standard");
  const bundle = await container.get(PART_BUNDLE_LOADER).load("standard", PALETTE_PARTS);

  const shown = new Set(
    backend.chunks.flatMap((chunk) => [...chunk.partIndex.subarray(0, chunk.count)]),
  );
  const hidden = bundle.parts.filter((_part, index) => !shown.has(index));
  expect(hidden.map((part) => part.id)).toEqual([]);
  for (const chunk of backend.chunks) {
    for (let i = 0; i < chunk.count; i++) {
      expect(Number.isInteger(chunk.matrices[i * 12 + 3])).toBe(true);
      expect(Number.isInteger(chunk.matrices[i * 12 + 11])).toBe(true);
      expect((chunk.matrices[i * 12 + 7] ?? 0) % 8).toBe(0);
    }
  }
});
