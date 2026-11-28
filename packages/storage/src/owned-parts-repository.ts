import { decode, type Decoded } from "@brr/schema/decode";
import { OwnedPartsFile } from "@brr/schema/owned-parts";
import { inject, injectable } from "inversify";
import { inStore } from "./indexed-db.ts";
import type { PersistentStorage } from "./persistent-storage.ts";
import { INDEXED_DB, PERSISTENT_STORAGE } from "./tokens.ts";

const OWNED_PARTS_DATABASE = "brr-owned-parts";
const OWNED_PARTS_STORE = { name: "files" };
const OWNED_PARTS_KEY = "owned";

export interface IOwnedPartsRepository {
  read(): Promise<Decoded<OwnedPartsFile | null>>;
  write(file: OwnedPartsFile): Promise<void>;
  clear(): Promise<void>;
}

@injectable()
export class IndexedDbOwnedPartsRepository implements IOwnedPartsRepository {
  private persistenceRequested = false;

  constructor(
    @inject(INDEXED_DB) private readonly factory: IDBFactory,
    @inject(PERSISTENT_STORAGE) private readonly storage: PersistentStorage | null,
  ) {}

  private inStore<T>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return inStore(this.factory, OWNED_PARTS_DATABASE, OWNED_PARTS_STORE, mode, use);
  }

  async read(): Promise<Decoded<OwnedPartsFile | null>> {
    const stored: unknown = await this.inStore("readonly", (store) => store.get(OWNED_PARTS_KEY));
    if (stored === undefined) return { ok: true, value: null };
    return decode(OwnedPartsFile, stored, "saved owned parts");
  }

  async write(file: OwnedPartsFile): Promise<void> {
    await this.inStore("readwrite", (store) => store.put(file, OWNED_PARTS_KEY));
    if (this.persistenceRequested || this.storage === null) return;
    this.persistenceRequested = true;
    this.storage.persist().catch(() => false);
  }

  async clear(): Promise<void> {
    await this.inStore("readwrite", (store) => store.delete(OWNED_PARTS_KEY));
  }
}
