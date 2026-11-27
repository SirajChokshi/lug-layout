import type { Issue } from "@brr/schema/decode";
import {
  VersionRow,
  WorldRow,
  type RecordId,
  type SaveVersionRequest,
  type Sha256,
  type VersionPageParams,
  type WorldSnapshot,
} from "@brr/schema/layout-api";
import * as v from "valibot";
import type { IClock } from "./clock.ts";
import { shardBindings, snapshotIssues } from "./snapshot-check.ts";
import { decodedRow, type SqlDatabase } from "./sql-database.ts";
import type { IWorldFiles } from "./world-files.ts";
import type { WorldRecord } from "./world-record.ts";

export interface VersionRecord {
  readonly version: number;
  readonly parent: number | null;
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly snapshot: Sha256;
  readonly savedBy: RecordId;
  readonly savedAt: number;
}

export type SaveOutcome =
  | {
      readonly kind: "saved";
      readonly version: VersionRecord;
      readonly previousHead: number | null;
    }
  | {
      readonly kind: "missing";
      readonly shards: ReadonlyArray<Sha256>;
      readonly imports: ReadonlyArray<Sha256>;
    }
  | { readonly kind: "invalid"; readonly issues: ReadonlyArray<Issue> }
  | { readonly kind: "over-quota"; readonly usage: number };

export interface VersionPage {
  readonly versions: ReadonlyArray<VersionRecord>;
  readonly more: boolean;
}

export interface IWorldHistory {
  save(world: WorldRecord, savedBy: RecordId, request: SaveVersionRequest): Promise<SaveOutcome>;
  list(worldId: RecordId, page: VersionPageParams): Promise<VersionPage>;
  read(
    worldId: RecordId,
    version: number,
  ): Promise<{ readonly record: VersionRecord; readonly snapshot: WorldSnapshot } | undefined>;
}

const VERSION_COLUMNS = Object.keys(VersionRow.entries).join(", ");
const HeadRow = v.pick(WorldRow, ["head"]);

function versionRecord(row: unknown): VersionRecord {
  const version = decodedRow(VersionRow, row, "world_versions");
  return {
    version: version.version,
    parent: version.parent,
    name: version.name,
    placements: version.placements,
    track: version.track,
    snapshot: version.snapshot_sha256,
    savedBy: version.saved_by,
    savedAt: version.saved_at,
  };
}

export class WorldHistory implements IWorldHistory {
  constructor(
    private readonly db: SqlDatabase,
    private readonly files: IWorldFiles,
    private readonly clock: IClock,
  ) {}

  async save(
    world: WorldRecord,
    savedBy: RecordId,
    request: SaveVersionRequest,
  ): Promise<SaveOutcome> {
    const { parent, snapshot } = request;
    if (parent !== null && (await this.find(world.id, parent)) === undefined) {
      return {
        kind: "invalid",
        issues: [
          { path: "parent", message: `is version ${parent}, which this world doesn't have` },
        ],
      };
    }
    const shardHashes = [...new Set(shardBindings(snapshot).map((binding) => binding.sha256))];
    const importHashes = snapshot.imports.map((entry) => entry.sha256);
    const [summaries, imports] = await Promise.all([
      this.files.shardSummaries(world.id, shardHashes),
      this.files.storedImports(world.id, importHashes),
    ]);
    const missingShards = shardHashes.filter((sha256) => !summaries.has(sha256)).toSorted();
    const missingImports = importHashes.filter((sha256) => !imports.has(sha256));
    if (missingShards.length > 0 || missingImports.length > 0) {
      return { kind: "missing", shards: missingShards, imports: missingImports };
    }
    const issues = snapshotIssues(snapshot, summaries);
    if (issues.length > 0) return { kind: "invalid", issues };
    const stored = await this.files.putSnapshot(world, snapshot);
    if (stored.kind === "over-quota") return stored;
    return this.record(world, savedBy, parent, snapshot, stored.sha256);
  }

  async list(worldId: RecordId, page: VersionPageParams): Promise<VersionPage> {
    const { results } = await this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM world_versions WHERE world_id = ?1 AND version < ?2 ORDER BY version DESC LIMIT ?3`,
      )
      .bind(worldId, page.before ?? Number.MAX_SAFE_INTEGER, page.limit + 1)
      .all();
    const versions = results.map(versionRecord);
    return { versions: versions.slice(0, page.limit), more: versions.length > page.limit };
  }

  async read(
    worldId: RecordId,
    version: number,
  ): Promise<{ readonly record: VersionRecord; readonly snapshot: WorldSnapshot } | undefined> {
    const record = await this.find(worldId, version);
    if (record === undefined) return undefined;
    return { record, snapshot: await this.files.readSnapshot(worldId, record.snapshot) };
  }

  private async find(worldId: RecordId, version: number): Promise<VersionRecord | undefined> {
    const row = await this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM world_versions WHERE world_id = ?1 AND version = ?2`)
      .bind(worldId, version)
      .first();
    return row === null ? undefined : versionRecord(row);
  }

  private async record(
    world: WorldRecord,
    savedBy: RecordId,
    parent: number | null,
    snapshot: WorldSnapshot,
    snapshotSha256: Sha256,
  ): Promise<SaveOutcome> {
    const now = this.clock.now();
    const { manifest } = snapshot;
    const [head, inserted] = await this.db.batch([
      this.db.prepare("SELECT head FROM worlds WHERE id = ?1").bind(world.id),
      this.db
        .prepare(
          `INSERT INTO world_versions (world_id, version, parent, snapshot_sha256, name, placements, track, saved_by, saved_at)
           SELECT ?1, COALESCE(MAX(version), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM world_versions WHERE world_id = ?1
           RETURNING ${VERSION_COLUMNS}`,
        )
        .bind(
          world.id,
          parent,
          snapshotSha256,
          manifest.name,
          manifest.placements,
          manifest.track,
          savedBy,
          now,
        ),
      this.db
        .prepare(
          "UPDATE worlds SET head = (SELECT MAX(version) FROM world_versions WHERE world_id = ?1), name = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .bind(world.id, manifest.name, now),
    ]);
    const previousHead = decodedRow(HeadRow, head?.results[0], "worlds").head;
    return { kind: "saved", version: versionRecord(inserted?.results[0]), previousHead };
  }
}
