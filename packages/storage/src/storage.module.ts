import { ContainerModule } from "inversify";
import { INDEXED_DB, WORLD_LOCKS, WORLD_REPOSITORY } from "./tokens.ts";
import { WebWorldLocks } from "./world-locks.ts";
import { IndexedDbWorldRepository } from "./world-repository.ts";

export const storageModule = new ContainerModule(({ bind }) => {
  bind(INDEXED_DB).toDynamicValue(() => globalThis.indexedDB);
  bind(WORLD_REPOSITORY).to(IndexedDbWorldRepository).inSingletonScope();
  bind(WORLD_LOCKS).to(WebWorldLocks).inSingletonScope();
});
