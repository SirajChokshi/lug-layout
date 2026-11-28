import { decode, decodedOrThrow, type Issue } from "@brr/schema/decode";
import {
  StoredFileRow,
  StoredShardRow,
  WorldSnapshot,
  type ShardSummary,
  type Sha256,
} from "@brr/schema/layout-api";
import { SafeInteger, canonicalJson, parseJsonText } from "@brr/schema/world";
import * as v from "valibot";
import type { IClock } from "./clock.ts";
import { sha256Hex } from "./digest.ts";
import { hashIssues, readUploadedShard } from "./shard-upload.ts";
import { decodedRow, decodedRows, type SqlDatabase } from "./sql-database.ts";
import { utf8Bytes } from "./utf8.ts";
import type { WorldRecord } from "./world-record.ts";

export const STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
export const FILE_CONTENT_TYPE = "application/octet-stream";
const R2_DELETE_BATCH = 1000;

export type PutFileOutcome =
  | { readonly kind: "stored"; readonly created: boolean; readonly bytes: number }
  | { readonly kind: "invalid"; readonly issues: ReadonlyArray<Issue> }
  | { readonly kind: "over-quota"; readonly usage: number };

type StoreOutcome = Exclude<PutFileOutcome, { readonly kind: "invalid" }>;

export type PutSnapshotOutcome =
  | { readonly kind: "stored"; readonly sha256: Sha256; readonly bytes: number }
  | { readonly kind: "over-quota"; readonly usage: number };

