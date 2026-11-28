import { SafeInteger } from "@brr/schema/world";
import * as v from "valibot";
import type { IClock } from "./clock.ts";
import { MIGRATION_LEDGER, type Migration } from "./migrations.ts";
import { decodedRow, type SqlDatabase } from "./sql-database.ts";

export interface ISchemaMigrations {
  ready(): Promise<void>;
}

const AppliedRow = v.object({ version: SafeInteger });

export class SchemaMigrations implements ISchemaMigrations {
  private applying: Promise<void> | undefined;

  constructor(
    private readonly db: SqlDatabase,
    private readonly migrations: ReadonlyArray<Migration>,
    private readonly clock: IClock,
  ) {}

  ready(): Promise<void> {
    this.applying ??= this.migrate().catch((error: unknown) => {
      this.applying = undefined;
      throw error;
    });
    return this.applying;
  }

  private async migrate(): Promise<void> {
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`,
      )
      .run();
    let applied = await this.appliedVersion();
    for (const migration of this.migrations) {
      if (migration.version <= applied) continue;
      await this.apply(migration);
      applied = migration.version;
    }
  }

  private async apply(migration: Migration): Promise<void> {
    const record = this.db
      .prepare(`INSERT INTO ${MIGRATION_LEDGER} (version, applied_at) VALUES (?1, ?2)`)
      .bind(migration.version, this.clock.now());
    try {
      await this.db.batch([
        ...migration.statements.map((statement) => this.db.prepare(statement)),
        record,
      ]);
    } catch (error) {
      if ((await this.appliedVersion()) < migration.version) throw error;
    }
  }

  private async appliedVersion(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM ${MIGRATION_LEDGER}`)
      .first();
    return decodedRow(AppliedRow, row, MIGRATION_LEDGER).version;
  }
}
