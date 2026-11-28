import { decode, decodedOrThrow, type Decoded, type Issue } from "@brr/schema/decode";
import { planArchiveFiles, readPlanFiles, type PlanArchive } from "@brr/schema/plan";
import {
  IMPORT_DIRECTORY,
  KitIndexEntry,
  NoteShardV2,
  WorldDocumentIndex,
  WorldHeader,
  WorldIndexEntry,
  WorldShardV2,
  canonicalJson,
  compareSuperChunks,
  decodeWorldManifest,
  decodeWorldShard,
  importPath,
  noteShardEntry,
  noteShardReferenceIssues,
  parseImportPath,
  parseJsonText,
  readWorldArchive,
  readWorldFiles,
  referencedImports,
  shardEntry,
  shardName,
  shardReferenceIssues,
  worldArchiveFiles,
  worldManifest,
  type ConsistRecordV1,
  type ImportedFile,
  type NoteShardEntryV2,
  type PlacedRefs,
  type ShardEntryV1,
  type SuperChunk,
  type WorldArchive,
  type WorldFiles,
  type WorldManifestV2,
} from "@brr/schema/world";
import { inject, injectable } from "inversify";
import { deleteDatabase, openDatabase, requestResult, transactionDone } from "./indexed-db.ts";
import type { PersistentStorage } from "./persistent-storage.ts";
import { INDEXED_DB, PERSISTENT_STORAGE } from "./tokens.ts";
import { readZip, writeStoredZip } from "./zip.ts";

export const WORLD_INDEX_DATABASE = "brr-worlds";
export const WORLD_DATABASE_PREFIX = "brr-world-";
export const IMPORT_DATABASE = "brr-imports";
const KIT_DATABASE = "brr-kits";
const IMPORT_STORE = "files";
const KIT_STORE = "kits";
const KIT_ARCHIVE_STORE = "archives";
const WORLD_INDEX_STORE = "worlds";
const MANIFEST_STORE = "manifest";
const SHARD_STORE = "shards";
const MANIFEST_KEY = "manifest";
const NOTE_SHARD_KEY_PREFIX = "notes/";

export interface ShardFile {
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly bytes: number;
}

export interface StoredWorld {
  readonly id: string;
  readonly manifest: WorldManifestV2;
  readonly shards: ReadonlyArray<WorldShardV2>;
  readonly notes: ReadonlyArray<NoteShardV2>;
}

export interface WorldChange {
  readonly header: WorldHeader;
  readonly put: ReadonlyArray<WorldShardV2>;
  readonly drop: ReadonlyArray<SuperChunk>;
  readonly putNotes: ReadonlyArray<NoteShardV2>;
  readonly dropNotes: ReadonlyArray<SuperChunk>;
}

export interface IWorldRepository {
  list(): Promise<ReadonlyArray<WorldIndexEntry>>;
  create(
    header: WorldHeader,
    shards: ReadonlyArray<WorldShardV2>,
    notes: ReadonlyArray<NoteShardV2>,
  ): Promise<WorldIndexEntry>;
  read(id: string): Promise<Decoded<StoredWorld>>;
  save(id: string, change: WorldChange): Promise<WorldIndexEntry>;
  remove(id: string): Promise<void>;
  shardFiles(id: string): Promise<ReadonlyArray<ShardFile>>;
  packArchive(archive: WorldArchive): Uint8Array;
  readArchive(bytes: Uint8Array): Promise<Decoded<WorldArchive>>;
  readWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<Decoded<WorldFiles>>;
  packPlanArchive(archive: PlanArchive): Uint8Array;
  readPlanArchive(bytes: Uint8Array): Promise<Decoded<PlanArchive>>;
  putImportedFile(file: ImportedFile): Promise<void>;
  importedFile(sha256: string): Promise<ImportedFile | undefined>;
  kits(): Promise<ReadonlyArray<KitIndexEntry>>;
  kitArchive(id: string): Promise<Uint8Array | undefined>;
  putKit(kit: KitIndexEntry, archive: Uint8Array): Promise<void>;
  removeKit(id: string): Promise<void>;
}

const HEX_RADIX = 16;
const HEX_BYTE_DIGITS = 2;

export async function contentSha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(digest, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_DIGITS, "0")).join(
    "",
  );
}

function isImportedFile(value: unknown): value is ImportedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "bytes" in value &&
    value.bytes instanceof Uint8Array
  );
}

