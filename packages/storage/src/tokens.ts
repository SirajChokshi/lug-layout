import type { ServiceIdentifier } from "inversify";
import type { IAssetCache } from "./asset-cache.ts";
import type { PersistentStorage } from "./persistent-storage.ts";
import type { IWorldLocks } from "./world-locks.ts";
import type { IWorldRepository } from "./world-repository.ts";

export const INDEXED_DB: ServiceIdentifier<IDBFactory> = Symbol.for("brr.storage.IndexedDb");
export const PERSISTENT_STORAGE: ServiceIdentifier<PersistentStorage | null> = Symbol.for(
  "brr.storage.PersistentStorage",
);
export const WORLD_REPOSITORY: ServiceIdentifier<IWorldRepository> = Symbol.for(
  "brr.storage.WorldRepository",
);
export const WORLD_LOCKS: ServiceIdentifier<IWorldLocks> = Symbol.for("brr.storage.WorldLocks");
export const ASSET_CACHE_BUDGET: ServiceIdentifier<number> = Symbol.for(
  "brr.storage.AssetCacheBudget",
);
export const ASSET_CACHE: ServiceIdentifier<IAssetCache> = Symbol.for("brr.storage.AssetCache");
