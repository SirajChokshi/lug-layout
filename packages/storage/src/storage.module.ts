import { ContainerModule } from "inversify";
import { bindAssetCache } from "./asset-cache.module.ts";
import { isPersistentStorage } from "./persistent-storage.ts";
import { PERSISTENT_STORAGE, WORLD_LOCKS, WORLD_REPOSITORY } from "./tokens.ts";
import { WebWorldLocks } from "./world-locks.ts";
import { IndexedDbWorldRepository } from "./world-repository.ts";

export const storageModule = new ContainerModule(({ bind }) => {
  bindAssetCache(bind);
  bind(PERSISTENT_STORAGE).toDynamicValue(() => {
    const storage: unknown = globalThis.navigator?.storage;
    return isPersistentStorage(storage) ? storage : null;
  });
  bind(WORLD_REPOSITORY).to(IndexedDbWorldRepository).inSingletonScope();
  bind(WORLD_LOCKS).to(WebWorldLocks).inSingletonScope();
});
