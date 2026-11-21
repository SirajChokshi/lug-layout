import { ContainerModule, type Bind } from "inversify";
import { DEFAULT_ASSET_CACHE_BUDGET_BYTES, IndexedDbAssetCache } from "./asset-cache.ts";
import { ASSET_CACHE, ASSET_CACHE_BUDGET, INDEXED_DB } from "./tokens.ts";

export function bindAssetCache(bind: Bind): void {
  bind(INDEXED_DB).toDynamicValue(() => globalThis.indexedDB);
  bind(ASSET_CACHE_BUDGET).toConstantValue(DEFAULT_ASSET_CACHE_BUDGET_BYTES);
  bind(ASSET_CACHE).to(IndexedDbAssetCache).inSingletonScope();
}

export const assetCacheModule = new ContainerModule(({ bind }) => bindAssetCache(bind));
