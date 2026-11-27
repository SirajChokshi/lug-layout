import { ContainerModule } from "inversify";
import { bindAssetCache } from "./asset-cache.module.ts";
import { CloudWorldRepository } from "./cloud-world-repository.ts";
import { IndexedDbOwnedPartsRepository } from "./owned-parts-repository.ts";
import { isPersistentStorage } from "./persistent-storage.ts";
import {
  CLOUD_WORLDS,
  LAYOUT_API_BASE_URL,
  LOCAL_WORLD_REPOSITORY,
  OWNED_PARTS_REPOSITORY,
  PERSISTENT_STORAGE,
  WORLD_LOCKS,
  WORLD_REPOSITORY,
} from "./tokens.ts";
import { WebWorldLocks } from "./world-locks.ts";
import { IndexedDbWorldRepository } from "./world-repository.ts";

export const storageModule = new ContainerModule(({ bind }) => {
  bindAssetCache(bind);
  bind(PERSISTENT_STORAGE).toDynamicValue(() => {
    const storage: unknown = globalThis.navigator?.storage;
    return isPersistentStorage(storage) ? storage : null;
  });
  bind(LOCAL_WORLD_REPOSITORY).to(IndexedDbWorldRepository).inSingletonScope();
  bind(CLOUD_WORLDS).to(CloudWorldRepository).inSingletonScope();
  bind(WORLD_REPOSITORY)
    .toDynamicValue((context) =>
      context.get(LAYOUT_API_BASE_URL, { optional: true }) === undefined
        ? context.get(LOCAL_WORLD_REPOSITORY)
        : context.get(CLOUD_WORLDS),
    )
    .inSingletonScope();
  bind(WORLD_LOCKS).to(WebWorldLocks).inSingletonScope();
  bind(OWNED_PARTS_REPOSITORY).to(IndexedDbOwnedPartsRepository).inSingletonScope();
});
