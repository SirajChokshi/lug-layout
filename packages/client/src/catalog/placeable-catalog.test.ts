import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { SCENE_BACKEND } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { RecordingBackend } from "../plan/plan-sync.test-support.ts";
import { PLACEABLE_CATALOG } from "../tokens.ts";
import { loadCatalogItem } from "./catalog-item.test-support.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const LOD = "standard";
const SETS = ["omr:7936-1", "omr:2150-1"];

class HeldRecordFetcher implements IAssetFetcher {
  private readonly releases = new Map<string, () => void>();
  private holding: ReadonlySet<string> = new Set();

  hold(paths: ReadonlyArray<string>): void {
    this.holding = new Set(paths);
  }

  get held(): number {
    return this.releases.size;
  }

  release(path: string): void {
    this.releases.get(path)?.();
  }

  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    await this.gate(path);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    const text = await readFile(new URL(path, bundleRoot), "utf8");
    await this.gate(path);
    return text;
  }

  private gate(path: string): Promise<void> {
    if (!this.holding.has(path)) return Promise.resolve();
    return new Promise((resolve) => this.releases.set(path, resolve));
  }
}

async function paletteWhenReleased(order: ReadonlyArray<number>) {
  const fetcher = new HeldRecordFetcher();
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  container.rebind(SCENE_BACKEND).toConstantValue(new RecordingBackend());
  const index = await container.get(PART_BUNDLE_LOADER).loadIndex(LOD);
  const records = SETS.map((id) => {
    const entry = index.models.find((model) => `${model.origin}:${model.name}` === id);
    if (!entry) throw new Error(`${id} isn't in the bundle`);
    return `${LOD}/${entry.file}`;
  });
  const catalog = container.get(PLACEABLE_CATALOG);
  await catalog.start(index);
  fetcher.hold(records);
  const loading = Promise.all(SETS.map((id) => loadCatalogItem(catalog, id)));
  await expect.poll(() => fetcher.held).toBe(records.length);
  for (const at of order) fetcher.release(records[at] ?? "");
  const placeables = await loading;
  return {
    parts: catalog.parts().map((part) => part.id),
    partIndex: placeables.map((placeable) => [...placeable.parts.partIndex]),
  };
}

it("merges two models' parts into the palette in the order they were asked for, whatever order their records arrive in", async () => {
  const inOrder = await paletteWhenReleased([0, 1]);
  const reversed = await paletteWhenReleased([1, 0]);

  expect(reversed).toEqual(inOrder);
}, 120_000);
