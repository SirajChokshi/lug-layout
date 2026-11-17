import { injectable } from "inversify";

export interface StoredWorld {
  readonly files: ReadonlyMap<string, string>;
  readonly savedAt: number;
}

export interface WorldFile {
  readonly name: string;
  readonly text: string;
}

export interface WorldWrite {
  readonly put: ReadonlyArray<WorldFile>;
  readonly remove: ReadonlyArray<string>;
  readonly savedAt: number;
}

export interface IWorldStore {
  claim(world: string): Promise<boolean>;
  read(world: string): Promise<StoredWorld | null>;
  write(world: string, write: WorldWrite): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

const DATABASE = "brr-worlds";
const DATABASE_VERSION = 1;
const WORLDS = "worlds";
const FILES = "files";
const FILES_BY_WORLD = "by-world";
const LOCK_PREFIX = "brr.world.";

interface WorldRow {
  readonly id: string;
  readonly savedAt: number;
}

interface FileRow {
  readonly world: string;
  readonly name: string;
  readonly text: string;
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

function isWorldRow(value: unknown): value is WorldRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "savedAt" in value &&
    typeof value.savedAt === "number"
  );
}

function isFileRow(value: unknown): value is FileRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

@injectable()
export class IndexedDbWorldStore implements IWorldStore {
  private database: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory: IDBFactory | undefined = globalThis.indexedDB;
      if (!factory) throw new Error("this browser has no IndexedDB");
      const request = factory.open(DATABASE, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(WORLDS, { keyPath: "id" });
        request.result
          .createObjectStore(FILES, { keyPath: ["world", "name"] })
          .createIndex(FILES_BY_WORLD, "world");
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () =>
        reject(new Error("another tab holds an older world database open")),
      );
    }).catch((error: unknown) => {
      this.database = undefined;
      throw error;
    });
    return this.database;
  }

  claim(world: string): Promise<boolean> {
    const locks: LockManager | undefined = globalThis.navigator?.locks;
    if (!locks) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      locks
        .request(`${LOCK_PREFIX}${world}`, { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          return lock === null ? undefined : new Promise<void>(() => undefined);
        })
        .catch(reject);
    });
  }

  async read(world: string): Promise<StoredWorld | null> {
    const transaction = (await this.open()).transaction([WORLDS, FILES], "readonly");
    const row: unknown = await settle(transaction.objectStore(WORLDS).get(world));
    if (!isWorldRow(row)) return null;
    const rows: unknown[] = await settle(
      transaction.objectStore(FILES).index(FILES_BY_WORLD).getAll(world),
    );
    const files = new Map<string, string>();
    for (const file of rows) {
      if (isFileRow(file)) files.set(file.name, file.text);
    }
    return { files, savedAt: row.savedAt };
  }

  async write(world: string, write: WorldWrite): Promise<void> {
    const transaction = (await this.open()).transaction([WORLDS, FILES], "readwrite");
    const done = committed(transaction);
    const files = transaction.objectStore(FILES);
    for (const name of write.remove) files.delete([world, name]);
    for (const { name, text } of write.put) files.put({ world, name, text });
    transaction.objectStore(WORLDS).put({ id: world, savedAt: write.savedAt });
    await done;
  }

  async move(from: string, to: string): Promise<void> {
    const stored = await this.read(from);
    if (!stored) return;
    const transaction = (await this.open()).transaction([WORLDS, FILES], "readwrite");
    const done = committed(transaction);
    const files = transaction.objectStore(FILES);
    for (const [name, text] of stored.files) {
      files.put({ world: to, name, text });
      files.delete([from, name]);
    }
    const worlds = transaction.objectStore(WORLDS);
    worlds.put({ id: to, savedAt: stored.savedAt });
    worlds.delete(from);
    await done;
  }
}
