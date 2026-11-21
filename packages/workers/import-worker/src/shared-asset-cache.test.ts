import { LibraryBakeStore, type FetchFunction } from "@brr/import";
import type { RpcPort } from "@brr/rpc";
import { ASSET_CACHE, ASSET_CACHE_BUDGET, INDEXED_DB, storageModule } from "@brr/storage";
import { IDBFactory } from "fake-indexeddb";
import { Container, type ContainerModule } from "inversify";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { importWorkerModules } from "./import-worker.module.ts";

const RECORDS_URL = "https://records.test/library-bake";
const PIN = { file: "library-bake.json", sha256: "0".repeat(64) };
const ASSET_BYTES = 16;
const BUDGET = 4 * ASSET_BYTES;
const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };

interface Asset {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

function asset(stem: string, fill: number): Asset {
  const bytes = new Uint8Array(ASSET_BYTES).fill(fill);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { name: `${stem}.${digest}.bin`, bytes };
}

function cacheOf(modules: ReadonlyArray<ContainerModule>, indexedDb: IDBFactory) {
  const container = new Container();
  container.load(...modules);
  container.rebind(INDEXED_DB).toConstantValue(indexedDb);
  container.rebind(ASSET_CACHE_BUDGET).toConstantValue(BUDGET);
  return container.get(ASSET_CACHE);
}

function served(assets: ReadonlyArray<Asset>): FetchFunction {
  const byUrl = new Map(assets.map((record) => [`${RECORDS_URL}/${record.name}`, record.bytes]));
  return async (url) => {
    const bytes = byUrl.get(url);
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes);
  };
}

const offline: FetchFunction = async () => {
  throw new TypeError("Failed to fetch");
};

it("keeps the worker's library-bake records and the main thread's bundle files under one budget, evicting the least recently used across both", async () => {
  const indexedDb = new IDBFactory();
  const mainThread = cacheOf([storageModule], indexedDb);
  const workerCache = cacheOf(importWorkerModules(idlePort), indexedDb);
  const records = [1, 2, 3, 4].map((fill) => asset(`record-${fill}`, fill));
  const files = [5, 6, 7, 8].map((fill) => asset(`standard/part-${fill}`, fill));
  const worker = new LibraryBakeStore(RECORDS_URL, PIN, served(records), workerCache);
  const stored = async () => {
    const reader = cacheOf([storageModule], indexedDb);
    const all = [...records, ...files];
    const found = await Promise.all(all.map((entry) => reader.get(entry.name)));
    return all.filter((_, i) => found[i] !== undefined).map((entry) => entry.name);
  };

  await Promise.all([
    ...records.slice(0, 3).map((record) => worker.bytes(record.name)),
    ...files.slice(0, 3).map((file) => mainThread.put(file.name, file.bytes)),
  ]);
  const afterConcurrentWrites = await stored();
  expect(afterConcurrentWrites).toHaveLength(BUDGET / ASSET_BYTES);

  const readAgain = files
    .map((file) => file.name)
    .find((name) => afterConcurrentWrites.includes(name));
  if (readAgain === undefined) throw new Error("no bundle file survived the concurrent writes");
  expect(await mainThread.get(readAgain)).toBeDefined();
  const [newFile, newRecord] = [files[3], records[3]];
  if (newFile === undefined || newRecord === undefined) throw new Error("fixture too short");
  await mainThread.put(newFile.name, newFile.bytes);
  expect(await worker.bytes(newRecord.name)).toEqual(newRecord.bytes);
  const afterReads = await stored();
  expect(afterReads).toHaveLength(BUDGET / ASSET_BYTES);
  expect(afterReads).toEqual(expect.arrayContaining([readAgain, newFile.name, newRecord.name]));

  const laterWorkerCache = cacheOf(importWorkerModules(idlePort), indexedDb);
  const offlineWorker = new LibraryBakeStore(RECORDS_URL, PIN, offline, laterWorkerCache);
  expect(await offlineWorker.bytes(newRecord.name)).toEqual(newRecord.bytes);
  expect(offlineWorker.stats()).toEqual({ fetched: 0, cached: 1, bytes: 0 });
});
