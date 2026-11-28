import {
  CommentRow,
  CommentThreadRow,
  type CommentPin,
  type RecordId,
  type StartThreadRequest,
} from "@brr/schema/layout-api";
import type { IClock } from "./clock.ts";
import { newRecordId, type IRandomSource } from "./random.ts";
import { decodedRow, type SqlStatement, type SqlDatabase } from "./sql-database.ts";

export const COMMENT_LIMIT = 1000;

export interface CommentRecord {
  readonly id: RecordId;
  readonly author: RecordId;
  readonly text: string;
  readonly createdAt: number;
}

export interface ThreadRecord {
  readonly id: RecordId;
  readonly version: number;
  readonly pin: CommentPin;
  readonly resolved: { readonly by: RecordId; readonly at: number } | null;
  readonly comments: ReadonlyArray<CommentRecord>;
}

export type ReplyOutcome =
  | { readonly kind: "replied"; readonly thread: ThreadRecord }
  | { readonly kind: "no-thread" }
  | { readonly kind: "limit-reached" };

export interface IComments {
  list(worldId: RecordId): Promise<ReadonlyArray<ThreadRecord>>;
  start(
    worldId: RecordId,
    author: RecordId,
    request: StartThreadRequest,
  ): Promise<ThreadRecord | undefined>;
  reply(
    worldId: RecordId,
    threadId: RecordId,
    author: RecordId,
    text: string,
  ): Promise<ReplyOutcome>;
  resolve(
    worldId: RecordId,
    threadId: RecordId,
    resolvedBy: RecordId | null,
  ): Promise<ThreadRecord | undefined>;
}

const THREAD_COLUMNS = Object.keys(CommentThreadRow.entries).join(", ");
const COMMENT_COLUMNS = Object.keys(CommentRow.entries).join(", ");
const UNDER_LIMIT = "(SELECT COUNT(*) FROM comments WHERE world_id = ?2) < ?3";

function commentRecord(row: CommentRow): CommentRecord {
  return { id: row.id, author: row.author_id, text: row.text, createdAt: row.created_at };
}

export class Comments implements IComments {
  constructor(
    private readonly db: SqlDatabase,
    private readonly clock: IClock,
    private readonly random: IRandomSource,
  ) {}

  list(worldId: RecordId): Promise<ReadonlyArray<ThreadRecord>> {
    return this.threads(worldId, null);
  }

  async start(
    worldId: RecordId,
    author: RecordId,
    request: StartThreadRequest,
  ): Promise<ThreadRecord | undefined> {
    const threadId = newRecordId(this.random);
    const [, added] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO comment_threads (id, world_id, version, pin, created_at)
           SELECT ?1, ?2, ?4, ?5, ?6 WHERE ${UNDER_LIMIT}`,
        )
        .bind(
          threadId,
          worldId,
          COMMENT_LIMIT,
          request.version,
          JSON.stringify(request.pin),
          this.clock.now(),
        ),
      this.addComment(worldId, threadId, author, request.text),
    ]);
    return added?.results.length === 1 ? this.thread(worldId, threadId) : undefined;
  }

  async reply(
    worldId: RecordId,
    threadId: RecordId,
    author: RecordId,
    text: string,
  ): Promise<ReplyOutcome> {
    const added = await this.addComment(worldId, threadId, author, text).first();
    const thread = await this.thread(worldId, threadId);
    if (thread === undefined) return { kind: "no-thread" };
    return added === null ? { kind: "limit-reached" } : { kind: "replied", thread };
  }

  async resolve(
    worldId: RecordId,
    threadId: RecordId,
    resolvedBy: RecordId | null,
  ): Promise<ThreadRecord | undefined> {
    const updated = await this.db
      .prepare(
        "UPDATE comment_threads SET resolved_by = ?3, resolved_at = ?4 WHERE id = ?1 AND world_id = ?2 RETURNING id",
      )
      .bind(threadId, worldId, resolvedBy, resolvedBy === null ? null : this.clock.now())
      .first();
    return updated === null ? undefined : this.thread(worldId, threadId);
  }

  private addComment(
    worldId: RecordId,
    threadId: RecordId,
    author: RecordId,
    text: string,
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO comments (id, world_id, thread_id, author_id, text, created_at)
         SELECT ?4, world_id, id, ?5, ?6, ?7 FROM comment_threads
         WHERE id = ?1 AND world_id = ?2 AND ${UNDER_LIMIT}
         RETURNING id`,
      )
      .bind(
        threadId,
        worldId,
        COMMENT_LIMIT,
        newRecordId(this.random),
        author,
        text,
        this.clock.now(),
      );
  }

  private async thread(worldId: RecordId, threadId: RecordId): Promise<ThreadRecord | undefined> {
    return (await this.threads(worldId, threadId))[0];
  }

  private async threads(
    worldId: RecordId,
    threadId: RecordId | null,
  ): Promise<ReadonlyArray<ThreadRecord>> {
    const [threadRows, commentRows] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${THREAD_COLUMNS} FROM comment_threads
           WHERE world_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY created_at, rowid`,
        )
        .bind(worldId, threadId),
      this.db
        .prepare(
          `SELECT ${COMMENT_COLUMNS} FROM comments
           WHERE world_id = ?1 AND (?2 IS NULL OR thread_id = ?2) ORDER BY created_at, rowid`,
        )
        .bind(worldId, threadId),
    ]);
    const byThread = new Map<RecordId, CommentRecord[]>();
    for (const row of commentRows?.results ?? []) {
      const comment = decodedRow(CommentRow, row, "comments");
      const comments = byThread.get(comment.thread_id) ?? [];
      comments.push(commentRecord(comment));
      byThread.set(comment.thread_id, comments);
    }
    return (threadRows?.results ?? []).map((row) => {
      const thread = decodedRow(CommentThreadRow, row, "comment_threads");
      return {
        id: thread.id,
        version: thread.version,
        pin: thread.pin,
        resolved:
          thread.resolved_by === null || thread.resolved_at === null
            ? null
            : { by: thread.resolved_by, at: thread.resolved_at },
        comments: byThread.get(thread.id) ?? [],
      };
    });
  }
}