export function worldDatabaseName(id: string): string {
  return `${WORLD_DATABASE_PREFIX}${id}`;
}

function noteShardKey(superChunk: SuperChunk): string {
  return `${NOTE_SHARD_KEY_PREFIX}${shardName(superChunk)}`;
}

const utf8 = new TextEncoder();

interface StoredEntries {
  readonly shards: ReadonlyArray<ShardEntryV1>;
  readonly noteShards: ReadonlyArray<NoteShardEntryV2>;
}

function storedEntries(text: unknown): StoredEntries {
  if (typeof text !== "string") return { shards: [], noteShards: [] };
  const json = parseJsonText(text, "manifest");
  const manifest = json.ok ? decodeWorldManifest(json.value, "manifest") : json;
  return decodedOrThrow(manifest, "the stored manifest is invalid");
}

function entriesBySuperChunk<Entry extends { readonly superChunk: SuperChunk }>(
  entries: ReadonlyArray<Entry>,
): Map<string, Entry> {
  return new Map(entries.map((entry) => [shardName(entry.superChunk), entry]));
}

const NOT_SAVED = "the world wasn't saved";

function decodeNoteShard(value: unknown, path: string): Decoded<NoteShardV2> {
  return decode(NoteShardV2, value, path);
}

function storedText<T>(
  texts: ReadonlyMap<string, unknown>,
  key: string,
  path: string,
  decodeStored: (value: unknown, path: string) => Decoded<T>,
): Decoded<T> {
  const text = texts.get(key);
  if (typeof text !== "string") {
    return { ok: false, issues: [{ path, message: "is in the manifest but not stored" }] };
  }
  const json = parseJsonText(text, path);
  return json.ok ? decodeStored(json.value, path) : json;
}

function indexEntries(values: ReadonlyArray<unknown>): WorldIndexEntry[] {
  return values.flatMap((value) => {
    const entry = decode(WorldIndexEntry, value);
    return entry.ok ? [entry.value] : [];
  });
}

interface ArchiveTexts {
  readonly manifest: {
    readonly shards: ReadonlyArray<ShardEntryV1>;
    readonly consists?: ReadonlyArray<ConsistRecordV1>;
  };
  readonly shards: ReadonlyArray<PlacedRefs>;
}

function changesContent(change: WorldChange): boolean {
  return (
    change.put.length > 0 ||
    change.drop.length > 0 ||
    change.putNotes.length > 0 ||
    change.dropNotes.length > 0
  );
}

function checkedForSave<T>(decoded: Decoded<T>, references: (value: T) => Issue[]): T {
  const value = decodedOrThrow(decoded, NOT_SAVED);
  const issues = references(value);
  if (issues.length > 0) decodedOrThrow({ ok: false, issues }, NOT_SAVED);
  return value;
}

@injectable()
export class IndexedDbWorldRepository implements IWorldRepository {
  private persistenceRequested = false;

  constructor(
    @inject(INDEXED_DB) private readonly factory: IDBFactory,
    @inject(PERSISTENT_STORAGE) private readonly storage: PersistentStorage | null,
  ) {}

  private requestPersistenceOnce(): void {
    if (this.persistenceRequested || this.storage === null) return;
    this.persistenceRequested = true;
    this.storage.persist().catch(() => false);
  }

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

