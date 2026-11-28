import {
  ShareLinkRow,
  shareLink,
  type RecordId,
  type ShareRole,
  type Token,
} from "@brr/schema/layout-api";
import type { IClock } from "./clock.ts";
import { textSha256 } from "./digest.ts";
import { newRecordId, newToken, type IRandomSource } from "./random.ts";
import { decodedRow, type SqlDatabase } from "./sql-database.ts";

export const SHARE_LINK_LIMIT = 50;

export interface ShareLinkRecord {
  readonly id: RecordId;
  readonly worldId: RecordId;
  readonly role: ShareRole;
  readonly createdAt: number;
}

export type CreateShareLinkOutcome =
  | { readonly kind: "created"; readonly link: ShareLinkRecord; readonly url: string }
  | { readonly kind: "limit-reached" };

export interface IShareLinks {
  create(worldId: RecordId, role: ShareRole): Promise<CreateShareLinkOutcome>;
  list(worldId: RecordId): Promise<ReadonlyArray<ShareLinkRecord>>;
  revoke(worldId: RecordId, linkId: RecordId): Promise<boolean>;
  find(token: Token): Promise<ShareLinkRecord | undefined>;
}

const LINK_COLUMNS = Object.keys(ShareLinkRow.entries).join(", ");

function shareLinkRecord(row: unknown): ShareLinkRecord {
  const link = decodedRow(ShareLinkRow, row, "share_links");
  return { id: link.id, worldId: link.world_id, role: link.role, createdAt: link.created_at };
}

export class ShareLinks implements IShareLinks {
  constructor(
    private readonly db: SqlDatabase,
    private readonly clock: IClock,
    private readonly random: IRandomSource,
    private readonly appOrigin: string,
  ) {}

  async create(worldId: RecordId, role: ShareRole): Promise<CreateShareLinkOutcome> {
    const token = newToken(this.random);
    const row = await this.db
      .prepare(
        `INSERT INTO share_links (id, world_id, token_hash, role, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM share_links WHERE world_id = ?2) < ?6
         RETURNING ${LINK_COLUMNS}`,
      )
      .bind(
        newRecordId(this.random),
        worldId,
        await textSha256(token),
        role,
        this.clock.now(),
        SHARE_LINK_LIMIT,
      )
      .first();
    if (row === null) return { kind: "limit-reached" };
    return {
      kind: "created",
      link: shareLinkRecord(row),
      url: shareLink(this.appOrigin, worldId, token),
    };
  }

  async list(worldId: RecordId): Promise<ReadonlyArray<ShareLinkRecord>> {
    const { results } = await this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM share_links WHERE world_id = ?1 ORDER BY created_at, id`,
      )
      .bind(worldId)
      .all();
    return results.map(shareLinkRecord);
  }

  async revoke(worldId: RecordId, linkId: RecordId): Promise<boolean> {
    const removed = await this.db
      .prepare("DELETE FROM share_links WHERE id = ?1 AND world_id = ?2 RETURNING id")
      .bind(linkId, worldId)
      .first();
    return removed !== null;
  }

  async find(token: Token): Promise<ShareLinkRecord | undefined> {
    const row = await this.db
      .prepare(`SELECT ${LINK_COLUMNS} FROM share_links WHERE token_hash = ?1`)
      .bind(await textSha256(token))
      .first();
    return row === null ? undefined : shareLinkRecord(row);
  }
}
