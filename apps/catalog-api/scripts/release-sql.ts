import { ReleaseRow, type ReleaseCounts } from "@brr/schema/catalog-api";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CURRENT_RELEASE_TABLE,
  MODULE_KIND,
  RELEASES_TABLE,
  SET_KIND,
  THEME_COUNT_COLUMNS,
  dropRelease,
  metadataSchema,
  releaseIndexes,
  releaseSchema,
  releaseSearchIndex,
  releaseTableEntries,
  releaseTableSpecs,
  releaseTables,
  type ReleaseTable,
} from "../src/release-schema.ts";

export const MAX_STATEMENT_BYTES = 90_000;

function sourceColumns(table: ReleaseTable): ReadonlyArray<string> {
  const columns = Object.keys(releaseTableSpecs[table].columns);
  return table === "themes"
    ? columns.filter((column) => !THEME_COUNT_COLUMNS.includes(column))
    : columns;
}

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
  return releaseTableEntries().flatMap(([source]) => {
    const columns = sourceColumns(source);
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

export function releaseCounts(db: DatabaseSync): ReleaseCounts {
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
  release: ReleaseRow,
  promote: boolean,
): Generator<string> {
  const tables = releaseTables(release.id);
  yield* metadataSchema();
  yield* dropRelease(release.id);
  yield* releaseSchema(release.id);
  for (const [table, spec] of releaseTableEntries()) {
    if (table === "themes") {
      yield* batchedInserts(tables.themes, Object.keys(spec.columns), themesWithCounts(db));
      continue;
    }
    const columns = sourceColumns(table);
    const rows = db
      .prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${spec.order}`)
      .iterate();
    yield* batchedInserts(
      tables[table],
      columns,
      mapRows(rows, (row) => columns.map((column) => row[column] ?? null)),
    );
  }
  yield* releaseIndexes(release.id);
  yield* releaseSearchIndex(release.id);
  const row = decodedOrThrow(decode(ReleaseRow, release), RELEASES_TABLE);
  const columns = Object.keys(row);
  const updates = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`);
  yield `INSERT INTO ${RELEASES_TABLE}(${columns.join(", ")}) VALUES (${Object.values(row)
    .map(sqlLiteral)
    .join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`;
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
    .prepare(`SELECT ${sourceColumns("themes").join(", ")} FROM themes ORDER BY id`)
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