  private async writeSummary(id: string, manifest: WorldManifestV2): Promise<WorldIndexEntry> {
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

  create(
    header: WorldHeader,
    shards: ReadonlyArray<WorldShardV2>,
    notes: ReadonlyArray<NoteShardV2>,
  ): Promise<WorldIndexEntry> {
    return this.write(crypto.randomUUID(), {
      header,
      put: shards,
      drop: [],
      putNotes: notes,
      dropNotes: [],
    });
  }

  async save(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    const summary = await this.write(id, change);
    if (changesContent(change)) this.requestPersistenceOnce();
    return summary;
  }

  private async write(id: string, change: WorldChange): Promise<WorldIndexEntry> {
    const header = decodedOrThrow(decode(WorldHeader, change.header, "world header"), NOT_SAVED);
    const index = new WorldDocumentIndex(header);
    for (const shard of change.put) {
      const path = `shard ${shardName(shard.superChunk)}`;
      checkedForSave(decode(WorldShardV2, shard, path), (value) =>
        shardReferenceIssues(index, value, path),
      );
    }
    for (const shard of change.putNotes) {
      const path = `note shard ${shardName(shard.superChunk)}`;
      checkedForSave(decode(NoteShardV2, shard, path), (value) =>
        noteShardReferenceIssues(index, value, path),
      );
    }
    const manifest = await this.withWorld(id, async (db) => {
      const transaction = db.transaction([MANIFEST_STORE, SHARD_STORE], "readwrite");
      const done = transactionDone(transaction);
      const manifests = transaction.objectStore(MANIFEST_STORE);
      const stored = storedEntries(await requestResult(manifests.get(MANIFEST_KEY)));
      const entries = entriesBySuperChunk(stored.shards);
      const noteEntries = entriesBySuperChunk(stored.noteShards);
      for (const superChunk of change.drop) entries.delete(shardName(superChunk));
      for (const shard of change.put) entries.set(shardName(shard.superChunk), shardEntry(shard));
      for (const superChunk of change.dropNotes) noteEntries.delete(shardName(superChunk));
      for (const shard of change.putNotes) {
        noteEntries.set(shardName(shard.superChunk), noteShardEntry(shard));
      }
      const next = decodedOrThrow(
        decodeWorldManifest(
          worldManifest(change.header, [...entries.values()], [...noteEntries.values()]),
          "manifest",
        ),
        NOT_SAVED,
      );
      const shards = transaction.objectStore(SHARD_STORE);
      for (const superChunk of change.drop) shards.delete(shardName(superChunk));
      for (const shard of change.put) shards.put(canonicalJson(shard), shardName(shard.superChunk));
      for (const superChunk of change.dropNotes) shards.delete(noteShardKey(superChunk));
      for (const shard of change.putNotes) {
        shards.put(canonicalJson(shard), noteShardKey(shard.superChunk));
      }
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
      ? decodeWorldManifest(manifestJson.value, "manifest")
      : manifestJson;
    if (!manifest.ok) return manifest;
    const index = new WorldDocumentIndex(manifest.value);
    const issues: Issue[] = [];
    const shards: WorldShardV2[] = [];
    for (const entry of manifest.value.shards) {
      const path = `shard ${shardName(entry.superChunk)}`;
      const shard = storedText(texts.shards, shardName(entry.superChunk), path, decodeWorldShard);
      if (shard.ok) {
        shards.push(shard.value);
        issues.push(...shardReferenceIssues(index, shard.value, path));
      } else {
        issues.push(...shard.issues);
      }
    }
    const notes: NoteShardV2[] = [];
    for (const entry of manifest.value.noteShards) {
      const path = `note shard ${shardName(entry.superChunk)}`;
      const shard = storedText(texts.shards, noteShardKey(entry.superChunk), path, decodeNoteShard);
      if (shard.ok) {
        notes.push(shard.value);
        issues.push(...noteShardReferenceIssues(index, shard.value, path));
      } else {
        issues.push(...shard.issues);
      }
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { id, manifest: manifest.value, shards, notes } };
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
    return writeStoredZip([
      ...worldArchiveFiles(archive).map((file) => ({
        name: file.name,
        bytes: utf8.encode(file.text),
      })),
      ...archive.imports.map((file) => ({ name: importPath(file), bytes: file.bytes })),
    ]);
  }

  async readArchive(bytes: Uint8Array): Promise<Decoded<WorldArchive>> {
    const zip = await readZip(bytes);
    return zip.ok ? this.readFiles(zip.value, readWorldArchive) : zip;
  }

  readWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<Decoded<WorldFiles>> {
    return this.readFiles(files, readWorldFiles);
  }

  packPlanArchive(archive: PlanArchive): Uint8Array {
    const imports = [...archive.imports];
    imports.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
    return writeStoredZip([
      ...planArchiveFiles(archive).map((file) => ({
        name: file.name,
        bytes: utf8.encode(file.text),
      })),
      ...imports.map((file) => ({ name: importPath(file), bytes: file.bytes })),
    ]);
  }

  async readPlanArchive(bytes: Uint8Array): Promise<Decoded<PlanArchive>> {
    const zip = await readZip(bytes);
    return zip.ok ? this.readFiles(zip.value, readPlanFiles) : zip;
  }

  private async readFiles<T extends ArchiveTexts>(
    files: ReadonlyMap<string, Uint8Array>,
    readTexts: (texts: ReadonlyMap<string, string>) => Decoded<T>,
  ): Promise<Decoded<T & { readonly imports: ReadonlyArray<ImportedFile> }>> {
    const texts = new Map<string, string>();
    const imports: ImportedFile[] = [];
    const issues: Issue[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const [name, data] of files) {
      if (name.startsWith(IMPORT_DIRECTORY)) {
        const path = parseImportPath(name);
        if (path === null) {
          issues.push({ path: name, message: "is not imports/<sha256>/<file name>" });
        } else if ((await contentSha256(data)) !== path.sha256) {
          issues.push({ path: name, message: "does not hash to the SHA-256 in its path" });
        } else {
          imports.push({ ...path, bytes: data });
        }
        continue;
      }
      try {
        texts.set(name, decoder.decode(data));
      } catch {
        return { ok: false, issues: [{ path: name, message: "is not UTF-8 text" }] };
      }
    }
    const archive = readTexts(texts);
    if (!archive.ok) return { ok: false, issues: [...issues, ...archive.issues] };
    const referenced = referencedImports(
      archive.value.shards,
      archive.value.manifest.consists ?? [],
    );
    const carried = new Set(imports.map((file) => file.sha256));
    for (const sha256 of referenced) {
      if (!carried.has(sha256)) {
        issues.push({
          path: `${IMPORT_DIRECTORY}${sha256}`,
          message: "is used by a placement but missing",
        });
      }
    }
    for (const file of imports) {
      if (!referenced.has(file.sha256)) {
        issues.push({ path: importPath(file), message: "is not used by any placement" });
      }
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { ...archive.value, imports } };
  }

  private async withImports<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.factory, IMPORT_DATABASE, [
      { name: IMPORT_STORE, keyPath: "sha256" },
    ]);
    try {
      return await use(db);
    } finally {
      db.close();
    }
  }

  putImportedFile(file: ImportedFile): Promise<void> {
    return this.withImports(async (db) => {
      const transaction = db.transaction(IMPORT_STORE, "readwrite");
      transaction.objectStore(IMPORT_STORE).put({ ...file });
      await transactionDone(transaction);
    });
  }

  async importedFile(sha256: string): Promise<ImportedFile | undefined> {
    const value: unknown = await this.withImports((db) =>
      requestResult(db.transaction(IMPORT_STORE).objectStore(IMPORT_STORE).get(sha256)),
    );
    return isImportedFile(value) && value.sha256 === sha256 ? value : undefined;
  }

  private async withKits<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase(this.factory, KIT_DATABASE, [
      { name: KIT_STORE, keyPath: "id" },
      { name: KIT_ARCHIVE_STORE },
    ]);
    try {
      return await use(db);
    } finally {
      db.close();
    }
  }

