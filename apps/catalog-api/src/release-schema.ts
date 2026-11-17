import {
  ColorRow,
  CurrentReleaseRow,
  InventoryMinifigRow,
  InventoryPartRow,
  MinifigRow,
  PartCategoryRow,
  PartRow,
  ReleaseId,
  ReleaseRow,
  SetRow,
  ThemeRow,
} from "@brr/schema/catalog-api";
import * as v from "valibot";

export const RELEASES_TABLE = "catalog_releases";
export const CURRENT_RELEASE_TABLE = "catalog_current";

export const SET_KIND = 0;
export const MODULE_KIND = 1;

export const FTS_TOKENIZER = "unicode61 remove_diacritics 2";
export const SET_KIND_TOKEN = "set";
export const MODULE_KIND_TOKEN = "module";
export const SETS_FTS_RANK = "bm25(1.0, 1.0, 0.0)";
export const THEME_COUNT_COLUMNS: ReadonlyArray<string> = ["set_count", "module_count"];

type NotNullSql<Type extends string> = `${Type} NOT NULL${string}` | `${Type} PRIMARY KEY${string}`;

type ColumnSql<Value> = null extends Value
  ? [Value] extends [number | null]
    ? "INTEGER"
    : "TEXT"
  : [Value] extends [number]
    ? NotNullSql<"INTEGER">
    : NotNullSql<"TEXT">;

type ColumnSpecs<Row> = { readonly [Column in keyof Row]-?: ColumnSql<Row[Column]> };

interface TableSpec {
  readonly columns: Readonly<Record<string, string>>;
  readonly primaryKey?: string;
  readonly order: string;
}

function tableSpec<const TRow extends v.GenericSchema>(
  _row: TRow,
  spec: {
    readonly columns: NoInfer<ColumnSpecs<v.InferOutput<TRow>>>;
    readonly primaryKey?: string;
    readonly order: string;
  },
): TableSpec {
  return spec;
}

export const releaseTableSpecs = {
  themes: tableSpec(ThemeRow, {
    columns: {
      id: "INTEGER PRIMARY KEY",
      name: "TEXT NOT NULL",
      parent_id: "INTEGER",
      path: "TEXT NOT NULL",
      set_count: "INTEGER NOT NULL",
      module_count: "INTEGER NOT NULL",
    },
    order: "id",
  }),
  sets: tableSpec(SetRow, {
    columns: {
      id: "INTEGER PRIMARY KEY",
      set_num: "TEXT NOT NULL UNIQUE",
      name: "TEXT NOT NULL",
      year: "INTEGER",
      theme_id: "INTEGER",
      num_parts: "INTEGER",
      kind: "INTEGER NOT NULL",
      author: "TEXT",
      description: "TEXT",
      tags: "TEXT",
      footprint: "TEXT",
    },
    order: "id",
  }),
  colors: tableSpec(ColorRow, {
    columns: { id: "INTEGER PRIMARY KEY", name: "TEXT NOT NULL", rgb: "TEXT", is_trans: "INTEGER" },
    order: "id",
  }),
  part_categories: tableSpec(PartCategoryRow, {
    columns: { id: "INTEGER PRIMARY KEY", name: "TEXT NOT NULL" },
    order: "id",
  }),
  parts: tableSpec(PartRow, {
    columns: {
      id: "INTEGER PRIMARY KEY",
      part_num: "TEXT NOT NULL UNIQUE",
      name: "TEXT NOT NULL",
      cat_id: "INTEGER",
      material: "TEXT",
    },
    order: "id",
  }),
  minifigs: tableSpec(MinifigRow, {
    columns: {
      id: "INTEGER PRIMARY KEY",
      fig_num: "TEXT NOT NULL UNIQUE",
      name: "TEXT NOT NULL",
      num_parts: "INTEGER",
    },
    order: "id",
  }),
  inventory_parts: tableSpec(InventoryPartRow, {
    columns: {
      inventory_id: "INTEGER NOT NULL",
      part_id: "INTEGER NOT NULL",
      color_id: "INTEGER NOT NULL",
      is_spare: "INTEGER NOT NULL",
      quantity: "INTEGER NOT NULL",
    },
    primaryKey: "inventory_id, part_id, color_id, is_spare",
    order: "inventory_id, part_id, color_id, is_spare",
  }),
  inventory_minifigs: tableSpec(InventoryMinifigRow, {
    columns: {
      inventory_id: "INTEGER NOT NULL",
      minifig_id: "INTEGER NOT NULL",
      quantity: "INTEGER NOT NULL",
    },
    primaryKey: "inventory_id, minifig_id",
    order: "inventory_id, minifig_id",
  }),
};

