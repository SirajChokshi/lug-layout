import { injectable } from "inversify";
import { parseRunningGearOverride, type RunningGearOverride } from "./override.ts";

export interface IRunningGearOverrideStore {
  load(modelSha256: string): Promise<RunningGearOverride | null>;
  save(override: RunningGearOverride): Promise<void>;
  remove(modelSha256: string): Promise<void>;
  all(): Promise<ReadonlyArray<RunningGearOverride>>;
}

const DATABASE = "brr-running-gear";
const DATABASE_VERSION = 1;
const OVERRIDES = "overrides";
const KEY_PATH = "modelSha256";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

@injectable()
export class IndexedDbRunningGearOverrideStore implements IRunningGearOverrideStore {
  private database: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory: IDBFactory | undefined = globalThis.indexedDB;
      if (!factory) throw new Error("this browser has no IndexedDB");
      const request = factory.open(DATABASE, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(OVERRIDES, { keyPath: KEY_PATH });
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () =>
        reject(new Error("another tab holds an older running gear database open")),
      );
    }).catch((error: unknown) => {
      this.database = undefined;
      throw error;
    });
    return this.database;
  }

  private async objects(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const database = await this.open();
    return database.transaction(OVERRIDES, mode).objectStore(OVERRIDES);
  }

  async load(modelSha256: string): Promise<RunningGearOverride | null> {
    const stored: unknown = await settle((await this.objects("readonly")).get(modelSha256));
    return stored === undefined ? null : parseRunningGearOverride(stored);
  }

  async save(override: RunningGearOverride): Promise<void> {
    await settle((await this.objects("readwrite")).put(structuredClone(override)));
  }

  async remove(modelSha256: string): Promise<void> {
    await settle((await this.objects("readwrite")).delete(modelSha256));
  }

  async all(): Promise<ReadonlyArray<RunningGearOverride>> {
    const stored: unknown[] = await settle((await this.objects("readonly")).getAll());
    return stored.flatMap((value) => {
      const parsed = parseRunningGearOverride(value);
      return parsed ? [parsed] : [];
    });
  }
}
