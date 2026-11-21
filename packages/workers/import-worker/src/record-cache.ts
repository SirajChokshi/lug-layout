import type { IByteCache } from "@brr/import";

export const LIBRARY_BAKE_DATABASE = "brr-library-bake";
export const LIBRARY_CONNECTORS_DATABASE = "brr-library-connectors";
const STORE = "files";
const VERSION = 1;

function opened(database: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(database, VERSION);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(null));
    request.addEventListener("blocked", () => resolve(null));
  });
}

function settled<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(undefined));
  });
}

export class IndexedDbByteCache implements IByteCache {
  private readonly database: Promise<IDBDatabase | null>;

  constructor(database: string) {
    this.database = opened(database);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const database = await this.database;
    if (database === null) return undefined;
    const value = await settled(
      database.transaction(STORE, "readonly").objectStore(STORE).get(key),
    );
    return value instanceof Uint8Array ? value : undefined;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const database = await this.database;
    if (database === null) return;
    await settled(database.transaction(STORE, "readwrite").objectStore(STORE).put(bytes, key));
  }
}
