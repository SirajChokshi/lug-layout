import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CURRENT_RELEASE_TABLE,
  MODULE_KIND,
  RELEASES_TABLE,
  SET_KIND,
  dropRelease,
  metadataSchema,
  releaseIndexes,
  releaseSchema,
  releaseSearchIndex,
  releaseTables,
  type ReleaseTables,
} from "../src/release-schema.ts";

export const MAX_STATEMENT_BYTES = 90_000;

export interface ReleaseFile {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly objectKey: string;
  readonly source: string;
  readonly loadedAt: string;
}

interface CopiedTable {
  readonly source: string;
  readonly target: keyof ReleaseTables;
  readonly columns: ReadonlyArray<string>;
  readonly order: string;
}

const copiedTables: ReadonlyArray<CopiedTable> = [
  {
    source: "sets",
    target: "sets",
    columns: [
      "id",
      "set_num",
      "name",
      "year",
      "theme_id",
      "num_parts",
      "kind",
      "author",
      "description",
      "tags",
      "footprint",
    ],
    order: "id",
  },
  { source: "colors", target: "colors", columns: ["id", "name", "rgb", "is_trans"], order: "id" },
  { source: "part_categories", target: "partCategories", columns: ["id", "name"], order: "id" },
  {
    source: "parts",
    target: "parts",
    columns: ["id", "part_num", "name", "cat_id", "material"],
    order: "id",
  },
  {
    source: "minifigs",
    target: "minifigs",
    columns: ["id", "fig_num", "name", "num_parts"],
    order: "id",
  },
  {
    source: "inventory_parts",
    target: "inventoryParts",
    columns: ["inventory_id", "part_id", "color_id", "is_spare", "quantity"],
    order: "inventory_id, part_id, color_id, is_spare",
  },
  {
    source: "inventory_minifigs",
    target: "inventoryMinifigs",
    columns: ["inventory_id", "minifig_id", "quantity"],
    order: "inventory_id, minifig_id",
  },
];

const themeColumns = ["id", "name", "parent_id", "path"] as const;

export function releaseProblems(db: DatabaseSync): ReadonlyArray<string> {
  const schema = sourceSchemaProblems(db);
  if (schema.length > 0) return schema;
  const modules = Number(
    db.prepare(`SELECT count(*) AS n FROM sets WHERE kind = ${MODULE_KIND}`).get()?.["n"] ?? 0,
  );
  const unknownKinds = Number(
    db
      .prepare(`SELECT count(*) AS n FROM sets WHERE kind NOT IN (${SET_KIND}, ${MODULE_KIND})`)
      .get()?.["n"] ?? 0,
  );
  return [
    ...(modules > 0
      ? [
          `release has ${modules} module rows; modules are refused until the release build imports real module data`,
        ]
      : []),
    ...(unknownKinds > 0 ? [`release has ${unknownKinds} sets of unknown kind`] : []),
  ];
}

function sourceSchemaProblems(db: DatabaseSync): ReadonlyArray<string> {
  const expected = [
    { source: "themes", columns: [...themeColumns] },
    ...copiedTables.map(({ source, columns }) => ({ source, columns: [...columns] })),
  ];
  return expected.flatMap(({ source, columns }) => {
    const present = new Set(
      db
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(source)
        .map((row) => String(row["name"])),
    );
    if (present.size === 0) return [`release is missing table ${source}`];
    return columns
      .filter((column) => !present.has(column))
      .map((column) => `release table ${source} is missing column ${column}`);
  });
}

export function releaseCounts(db: DatabaseSync): Readonly<Record<string, number>> {
  const count = (sql: string): number => Number(db.prepare(sql).get()?.["n"] ?? 0);
  return {
    sets: count(`SELECT count(*) AS n FROM sets WHERE kind = ${SET_KIND}`),
    modules: count(`SELECT count(*) AS n FROM sets WHERE kind = ${MODULE_KIND}`),
    themes: count("SELECT count(*) AS n FROM themes"),
    parts: count("SELECT count(*) AS n FROM parts"),
    colors: count("SELECT count(*) AS n FROM colors"),
    minifigs: count("SELECT count(*) AS n FROM minifigs"),
    inventoryLots: count("SELECT count(*) AS n FROM inventory_parts"),
    inventoryMinifigs: count("SELECT count(*) AS n FROM inventory_minifigs"),
  };
}