export interface IWorldFiles {
  putShard(
    world: WorldRecord,
    sha256: Sha256,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<PutFileOutcome>;
  putImport(
    world: WorldRecord,
    sha256: Sha256,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<PutFileOutcome>;
  putSnapshot(world: WorldRecord, snapshot: WorldSnapshot): Promise<PutSnapshotOutcome>;
  readShard(worldId: string, sha256: Sha256): Promise<R2ObjectBody | null>;
  readImport(worldId: string, sha256: Sha256): Promise<R2ObjectBody | null>;
  readSnapshot(worldId: string, sha256: Sha256): Promise<WorldSnapshot>;
  shardSummaries(
    worldId: string,
    hashes: ReadonlyArray<Sha256>,
  ): Promise<ReadonlyMap<Sha256, ShardSummary>>;
  storedImports(worldId: string, hashes: ReadonlyArray<Sha256>): Promise<ReadonlySet<Sha256>>;
  usage(ownerId: string): Promise<number>;
  removeWorld(worldId: string): Promise<void>;
}

const UsageRow = v.object({ bytes: SafeInteger });
const PresentRow = v.pick(StoredFileRow, ["sha256"]);

type FileTable = "world_shards" | "world_imports" | "world_snapshots";

function worldPrefix(worldId: string): string {
  return `worlds/${worldId}/`;
}

function shardKey(worldId: string, sha256: Sha256): string {
  return `${worldPrefix(worldId)}shards/${sha256}.json`;
}

function importKey(worldId: string, sha256: Sha256): string {
  return `${worldPrefix(worldId)}imports/${sha256}`;
}

function snapshotKey(worldId: string, sha256: Sha256): string {
  return `${worldPrefix(worldId)}snapshots/${sha256}.json`;
}

function usageQuery(ownerParameter: string): string {
  const tables: ReadonlyArray<FileTable> = ["world_shards", "world_imports", "world_snapshots"];
  const perTable = tables.map(
    (table) =>
      `SELECT f.bytes FROM ${table} f JOIN worlds w ON w.id = f.world_id WHERE w.owner_id = ${ownerParameter}`,
  );
  return `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (${perTable.join(" UNION ALL ")})`;
}

export class WorldFiles implements IWorldFiles {
  constructor(
    private readonly db: SqlDatabase,
    private readonly bucket: R2Bucket,
    private readonly clock: IClock,
  ) {}

  async putShard(
    world: WorldRecord,
    sha256: Sha256,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<PutFileOutcome> {
    const read = await readUploadedShard(body, sha256);
    if (!read.ok) return { kind: "invalid", issues: read.issues };
    return this.store(world, "world_shards", sha256, body, {
      key: shardKey(world.id, sha256),
      contentType: JSON_CONTENT_TYPE,
      summary: JSON.stringify(read.value),
    });
  }

  async putImport(
    world: WorldRecord,
    sha256: Sha256,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<PutFileOutcome> {
    const mismatch = await hashIssues(body, sha256);
    if (mismatch.length > 0) return { kind: "invalid", issues: mismatch };
    return this.store(world, "world_imports", sha256, body, {
      key: importKey(world.id, sha256),
      contentType: FILE_CONTENT_TYPE,
    });
  }

  async putSnapshot(world: WorldRecord, snapshot: WorldSnapshot): Promise<PutSnapshotOutcome> {
    const body = utf8Bytes(canonicalJson(snapshot));
    const sha256 = await sha256Hex(body);
    const stored = await this.store(world, "world_snapshots", sha256, body, {
      key: snapshotKey(world.id, sha256),
      contentType: JSON_CONTENT_TYPE,
    });
    return stored.kind === "stored" ? { kind: "stored", sha256, bytes: stored.bytes } : stored;
  }

  readShard(worldId: string, sha256: Sha256): Promise<R2ObjectBody | null> {
    return this.bucket.get(shardKey(worldId, sha256));
  }

  readImport(worldId: string, sha256: Sha256): Promise<R2ObjectBody | null> {
    return this.bucket.get(importKey(worldId, sha256));
  }

  async readSnapshot(worldId: string, sha256: Sha256): Promise<WorldSnapshot> {
    const key = snapshotKey(worldId, sha256);
    const object = await this.bucket.get(key);
    if (object === null) throw new Error(`${key} is listed in world_versions but missing`);
    const json = parseJsonText(await object.text(), key);
    return decodedOrThrow(json.ok ? decode(WorldSnapshot, json.value, key) : json, key);
  }

  async shardSummaries(
    worldId: string,
    hashes: ReadonlyArray<Sha256>,
  ): Promise<ReadonlyMap<Sha256, ShardSummary>> {
    const { results } = await this.db
      .prepare(
        "SELECT sha256, bytes, summary FROM world_shards WHERE world_id = ?1 AND sha256 IN (SELECT value FROM json_each(?2))",
      )
      .bind(worldId, JSON.stringify(hashes))
      .all();
    return new Map(
      decodedRows(StoredShardRow, results, "world_shards").map((row) => [row.sha256, row.summary]),
    );
  }

  async storedImports(
    worldId: string,
    hashes: ReadonlyArray<Sha256>,
  ): Promise<ReadonlySet<Sha256>> {
    const { results } = await this.db
      .prepare(
        "SELECT sha256 FROM world_imports WHERE world_id = ?1 AND sha256 IN (SELECT value FROM json_each(?2))",
      )
      .bind(worldId, JSON.stringify(hashes))
      .all();
    return new Set(decodedRows(PresentRow, results, "world_imports").map((row) => row.sha256));
  }

  async usage(ownerId: string): Promise<number> {
    const row = await this.db.prepare(usageQuery("?1")).bind(ownerId).first();
    return decodedRow(UsageRow, row, "world files").bytes;
  }

  async removeWorld(worldId: string): Promise<void> {
    const prefix = worldPrefix(worldId);
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({
        prefix,
        limit: R2_DELETE_BATCH,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const keys = listed.objects.map((object) => object.key);
      if (keys.length > 0) await this.bucket.delete(keys);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);
  }

  private async store(
    world: WorldRecord,
    table: FileTable,
    sha256: Sha256,
    body: Uint8Array<ArrayBuffer>,
    object: { readonly key: string; readonly contentType: string; readonly summary?: string },
  ): Promise<StoreOutcome> {
    const bytes = body.byteLength;
    if (await this.isStored(table, world.id, sha256))
      return { kind: "stored", created: false, bytes };
    const usage = await this.usage(world.ownerId);
    if (usage + bytes > STORAGE_QUOTA_BYTES) return { kind: "over-quota", usage };
    await this.bucket.put(object.key, body, {
      sha256,
      httpMetadata: { contentType: object.contentType },
    });
    const now = this.clock.now();
    const withinQuota = `WHERE (${usageQuery("?5")}) + ?3 <= ?6 RETURNING sha256`;
    const insert =
      object.summary === undefined
        ? this.db
            .prepare(
              `INSERT OR IGNORE INTO ${table} (world_id, sha256, bytes, created_at) SELECT ?1, ?2, ?3, ?4 ${withinQuota}`,
            )
            .bind(world.id, sha256, bytes, now, world.ownerId, STORAGE_QUOTA_BYTES)
        : this.db
            .prepare(
              `INSERT OR IGNORE INTO ${table} (world_id, sha256, bytes, created_at, summary) SELECT ?1, ?2, ?3, ?4, ?7 ${withinQuota}`,
            )
            .bind(world.id, sha256, bytes, now, world.ownerId, STORAGE_QUOTA_BYTES, object.summary);
    if ((await insert.first()) !== null) return { kind: "stored", created: true, bytes };
    if (await this.isStored(table, world.id, sha256))
      return { kind: "stored", created: false, bytes };
    await this.bucket.delete(object.key);
    return { kind: "over-quota", usage: await this.usage(world.ownerId) };
  }

  private async isStored(table: FileTable, worldId: string, sha256: Sha256): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT sha256 FROM ${table} WHERE world_id = ?1 AND sha256 = ?2`)
      .bind(worldId, sha256)
      .first();
    return row !== null;
  }
}
