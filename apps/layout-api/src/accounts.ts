import {
  AccountRow,
  SignInLinkRow,
  signInLink,
  type EmailAddress,
  type RecordId,
  type Token,
} from "@brr/schema/layout-api";
import { SafeInteger } from "@brr/schema/world";
import * as v from "valibot";
import type { IClock } from "./clock.ts";
import { textSha256 } from "./digest.ts";
import type { IMailer } from "./mailer.ts";
import { newRecordId, newToken, type IRandomSource } from "./random.ts";
import { decodedRow, type SqlDatabase } from "./sql-database.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const SIGN_IN_LINK_LIFETIME_MS = 15 * MINUTE_MS;
export const SESSION_LIFETIME_MS = 30 * DAY_MS;
export const OUTSTANDING_LINKS_PER_ADDRESS = 3;

export interface AccountRecord {
  readonly id: RecordId;
  readonly email: string;
  readonly createdAt: number;
}

export type SignInLinkOutcome =
  | { readonly kind: "sent"; readonly expiresAt: number }
  | { readonly kind: "throttled"; readonly retryAt: number }
  | { readonly kind: "undeliverable"; readonly reason: string };

export type SessionOutcome =
  | {
      readonly kind: "started";
      readonly token: Token;
      readonly expiresAt: number;
      readonly account: AccountRecord;
    }
  | { readonly kind: "refused" };

export interface IAccounts {
  requestSignInLink(email: EmailAddress): Promise<SignInLinkOutcome>;
  startSession(linkToken: Token): Promise<SessionOutcome>;
  authenticate(sessionToken: Token): Promise<AccountRecord | undefined>;
  endSession(sessionToken: Token): Promise<void>;
  remove(account: AccountRecord): Promise<void>;
  removeExpired(now: number): Promise<void>;
}

const OutstandingLinksRow = v.object({ count: SafeInteger, earliest: v.nullable(SafeInteger) });
const ConsumedLinkRow = v.pick(SignInLinkRow, ["email"]);
const ACCOUNT_COLUMNS = Object.keys(AccountRow.entries)
  .map((column) => `a.${column}`)
  .join(", ");

function accountRecord(row: unknown): AccountRecord {
  const account = decodedRow(AccountRow, row, "accounts");
  return { id: account.id, email: account.email, createdAt: account.created_at };
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Accounts implements IAccounts {
  constructor(
    private readonly db: SqlDatabase,
    private readonly mailer: IMailer,
    private readonly clock: IClock,
    private readonly random: IRandomSource,
    private readonly appOrigin: string,
  ) {}

  async requestSignInLink(email: EmailAddress): Promise<SignInLinkOutcome> {
    const now = this.clock.now();
    const outstanding = decodedRow(
      OutstandingLinksRow,
      await this.db
        .prepare(
          "SELECT COUNT(*) AS count, MIN(expires_at) AS earliest FROM sign_in_links WHERE email = ?1 AND expires_at > ?2",
        )
        .bind(email, now)
        .first(),
      "sign_in_links",
    );
    if (outstanding.count >= OUTSTANDING_LINKS_PER_ADDRESS) {
      return { kind: "throttled", retryAt: outstanding.earliest ?? now };
    }
    const token = newToken(this.random);
    const tokenHash = await textSha256(token);
    const expiresAt = now + SIGN_IN_LINK_LIFETIME_MS;
    await this.db
      .prepare(
        "INSERT INTO sign_in_links (token_hash, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(tokenHash, email, now, expiresAt)
      .run();
    try {
      await this.mailer.sendSignIn({
        to: email,
        link: signInLink(this.appOrigin, token),
        lifetimeMinutes: SIGN_IN_LINK_LIFETIME_MS / MINUTE_MS,
      });
    } catch (error) {
      await this.db
        .prepare("DELETE FROM sign_in_links WHERE token_hash = ?1")
        .bind(tokenHash)
        .run();
      return { kind: "undeliverable", reason: failureReason(error) };
    }
    return { kind: "sent", expiresAt };
  }

  async startSession(linkToken: Token): Promise<SessionOutcome> {
    const now = this.clock.now();
    const consumed = await this.db
      .prepare(
        "DELETE FROM sign_in_links WHERE token_hash = ?1 AND expires_at > ?2 RETURNING email",
      )
      .bind(await textSha256(linkToken), now)
      .first();
    if (consumed === null) return { kind: "refused" };
    const { email } = decodedRow(ConsumedLinkRow, consumed, "sign_in_links");
    const token = newToken(this.random);
    const expiresAt = now + SESSION_LIFETIME_MS;
    const [, , selected] = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (email) DO NOTHING",
        )
        .bind(newRecordId(this.random), email, now),
      this.db
        .prepare(
          "INSERT INTO sessions (token_hash, account_id, created_at, expires_at) SELECT ?1, id, ?2, ?3 FROM accounts WHERE email = ?4",
        )
        .bind(await textSha256(token), now, expiresAt, email),
      this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.email = ?1`).bind(email),
    ]);
    return { kind: "started", token, expiresAt, account: accountRecord(selected?.results[0]) };
  }

  async authenticate(sessionToken: Token): Promise<AccountRecord | undefined> {
    const row = await this.db
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
      )
      .bind(await textSha256(sessionToken), this.clock.now())
      .first();
    return row === null ? undefined : accountRecord(row);
  }

  async endSession(sessionToken: Token): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE token_hash = ?1")
      .bind(await textSha256(sessionToken))
      .run();
  }

  async remove(account: AccountRecord): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sign_in_links WHERE email = ?1").bind(account.email),
      this.db.prepare("DELETE FROM accounts WHERE id = ?1").bind(account.id),
    ]);
  }

  async removeExpired(now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sign_in_links WHERE expires_at <= ?1").bind(now),
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
    ]);
  }
}
