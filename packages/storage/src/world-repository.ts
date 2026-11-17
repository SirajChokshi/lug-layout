import { decode, decodedOrThrow, type Decoded, type Issue } from "@brr/schema/decode";
import {
  WorldHeader,
  WorldIndexEntry,
  WorldManifestV1,
  WorldShardV1,
  canonicalJson,
  compareSuperChunks,
  parseJsonText,
  readWorldArchive,
  shardEntry,
  shardName,
  worldArchiveFiles,
  worldManifest,
  type ShardEntryV1,
  type SuperChunk,
  type WorldArchive,
} from "@brr/schema/world";
import { inject, injectable } from "inversify";
import { deleteDatabase, openDatabase, requestResult, transactionDone } from "./indexed-db.ts";
import { INDEXED_DB } from "./tokens.ts";
import { readZip, writeStoredZip } from "./zip.ts";

export const WORLD_INDEX_DATABASE = "brr-worlds";
export const WORLD_DATABASE_PREFIX = "brr-world-";
const WORLD_INDEX_STORE = "worlds";
const MANIFEST_STORE = "manifest";
const SHARD_STORE = "shards";
const MANIFEST_KEY = "manifest";

export interface ShardFile {
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly bytes: number;
}

export interface StoredWorld {
  readonly id: string;
  readonly manifest: WorldManifestV1;
  readonly shards: ReadonlyArray<WorldShardV1>;
}

export interface WorldChange {
  readonly header: WorldHeader;
  readonly put: ReadonlyArray<WorldShardV1>;
  readonly drop: ReadonlyArray<SuperChunk>;
}

export interface IWorldRepository {
  list(): Promise<ReadonlyArray<WorldIndexEntry>>;
  create(header: WorldHeader, shards: ReadonlyArray<WorldShardV1>): Promise<WorldIndexEntry>;
  read(id: string): Promise<Decoded<StoredWorld>>;
  save(id: string, change: WorldChange): Promise<WorldIndexEntry>;
  remove(id: string): Promise<void>;
  shardFiles(id: string): Promise<ReadonlyArray<ShardFile>>;
  packArchive(archive: WorldArchive): Uint8Array;
  readArchive(bytes: Uint8Array): Promise<Decoded<WorldArchive>>;
}

export function worldDatabaseName(id: string): string {
  return `${WORLD_DATABASE_PREFIX}${id}`;
}

const utf8 = new TextEncoder();

function storedEntries(text: unknown): ReadonlyArray<ShardEntryV1> {
  if (typeof text !== "string") return [];
  const json = parseJsonText(text, "manifest");
  const manifest = json.ok ? decode(WorldManifestV1, json.value, "manifest") : json;
  return decodedOrThrow(manifest, "the stored manifest is invalid").shards;
}

const NOT_SAVED = "the world wasn't saved";

function indexEntries(values: ReadonlyArray<unknown>): WorldIndexEntry[] {
  return values.flatMap((value) => {
    const entry = decode(WorldIndexEntry, value);
    return entry.ok ? [entry.value] : [];
  });
}

@injectable()
export class IndexedDbWorldRepository implements IWorldRepository {
  constructor(@inject(INDEXED_DB) private readonly factory: IDBFactory) {}

  private openIndex(): Promise<IDBDatabase> {
    return openDatabase(this.factory, WORLD_INDEX_DATABASE, [
      { name: WORLD_INDEX_STORE, keyPath: "id" },
    ]);
  }

  private openWorld(id: string): Promise<IDBDatabase> {
    return openDatabase(this.factory, worldDatabaseName(id), [
      { name: MANIFEST_STORE },
      { name: SHARD_STORE },
    ]);
  }

