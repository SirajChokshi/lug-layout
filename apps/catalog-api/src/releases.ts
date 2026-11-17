import type { CatalogReader } from "./catalog-queries.ts";
import { CURRENT_RELEASE_TABLE, RELEASES_TABLE } from "./release-schema.ts";

export interface CatalogRelease {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly objectKey: string;
  readonly source: string;
  readonly loadedAt: string;
  readonly counts: Readonly<Record<string, number>>;
}

interface ReleaseRow {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly object_key: string;
  readonly source: string;
  readonly loaded_at: string;
  readonly counts: string;
}

const RELEASE_MEMO_MS = 300_000;
const CURRENT_MEMO_MS = 30_000;
const releaseColumns = "r.id, r.sha256, r.bytes, r.object_key, r.source, r.loaded_at, r.counts";

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
      .first<ReleaseRow>();
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
      .first<ReleaseRow>();
    const release = row === null ? undefined : toRelease(row);
    this.current = { value: release, expires: now + CURRENT_MEMO_MS };
    return release;
  }
}

function toRelease(row: ReleaseRow): CatalogRelease {
  return {
    id: row.id,
    sha256: row.sha256,
    bytes: row.bytes,
    objectKey: row.object_key,
    source: row.source,
    loadedAt: row.loaded_at,
    counts: JSON.parse(row.counts) as Record<string, number>,
  };
}
