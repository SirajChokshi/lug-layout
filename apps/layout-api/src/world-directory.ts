import { WorldRow, type RecordId } from "@brr/schema/layout-api";
import type { IClock } from "./clock.ts";
import { newRecordId, type IRandomSource } from "./random.ts";
import { decodedRow, decodedRows, type SqlDatabase } from "./sql-database.ts";
import type { IWorldFiles } from "./world-files.ts";
import type { WorldRecord } from "./world-record.ts";

export const WORLD_LIMIT = 500;

export type CreateWorldOutcome =
  | { readonly kind: "created"; readonly world: WorldRecord }
  | { readonly kind: "limit-reached" };

export interface IWorldDirectory {
  list(ownerId: RecordId): Promise<ReadonlyArray<WorldRecord>>;
  create(ownerId: RecordId, name: string): Promise<CreateWorldOutcome>;
  find(accountId: RecordId, worldId: RecordId): Promise<WorldRecord | undefined>;
  remove(world: WorldRecord): Promise<void>;
  removeOwnedBy(ownerId: RecordId): Promise<void>;
}

const WORLD_COLUMNS = Object.keys(WorldRow.entries).join(", ");

function worldRecord(row: unknown): WorldRecord {
  const world = decodedRow(WorldRow, row, "worlds");
  return {
    id: world.id,
    ownerId: world.owner_id,
    name: world.name,
    createdAt: world.created_at,
    updatedAt: world.updated_at,
    head: world.head,
  };
}

export class WorldDirectory implements IWorldDirectory {
  constructor(
    private readonly db: SqlDatabase,
    private readonly files: IWorldFiles,
    private readonly clock: IClock,
    private readonly random: IRandomSource,
  ) {}

  async list(ownerId: RecordId): Promise<ReadonlyArray<WorldRecord>> {
    const { results } = await this.db
      .prepare(
        `SELECT ${WORLD_COLUMNS} FROM worlds WHERE owner_id = ?1 ORDER BY updated_at DESC, id`,
      )
      .bind(ownerId)
      .all();
    return decodedRows(WorldRow, results, "worlds").map(worldRecord);
  }

  async create(ownerId: RecordId, name: string): Promise<CreateWorldOutcome> {
    const now = this.clock.now();
    const row = await this.db
      .prepare(
        `INSERT INTO worlds (id, owner_id, name, created_at, updated_at, head)
         SELECT ?1, ?2, ?3, ?4, ?4, NULL WHERE (SELECT COUNT(*) FROM worlds WHERE owner_id = ?2) < ?5
         RETURNING ${WORLD_COLUMNS}`,
      )
      .bind(newRecordId(this.random), ownerId, name, now, WORLD_LIMIT)
      .first();
    return row === null ? { kind: "limit-reached" } : { kind: "created", world: worldRecord(row) };
  }

  async find(accountId: RecordId, worldId: RecordId): Promise<WorldRecord | undefined> {
    const row = await this.db
      .prepare(`SELECT ${WORLD_COLUMNS} FROM worlds WHERE id = ?1 AND owner_id = ?2`)
      .bind(worldId, accountId)
      .first();
    return row === null ? undefined : worldRecord(row);
  }

  async remove(world: WorldRecord): Promise<void> {
    await this.files.removeWorld(world.id);
    await this.db.prepare("DELETE FROM worlds WHERE id = ?1").bind(world.id).run();
  }

  async removeOwnedBy(ownerId: RecordId): Promise<void> {
    for (const world of await this.list(ownerId)) await this.remove(world);
  }
}
