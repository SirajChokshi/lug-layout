import type { CatalogReader } from "./catalog-queries.ts";
import { CatalogRelease, ReleaseRow } from "@brr/schema/catalog-api";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { CURRENT_RELEASE_TABLE, RELEASES_TABLE } from "./release-schema.ts";

const RELEASE_MEMO_MS = 300_000;
const CURRENT_MEMO_MS = 30_000;
const releaseColumns = Object.keys(ReleaseRow.entries)
  .map((column) => `r.${column}`)
  .join(", ");

interface Memo<T> {
  readonly value: T;
  readonly expires: number;
}

export class ReleaseDirectory {
  private readonly known = new Map<string, Memo<CatalogRelease | undefined>>();
  private current: Memo<CatalogRelease | undefined> | undefined;

  async find(db: CatalogReader, id: string, now: number): Promise<CatalogRelease | undefined> {
    const memo = this.known.get(id);
    if (memo !== undefined && memo.expires > now) return memo.value;
    const row = await db
      .prepare(`SELECT ${releaseColumns} FROM ${RELEASES_TABLE} r WHERE r.id = ?1`)
      .bind(id)
      .first();
    const release = row === null ? undefined : toRelease(row);
    const ttl = release === undefined ? CURRENT_MEMO_MS : RELEASE_MEMO_MS;
    this.known.set(id, { value: release, expires: now + ttl });
    return release;
  }

  async findCurrent(db: CatalogReader, now: number): Promise<CatalogRelease | undefined> {
    if (this.current !== undefined && this.current.expires > now) return this.current.value;
    const row = await db
      .prepare(
        `SELECT ${releaseColumns} FROM ${CURRENT_RELEASE_TABLE} c JOIN ${RELEASES_TABLE} r ON r.id = c.release_id WHERE c.slot = 'current'`,
      )
      .first();
    const release = row === null ? undefined : toRelease(row);
    this.current = { value: release, expires: now + CURRENT_MEMO_MS };
    return release;
  }
}

function toRelease(row: unknown): CatalogRelease {
  return decodedOrThrow(decode(CatalogRelease, row), RELEASES_TABLE);
}
