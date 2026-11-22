import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storageModule } from "./storage.module.ts";
import { ASSET_CACHE, ASSET_CACHE_BUDGET, INDEXED_DB } from "./tokens.ts";

const ASSET_BYTES = 10;

function session(factory: IDBFactory, budget?: number) {
  const container = new Container();
  container.load(storageModule);
  container.rebind(INDEXED_DB).toConstantValue(factory);
  if (budget !== undefined) container.rebind(ASSET_CACHE_BUDGET).toConstantValue(budget);
  return container.get(ASSET_CACHE);
}

function asset(fill: number, bytes = ASSET_BYTES): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

async function stored(cache: ReturnType<typeof session>, keys: ReadonlyArray<string>) {
  const found = await Promise.all(keys.map((key) => cache.get(key)));
  return keys.filter((_, i) => found[i] !== undefined);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("IndexedDB asset cache", () => {
  it("keeps its own copy of the bytes across sessions", async () => {
    const factory = new IDBFactory();
    const given = asset(7);
    const writing = session(factory).put("standard/3001.0123456789abcdef.glb", given);
    given.fill(0);
    await writing;
    const bytes = await session(factory).get("standard/3001.0123456789abcdef.glb");
    expect(bytes && [...bytes]).toEqual(Array(ASSET_BYTES).fill(7));
    expect(await session(factory).get("standard/3002.0123456789abcdef.glb")).toBeUndefined();
  });

  it("evicts the least recently used assets once the total passes the budget", async () => {
    const cache = session(new IDBFactory(), 3 * ASSET_BYTES);
    await cache.put("a", asset(1));
    await cache.put("b", asset(2));
    await cache.put("c", asset(3));
    await cache.get("a");
    await cache.put("d", asset(4));
    expect(await stored(cache, ["a", "b", "c", "d"])).toEqual(["a", "c", "d"]);
  });

  it("counts a replaced asset at its new size only", async () => {
    const cache = session(new IDBFactory(), 3 * ASSET_BYTES);
    await cache.put("a", asset(1));
    await cache.put("b", asset(2));
    await cache.put("c", asset(3));
    await cache.put("a", asset(4));
    expect(await stored(cache, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("orders eviction by reads an earlier session made", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const factory = new IDBFactory();
    const first = session(factory, 3 * ASSET_BYTES);
    await first.put("a", asset(1));
    await first.put("b", asset(2));
    await first.put("c", asset(3));
    await first.get("a");
    await vi.runOnlyPendingTimersAsync();
    const second = session(factory, 3 * ASSET_BYTES);
    await second.put("d", asset(4));
    expect(await stored(second, ["a", "b", "c", "d"])).toEqual(["a", "c", "d"]);
  });

  it("stores nothing larger than the whole budget and evicts nothing for it", async () => {
    const cache = session(new IDBFactory(), 3 * ASSET_BYTES);
    await cache.put("a", asset(1));
    await cache.put("huge", asset(2, 3 * ASSET_BYTES + 1));
    expect(await stored(cache, ["a", "huge"])).toEqual(["a"]);
  });
});
