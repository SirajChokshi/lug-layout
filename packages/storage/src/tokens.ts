import type { ServiceIdentifier } from "inversify";
import type { IWorldLocks } from "./world-locks.ts";
import type { IWorldRepository } from "./world-repository.ts";

export const INDEXED_DB: ServiceIdentifier<IDBFactory> = Symbol.for("brr.storage.IndexedDb");
export const WORLD_REPOSITORY: ServiceIdentifier<IWorldRepository> = Symbol.for(
  "brr.storage.WorldRepository",
);
export const WORLD_LOCKS: ServiceIdentifier<IWorldLocks> = Symbol.for("brr.storage.WorldLocks");
