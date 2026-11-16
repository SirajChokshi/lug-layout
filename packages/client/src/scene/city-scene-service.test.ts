import { ASSET_FETCHER, type IAssetFetcher } from "@brr/catalog";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { CITY_SCENE } from "../tokens.ts";

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
  readonly chunks = new Map<number, ChunkInstances>();
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
  }
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  async waitForGpu(): Promise<void> {}
}

async function loadCity(seed: number) {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
  const backend = new RecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const summary = await container
    .get(CITY_SCENE)
    .load({ lod: "standard", targetParts: 20_000, partsPerModule: 2_000, seed });
  return { summary, backend };
}

describe("CitySceneService resolved through the real modules", () => {
  it("places every real part on the stud lattice at whole plate heights with quarter turns", async () => {
    const { summary, backend } = await loadCity(7);
    expect(summary.modules).toBe(10);
    expect(Math.abs(summary.parts - 20_000)).toBeLessThan(summary.parts * 0.02);
    for (const chunk of backend.chunks.values()) {
      for (let i = 0; i < chunk.count; i++) {
        const m = chunk.matrices.subarray(i * 12, i * 12 + 12);
        expect(Number.isInteger(m[3]) && (m[3] ?? 0) % 10 === 0).toBe(true);
        expect(Number.isInteger(m[11]) && (m[11] ?? 0) % 10 === 0).toBe(true);
        expect((m[7] ?? 0) % 8).toBe(0);
        expect(
          [...m.subarray(0, 3), ...m.subarray(4, 7), ...m.subarray(8, 11)].every(
            (v) => v === 0 || Math.abs(v) === 1,
          ),
        ).toBe(true);
      }
    }
  });

  it("is reproducible for a seed", async () => {
    const [a, b] = await Promise.all([loadCity(7), loadCity(7)]);
    expect(a.summary).toEqual(b.summary);
  });
});