const metadataTableSpecs = {
  [RELEASES_TABLE]: tableSpec(ReleaseRow, {
    columns: {
      id: "TEXT PRIMARY KEY",
      sha256: "TEXT NOT NULL",
      bytes: "INTEGER NOT NULL",
      object_key: "TEXT NOT NULL",
      source: "TEXT NOT NULL",
      loaded_at: "TEXT NOT NULL",
      counts: "TEXT NOT NULL",
    },
    order: "id",
  }),
  [CURRENT_RELEASE_TABLE]: tableSpec(CurrentReleaseRow, {
    columns: {
      slot: "TEXT PRIMARY KEY CHECK (slot = 'current')",
      release_id: `TEXT NOT NULL REFERENCES ${RELEASES_TABLE}(id)`,
    },
    order: "slot",
  }),
};

export type ReleaseTable = keyof typeof releaseTableSpecs;

const derivedObjects = ["sets_fts", "parts_fts", "themes_parent", "sets_theme_year"] as const;

export type ReleaseTables = {
  readonly [Name in ReleaseTable | (typeof derivedObjects)[number]]: string;
};

export function releaseTableEntries(): ReadonlyArray<readonly [ReleaseTable, TableSpec]> {
  return Object.entries(releaseTableSpecs) as ReadonlyArray<[ReleaseTable, TableSpec]>;
}

export function releaseTables(release: string): ReleaseTables {
  if (!v.is(ReleaseId, release)) throw new Error(`invalid catalog release id ${release}`);
  const names = [...releaseTableEntries().map(([name]) => name), ...derivedObjects];
  return Object.fromEntries(names.map((name) => [name, `r${release}_${name}`])) as ReleaseTables;
}

export function releaseObjectKey(release: string): string {
  return `catalog/${release}/catalog.sqlite`;
}

function columnDefinitions(spec: TableSpec): string {
  return Object.entries(spec.columns)
    .map(([column, type]) => `${column} ${type}`)
    .join(", ");
}

export function metadataSchema(): ReadonlyArray<string> {
  return Object.entries(metadataTableSpecs).map(
    ([table, spec]) => `CREATE TABLE IF NOT EXISTS ${table}(${columnDefinitions(spec)})`,
  );
}

export function releaseSchema(release: string): ReadonlyArray<string> {
  const t = releaseTables(release);
  return [
    ...releaseTableEntries().map(([name, spec]) => {
      const columns = columnDefinitions(spec);
      if (spec.primaryKey === undefined) return `CREATE TABLE ${t[name]}(${columns})`;
      return `CREATE TABLE ${t[name]}(${columns}, PRIMARY KEY(${spec.primaryKey})) WITHOUT ROWID`;
    }),
    `CREATE VIRTUAL TABLE ${t.sets_fts} USING fts5(name, theme, kind, content='', tokenize='${FTS_TOKENIZER}')`,
    `CREATE VIRTUAL TABLE ${t.parts_fts} USING fts5(part_num, name, category, content='', tokenize='${FTS_TOKENIZER}')`,
  ];
}

export function releaseIndexes(release: string): ReadonlyArray<string> {
  const t = releaseTables(release);
  return [
    `CREATE INDEX ${t.themes_parent} ON ${t.themes}(parent_id)`,
    `CREATE INDEX ${t.sets_theme_year} ON ${t.sets}(theme_id, year)`,
  ];
}

export function releaseSearchIndex(release: string): ReadonlyArray<string> {
  const t = releaseTables(release);
  return [
    `INSERT INTO ${t.sets_fts}(rowid, name, theme, kind) SELECT s.id, s.name, coalesce(th.path, ''), CASE s.kind WHEN ${MODULE_KIND} THEN '${MODULE_KIND_TOKEN}' ELSE '${SET_KIND_TOKEN}' END FROM ${t.sets} s LEFT JOIN ${t.themes} th ON th.id = s.theme_id`,
    `INSERT INTO ${t.sets_fts}(${t.sets_fts}, rank) VALUES('rank', '${SETS_FTS_RANK}')`,
    `INSERT INTO ${t.parts_fts}(rowid, part_num, name, category) SELECT p.id, p.part_num, p.name, coalesce(c.name, '') FROM ${t.parts} p LEFT JOIN ${t.part_categories} c ON c.id = p.cat_id`,
    `INSERT INTO ${t.sets_fts}(${t.sets_fts}) VALUES('optimize')`,
    `INSERT INTO ${t.parts_fts}(${t.parts_fts}) VALUES('optimize')`,
  ];
}

export function dropRelease(release: string): ReadonlyArray<string> {
  const t = releaseTables(release);
  const tables = releaseTableEntries().map(([name]) => t[name]);
  return [t.sets_fts, t.parts_fts, ...tables.toReversed()].map(
    (table) => `DROP TABLE IF EXISTS ${table}`,
  );
}
