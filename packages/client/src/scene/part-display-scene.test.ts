import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { PART_DISPLAY_SCENE } from "../tokens.ts";

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
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  async waitForGpu(): Promise<void> {}
}

it("shows every compiled bundle part on the integer lattice when resolved through the real modules", async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  const backend = new RecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());

  const summary = await container.get(PART_DISPLAY_SCENE).load("standard");

  expect(summary.usage.filter((u) => u.instances === 0)).toEqual([]);
  for (const chunk of backend.chunks) {
    for (let i = 0; i < chunk.count; i++) {
      expect(Number.isInteger(chunk.matrices[i * 12 + 3])).toBe(true);
      expect(Number.isInteger(chunk.matrices[i * 12 + 11])).toBe(true);
      expect((chunk.matrices[i * 12 + 7] ?? 0) % 8).toBe(0);
    }
  }
});
