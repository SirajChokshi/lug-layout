import {
  ASSET_FETCHER,
  AssetResponseError,
  AssetStalledError,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
} from "@brr/catalog";
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

interface HeldRequest {
  readonly release: () => void;
  readonly fail: (error: Error) => void;
}

class HeldRecordFetcher implements IAssetFetcher {
  private readonly releases = new Map<string, HeldRequest>();
  private holding: ReadonlySet<string> = new Set();
  readonly served = new Set<string>();

  hold(paths: ReadonlyArray<string>): void {
    this.holding = new Set(paths);
  }

  get held(): number {
    return this.releases.size;
  }

  release(path: string): void {
    this.releases.get(path)?.release();
  }

  fail(path: string, error: Error): void {
    this.releases.get(path)?.fail(error);
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

  private async gate(path: string): Promise<void> {
    if (this.holding.has(path)) {
      await new Promise<void>((release, fail) => this.releases.set(path, { release, fail }));
    }
    this.served.add(path);
  }
}

async function catalogOverHeldRecords(ids: ReadonlyArray<string>) {
  const fetcher = new HeldRecordFetcher();
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  container.rebind(SCENE_BACKEND).toConstantValue(new RecordingBackend());
  const index = await container.get(PART_BUNDLE_LOADER).loadIndex(LOD);
  const records = ids.map((id) => {
    const entry = index.models.find((model) => `${model.origin}:${model.name}` === id);
    if (!entry) throw new Error(`${id} isn't in the bundle`);
    return `${LOD}/${entry.file}`;
  });
  const catalog = container.get(PLACEABLE_CATALOG);
  await catalog.start(index);
  return { fetcher, records, catalog };
}

async function paletteWhenReleased(order: ReadonlyArray<number>) {
  const { fetcher, records, catalog } = await catalogOverHeldRecords(SETS);
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

async function paletteAfterTheFirstRecordFails(failure: Error) {
  const ids = ["omr:10185-1", ...SETS];
  const { fetcher, records, catalog } = await catalogOverHeldRecords(ids);
  const [failing = "", ...later] = records;
  fetcher.hold([failing]);
  const first = loadCatalogItem(catalog, ids[0] ?? "");
  first.catch(() => undefined);
  let laterAdopted = false;
  const loading = Promise.all(SETS.map((id) => loadCatalogItem(catalog, id))).then((placeables) => {
    laterAdopted = true;
    return placeables;
  });
  await expect.poll(() => later.every((record) => fetcher.served.has(record))).toBe(true);
  await new Promise((settle) => setTimeout(settle));
  const adoptedWhileHeld = laterAdopted;
  fetcher.fail(failing, failure);
  const placeables = await loading;
  return {
    adoptedWhileHeld,
    firstFailure: await first.then(
      () => null,
      (error: unknown) => error,
    ),
    parts: catalog.parts().map((part) => part.id),
    partIndex: placeables.map((placeable) => [...placeable.parts.partIndex]),
  };
}

it("lets the models asked for after a stalled record adopt once the stall is reported, as after an HTTP error", async () => {
  const stall = new AssetStalledError("https://bucket.test/standard/model.json", 30_000);
  const stalled = await paletteAfterTheFirstRecordFails(stall);
  const refused = await paletteAfterTheFirstRecordFails(
    new AssetResponseError("https://bucket.test/standard/model.json", 503),
  );

  expect(stalled.adoptedWhileHeld).toBe(false);
  expect(stalled.firstFailure).toBe(stall);
  expect({ ...stalled, firstFailure: null }).toEqual({ ...refused, firstFailure: null });
}, 120_000);
