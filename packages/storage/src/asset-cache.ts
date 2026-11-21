import { inject, injectable } from "inversify";
import { openDatabase, requestResult, transactionDone, type StoreSpec } from "./indexed-db.ts";
import { ASSET_CACHE_BUDGET, INDEXED_DB } from "./tokens.ts";

const ASSET_CACHE_DATABASE = "brr-assets";
export const DEFAULT_ASSET_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const TOUCH_FLUSH_MS = 2000;
const BYTES_STORE = "bytes";
const ENTRY_STORE = "entries";
const LEDGER_STORE = "ledger";
const LEDGER_KEY = "ledger";
const USED_AT = "usedAt";
const STORES: ReadonlyArray<StoreSpec> = [
  { name: BYTES_STORE },
  { name: ENTRY_STORE, keyPath: "key", indexes: [USED_AT] },
  { name: LEDGER_STORE },
];

export interface IAssetCache {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

interface AssetEntry {
  readonly key: string;
  readonly bytes: number;
  readonly usedAt: number;
}

interface Ledger {
  readonly total: number;
  readonly clock: number;
}

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function assetEntry(value: unknown): AssetEntry | null {
  const fields = fieldsOf(value);
  const key = fields?.["key"];
  const bytes = fields?.["bytes"];
  const usedAt = fields?.["usedAt"];
  return typeof key === "string" && typeof bytes === "number" && typeof usedAt === "number"
    ? { key, bytes, usedAt }
    : null;
}

function ledgerOf(value: unknown): Ledger {
  const fields = fieldsOf(value);
  const total = fields?.["total"];
  const clock = fields?.["clock"];
  return {
    total: typeof total === "number" ? total : 0,
    clock: typeof clock === "number" ? clock : 0,
  };
}

function evictOldest(
  bytes: IDBObjectStore,
  entries: IDBObjectStore,
  total: number,
  budget: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let remaining = total;
    const request = entries.index(USED_AT).openCursor();
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve(0);
        return;
      }
      if (remaining <= budget) {
        resolve(remaining);
        return;
      }
      bytes.delete(cursor.primaryKey);
      cursor.delete();
      remaining -= assetEntry(cursor.value)?.bytes ?? 0;
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });
}

@injectable()
export class IndexedDbAssetCache implements IAssetCache {
  private connection: Promise<IDBDatabase | null> | undefined;
  private readonly touched = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    @inject(INDEXED_DB) private readonly factory: IDBFactory,
    @inject(ASSET_CACHE_BUDGET) private readonly budget: number,
  ) {}

  async get(key: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const db = await this.database();
    if (db === null) return undefined;
    const value = await this.read(db, key).catch(() => undefined);
    if (!(value instanceof ArrayBuffer)) return undefined;
    this.touch(key);
    return new Uint8Array(value);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > this.budget) return;
    const stored = bytes.slice().buffer;
    const db = await this.database();
    if (db === null) return;
    await this.store(db, key, stored).catch(() => undefined);
  }

  private async read(db: IDBDatabase, key: string): Promise<unknown> {
    return requestResult(db.transaction(BYTES_STORE).objectStore(BYTES_STORE).get(key));
  }

  private async store(db: IDBDatabase, key: string, stored: ArrayBuffer): Promise<void> {
    const transaction = db.transaction([BYTES_STORE, ENTRY_STORE, LEDGER_STORE], "readwrite");
    await Promise.all([this.write(transaction, key, stored), transactionDone(transaction)]);
  }

  private database(): Promise<IDBDatabase | null> {
    this.connection ??= this.connect().catch(() => null);
    return this.connection;
  }

  private async connect(): Promise<IDBDatabase> {
    const db = await openDatabase(this.factory, ASSET_CACHE_DATABASE, STORES);
    db.addEventListener("versionchange", () => {
      db.close();
      this.connection = Promise.resolve(null);
    });
    return db;
  }

  private async write(
    transaction: IDBTransaction,
    key: string,
    stored: ArrayBuffer,
  ): Promise<void> {
    const bytes = transaction.objectStore(BYTES_STORE);
    const entries = transaction.objectStore(ENTRY_STORE);
    const ledgers = transaction.objectStore(LEDGER_STORE);
    const [previous, ledger] = await Promise.all([
      requestResult(entries.get(key)),
      requestResult(ledgers.get(LEDGER_KEY)).then(ledgerOf),
    ]);
    const clock = (await this.stampTouched(entries, ledger.clock)) + 1;
    bytes.put(stored, key);
    entries.put({ key, bytes: stored.byteLength, usedAt: clock } satisfies AssetEntry);
    const total = ledger.total + stored.byteLength - (assetEntry(previous)?.bytes ?? 0);
    const kept =
      total > this.budget ? await evictOldest(bytes, entries, total, this.budget) : total;
    ledgers.put({ total: kept, clock } satisfies Ledger, LEDGER_KEY);
  }

  private touch(key: string): void {
    this.touched.delete(key);
    this.touched.add(key);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushTouches();
    }, TOUCH_FLUSH_MS);
  }

  private async flushTouches(): Promise<void> {
    const db = await this.database();
    if (db === null || this.touched.size === 0) return;
    await this.storeTouches(db).catch(() => undefined);
  }

  private async storeTouches(db: IDBDatabase): Promise<void> {
    const transaction = db.transaction([ENTRY_STORE, LEDGER_STORE], "readwrite");
    await Promise.all([this.writeTouches(transaction), transactionDone(transaction)]);
  }

  private async writeTouches(transaction: IDBTransaction): Promise<void> {
    const ledgers = transaction.objectStore(LEDGER_STORE);
    const ledger = ledgerOf(await requestResult(ledgers.get(LEDGER_KEY)));
    const clock = await this.stampTouched(transaction.objectStore(ENTRY_STORE), ledger.clock);
    ledgers.put({ total: ledger.total, clock } satisfies Ledger, LEDGER_KEY);
  }

  private async stampTouched(entries: IDBObjectStore, clock: number): Promise<number> {
    const keys = [...this.touched];
    this.touched.clear();
    const found = await Promise.all(keys.map((key) => requestResult(entries.get(key))));
    let stamped = clock;
    for (const value of found) {
      const entry = assetEntry(value);
      if (entry === null) continue;
      stamped += 1;
      entries.put({ ...entry, usedAt: stamped } satisfies AssetEntry);
    }
    return stamped;
  }
}