  private async withIndex<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await this.openIndex();
    try {
      return await use(db);
    } finally {
      db.close();
    }
  }

  private async withWorld<T>(id: string, use: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await this.openWorld(id);
    try {
      return await use(db);
    } finally {
      db.close();
    }
  }

  async list(): Promise<ReadonlyArray<WorldIndexEntry>> {
    const values = await this.withIndex((db) =>
      requestResult(db.transaction(WORLD_INDEX_STORE).objectStore(WORLD_INDEX_STORE).getAll()),
    );
    return indexEntries(values).toSorted((a, b) => b.savedAt - a.savedAt);
  }

  private async writeSummary(id: string, manifest: WorldManifestV1): Promise<WorldIndexEntry> {
    const summary: WorldIndexEntry = {
      id,
      name: manifest.name,
      placements: manifest.placements,
      track: manifest.track,
      shards: manifest.shards.length,
      savedAt: Date.now(),
    };
    await this.withIndex(async (db) => {
      const transaction = db.transaction(WORLD_INDEX_STORE, "readwrite");
      transaction.objectStore(WORLD_INDEX_STORE).put(summary);
      await transactionDone(transaction);
    });
    return summary;
  }

  create(header: WorldHeader, shards: ReadonlyArray<WorldShardV1>): Promise<WorldIndexEntry> {
    return this.save(crypto.randomUUID(), { header, put: shards, drop: [] });
  }

  async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    decodedOrThrow(decode(WorldHeader, change.header, "world header"), NOT_SAVED);
    for (const shard of change.put) {
      decodedOrThrow(
        decode(WorldShardV1, shard, `shard ${shardName(shard.superChunk)}`),
        NOT_SAVED,
      );
    }
    const manifest = await this.withWorld(id, async (db) => {
      const transaction = db.transaction([MANIFEST_STORE, SHARD_STORE], "readwrite");
      const done = transactionDone(transaction);
      const manifests = transaction.objectStore(MANIFEST_STORE);
      const entries = new Map(
        storedEntries(await requestResult(manifests.get(MANIFEST_KEY))).map((entry) => [
          shardName(entry.superChunk),
          entry,
        ]),
      );
      for (const superChunk of change.drop) entries.delete(shardName(superChunk));
      for (const shard of change.put) entries.set(shardName(shard.superChunk), shardEntry(shard));
      const next = decodedOrThrow(
        decode(WorldManifestV1, worldManifest(change.header, [...entries.values()]), "manifest"),
        NOT_SAVED,
      );
      const shards = transaction.objectStore(SHARD_STORE);
      for (const superChunk of change.drop) shards.delete(shardName(superChunk));
      for (const shard of change.put) shards.put(canonicalJson(shard), shardName(shard.superChunk));
      manifests.put(canonicalJson(next), MANIFEST_KEY);
      await done;
      return next;
    });
    return this.writeSummary(id, manifest);
  }

  private async readTexts(
    id: string,
  ): Promise<{ manifest: unknown; shards: ReadonlyMap<string, unknown> }> {
    return this.withWorld(id, async (db) => {
      const transaction = db.transaction([MANIFEST_STORE, SHARD_STORE]);
      const manifest = requestResult(transaction.objectStore(MANIFEST_STORE).get(MANIFEST_KEY));
      const store = transaction.objectStore(SHARD_STORE);
      const [keys, values] = await Promise.all([
        requestResult(store.getAllKeys()),
        requestResult(store.getAll()),
      ]);
      const shards = new Map<string, unknown>();
      keys.forEach((key, i) => shards.set(String(key), values[i]));
      return { manifest: await manifest, shards };
    });
  }

  private async listed(id: string): Promise<boolean> {
    const entry = await this.withIndex((db) =>
      requestResult(db.transaction(WORLD_INDEX_STORE).objectStore(WORLD_INDEX_STORE).get(id)),
    );
    return entry !== undefined;
  }

  async read(id: string): Promise<Decoded<StoredWorld>> {
    if (!(await this.listed(id))) {
      return {
        ok: false,
        issues: [{ path: "world list", message: "no longer has this world" }],
      };
    }
    const texts = await this.readTexts(id);
    if (typeof texts.manifest !== "string") {
      return { ok: false, issues: [{ path: `world ${id}`, message: "has no manifest" }] };
    }
    const manifestJson = parseJsonText(texts.manifest, "manifest");
    const manifest = manifestJson.ok
      ? decode(WorldManifestV1, manifestJson.value, "manifest")
      : manifestJson;
    if (!manifest.ok) return manifest;
    const issues: Issue[] = [];
    const shards: WorldShardV1[] = [];
    for (const entry of manifest.value.shards) {
      const name = shardName(entry.superChunk);
      const text = texts.shards.get(name);
      if (typeof text !== "string") {
        issues.push({ path: `shard ${name}`, message: "is in the manifest but not stored" });
        continue;
      }
      const json = parseJsonText(text, `shard ${name}`);
      const shard = json.ok ? decode(WorldShardV1, json.value, `shard ${name}`) : json;
      if (shard.ok) shards.push(shard.value);
      else issues.push(...shard.issues);
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { id, manifest: manifest.value, shards } };
  }

  async remove(id: string): Promise<void> {
    await deleteDatabase(this.factory, worldDatabaseName(id));
    await this.withIndex(async (db) => {
      const transaction = db.transaction(WORLD_INDEX_STORE, "readwrite");
      transaction.objectStore(WORLD_INDEX_STORE).delete(id);
      await transactionDone(transaction);
    });
  }

  async shardFiles(id: string): Promise<ReadonlyArray<ShardFile>> {
    const stored = await this.read(id);
    if (!stored.ok) return [];
    return stored.value.shards
      .toSorted((a, b) => compareSuperChunks(a.superChunk, b.superChunk))
      .map((shard) => ({
        name: shardName(shard.superChunk),
        placements: shard.placements.length,
        track: shard.track.length,
        bytes: utf8.encode(canonicalJson(shard)).length,
      }));
  }

  packArchive(archive: WorldArchive): Uint8Array {
    return writeStoredZip(
      worldArchiveFiles(archive).map((file) => ({
        name: file.name,
        bytes: utf8.encode(file.text),
      })),
    );
  }

  async readArchive(bytes: Uint8Array): Promise<Decoded<WorldArchive>> {
    const zip = await readZip(bytes);
    if (!zip.ok) return zip;
    const texts = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const [name, data] of zip.value) {
      try {
        texts.set(name, decoder.decode(data));
      } catch {
        return { ok: false, issues: [{ path: name, message: "is not UTF-8 text" }] };
      }
    }
    return readWorldArchive(texts);
  }
}
