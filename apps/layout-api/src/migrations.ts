export interface Migration {
  readonly version: number;
  readonly statements: ReadonlyArray<string>;
}

export const MIGRATION_LEDGER = "schema_migrations";

export const LAYOUT_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE sign_in_links (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT`,
      "CREATE INDEX sign_in_links_by_email ON sign_in_links (email, expires_at)",
      "CREATE INDEX sign_in_links_by_expiry ON sign_in_links (expires_at)",
      `CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT`,
      "CREATE INDEX sessions_by_account ON sessions (account_id)",
      "CREATE INDEX sessions_by_expiry ON sessions (expires_at)",
      `CREATE TABLE worlds (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        head INTEGER
      ) STRICT`,
      "CREATE INDEX worlds_by_owner ON worlds (owner_id, updated_at)",
      `CREATE TABLE world_shards (
        world_id TEXT NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (world_id, sha256)
      ) STRICT, WITHOUT ROWID`,
      `CREATE TABLE world_imports (
        world_id TEXT NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (world_id, sha256)
      ) STRICT, WITHOUT ROWID`,
      `CREATE TABLE world_snapshots (
        world_id TEXT NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (world_id, sha256)
      ) STRICT, WITHOUT ROWID`,
      `CREATE TABLE world_versions (
        world_id TEXT NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        parent INTEGER,
        snapshot_sha256 TEXT NOT NULL,
        name TEXT NOT NULL,
        placements INTEGER NOT NULL,
        track INTEGER NOT NULL,
        saved_by TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        PRIMARY KEY (world_id, version),
        FOREIGN KEY (world_id, snapshot_sha256) REFERENCES world_snapshots (world_id, sha256)
      ) STRICT, WITHOUT ROWID`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE share_links (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES worlds (id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`,
      "CREATE INDEX share_links_by_world ON share_links (world_id, created_at)",
    ],
  },
];