  async kits(): Promise<ReadonlyArray<KitIndexEntry>> {
    const values = await this.withKits((db) =>
      requestResult(db.transaction(KIT_STORE).objectStore(KIT_STORE).getAll()),
    );
    return values
      .flatMap((value) => {
        const entry = decode(KitIndexEntry, value);
        return entry.ok ? [entry.value] : [];
      })
      .toSorted((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }

  async kitArchive(id: string): Promise<Uint8Array | undefined> {
    const value: unknown = await this.withKits((db) =>
      requestResult(db.transaction(KIT_ARCHIVE_STORE).objectStore(KIT_ARCHIVE_STORE).get(id)),
    );
    return value instanceof Uint8Array ? value : undefined;
  }

  async putKit(kit: KitIndexEntry, archive: Uint8Array): Promise<void> {
    const entry = decodedOrThrow(decode(KitIndexEntry, kit, "kit"), "the kit wasn't saved");
    await this.withKits(async (db) => {
      const transaction = db.transaction([KIT_STORE, KIT_ARCHIVE_STORE], "readwrite");
      transaction.objectStore(KIT_STORE).put(entry);
      transaction.objectStore(KIT_ARCHIVE_STORE).put(archive.slice(), entry.id);
      await transactionDone(transaction);
    });
    this.requestPersistenceOnce();
  }

  removeKit(id: string): Promise<void> {
    return this.withKits(async (db) => {
      const transaction = db.transaction([KIT_STORE, KIT_ARCHIVE_STORE], "readwrite");
      transaction.objectStore(KIT_STORE).delete(id);
      transaction.objectStore(KIT_ARCHIVE_STORE).delete(id);
      await transactionDone(transaction);
    });
  }
}