export function* releaseStatements(
  db: DatabaseSync,
  release: ReleaseFile,
  promote: boolean,
): Generator<string> {
  const tables = releaseTables(release.id);
  yield* metadataSchema();
  yield* dropRelease(release.id);
  yield* releaseSchema(release.id);
  yield* batchedInserts(
    tables.themes,
    [...themeColumns, "set_count", "module_count"],
    themesWithCounts(db),
  );
  for (const table of copiedTables) {
    const rows = db
      .prepare(`SELECT ${table.columns.join(", ")} FROM ${table.source} ORDER BY ${table.order}`)
      .iterate();
    yield* batchedInserts(
      tables[table.target],
      table.columns,
      mapRows(rows, (row) => table.columns.map((column) => row[column] ?? null)),
    );
  }
  yield* releaseIndexes(release.id);
  yield* releaseSearchIndex(release.id);
  const counts = JSON.stringify(releaseCounts(db));
  yield `INSERT INTO ${RELEASES_TABLE}(id, sha256, bytes, object_key, source, loaded_at, counts) VALUES (${[
    release.id,
    release.sha256,
    release.bytes,
    release.objectKey,
    release.source,
    release.loadedAt,
    counts,
  ]
    .map(sqlLiteral)
    .join(
      ", ",
    )}) ON CONFLICT(id) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, object_key = excluded.object_key, source = excluded.source, loaded_at = excluded.loaded_at, counts = excluded.counts`;
  if (promote) {
    yield `INSERT INTO ${CURRENT_RELEASE_TABLE}(slot, release_id) VALUES ('current', ${sqlLiteral(release.id)}) ON CONFLICT(slot) DO UPDATE SET release_id = excluded.release_id`;
  }
}

export function sqlLiteral(value: SQLInputValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`unsupported SQL value of type ${typeof value}`);
}

function* themesWithCounts(db: DatabaseSync): Generator<ReadonlyArray<SQLInputValue>> {
  const themes = db
    .prepare(`SELECT ${themeColumns.join(", ")} FROM themes ORDER BY id`)
    .all()
    .map((row) => ({
      id: Number(row["id"]),
      name: String(row["name"]),
      parentId: row["parent_id"] === null ? null : Number(row["parent_id"]),
      path: String(row["path"]),
    }));
  const parentOf = new Map(themes.map((theme) => [theme.id, theme.parentId]));
  const setCounts = new Map<number, number>();
  const moduleCounts = new Map<number, number>();
  for (const row of db.prepare("SELECT theme_id, kind FROM sets").iterate()) {
    const counts = Number(row["kind"]) === MODULE_KIND ? moduleCounts : setCounts;
    let theme: number | null | undefined =
      row["theme_id"] === null ? null : Number(row["theme_id"]);
    while (theme !== null && theme !== undefined) {
      counts.set(theme, (counts.get(theme) ?? 0) + 1);
      theme = parentOf.get(theme);
    }
  }
  for (const theme of themes) {
    yield [
      theme.id,
      theme.name,
      theme.parentId,
      theme.path,
      setCounts.get(theme.id) ?? 0,
      moduleCounts.get(theme.id) ?? 0,
    ];
  }
}

function* mapRows<T>(
  rows: Iterable<Record<string, SQLInputValue>>,
  map: (row: Record<string, SQLInputValue>) => T,
): Generator<T> {
  for (const row of rows) yield map(row);
}

function* batchedInserts(
  table: string,
  columns: ReadonlyArray<string>,
  rows: Iterable<ReadonlyArray<SQLInputValue>>,
): Generator<string> {
  const head = `INSERT INTO ${table}(${columns.join(", ")}) VALUES `;
  const headBytes = Buffer.byteLength(head);
  let tuples: string[] = [];
  let bytes = headBytes;
  for (const row of rows) {
    const tuple = `(${row.map(sqlLiteral).join(",")})`;
    const tupleBytes = Buffer.byteLength(tuple) + 1;
    if (headBytes + tupleBytes > MAX_STATEMENT_BYTES) {
      throw new Error(
        `a row of ${table} does not fit in one ${MAX_STATEMENT_BYTES}-byte statement`,
      );
    }
    if (bytes + tupleBytes > MAX_STATEMENT_BYTES) {
      yield head + tuples.join(",");
      tuples = [];
      bytes = headBytes;
    }
    tuples.push(tuple);
    bytes += tupleBytes;
  }
  if (tuples.length > 0) yield head + tuples.join(",");
}
