export const RELEASE_ID_PATTERN = /^[0-9a-f]{16}$/;
export const RELEASE_ID_HEX_LENGTH = 16;

export const RELEASES_TABLE = "catalog_releases";
export const CURRENT_RELEASE_TABLE = "catalog_current";

export const SET_KIND = 0;
export const MODULE_KIND = 1;
export const MINIFIG_INVENTORY_OFFSET = 1_000_000;

export const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

export interface ReleaseTables {
  readonly themes: string;
  readonly sets: string;
  readonly colors: string;
  readonly partCategories: string;
  readonly parts: string;
  readonly minifigs: string;
  readonly inventoryParts: string;
  readonly inventoryMinifigs: string;
  readonly setsFts: string;
  readonly partsFts: string;
  readonly themesByParent: string;
  readonly setsByThemeYear: string;
}

export function isReleaseId(value: string): boolean {
  return RELEASE_ID_PATTERN.test(value);
}

export function releaseTables(releaseId: string): ReleaseTables {
  if (!isReleaseId(releaseId)) throw new Error(`invalid catalog release id ${releaseId}`);
  const prefix = `r${releaseId}_`;
  return {
    themes: `${prefix}themes`,
    sets: `${prefix}sets`,
    colors: `${prefix}colors`,
    partCategories: `${prefix}part_categories`,
    parts: `${prefix}parts`,
    minifigs: `${prefix}minifigs`,
    inventoryParts: `${prefix}inventory_parts`,
    inventoryMinifigs: `${prefix}inventory_minifigs`,
    setsFts: `${prefix}sets_fts`,
    partsFts: `${prefix}parts_fts`,
    themesByParent: `${prefix}themes_parent`,
    setsByThemeYear: `${prefix}sets_theme_year`,
  };
}

export function releaseObjectKey(releaseId: string): string {
  return `catalog/${releaseId}/catalog.sqlite`;
}

export function metadataSchema(): ReadonlyArray<string> {
  return [
    `CREATE TABLE IF NOT EXISTS ${RELEASES_TABLE}(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, object_key TEXT NOT NULL, source TEXT NOT NULL, loaded_at TEXT NOT NULL, counts TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${CURRENT_RELEASE_TABLE}(slot TEXT PRIMARY KEY CHECK (slot = 'current'), release_id TEXT NOT NULL REFERENCES ${RELEASES_TABLE}(id))`,
  ];
}

export function releaseSchema(releaseId: string): ReadonlyArray<string> {
  const t = releaseTables(releaseId);
  return [
    `CREATE TABLE ${t.themes}(id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER, path TEXT NOT NULL, set_count INTEGER NOT NULL, module_count INTEGER NOT NULL)`,
    `CREATE TABLE ${t.sets}(id INTEGER PRIMARY KEY, set_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL, year INTEGER, theme_id INTEGER, num_parts INTEGER, kind INTEGER NOT NULL, author TEXT, description TEXT, tags TEXT, footprint TEXT)`,
    `CREATE TABLE ${t.colors}(id INTEGER PRIMARY KEY, name TEXT NOT NULL, rgb TEXT, is_trans INTEGER)`,
    `CREATE TABLE ${t.partCategories}(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
    `CREATE TABLE ${t.parts}(id INTEGER PRIMARY KEY, part_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL, cat_id INTEGER, material TEXT)`,
    `CREATE TABLE ${t.minifigs}(id INTEGER PRIMARY KEY, fig_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL, num_parts INTEGER)`,
    `CREATE TABLE ${t.inventoryParts}(inventory_id INTEGER NOT NULL, part_id INTEGER NOT NULL, color_id INTEGER NOT NULL, is_spare INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(inventory_id, part_id, color_id, is_spare)) WITHOUT ROWID`,
    `CREATE TABLE ${t.inventoryMinifigs}(inventory_id INTEGER NOT NULL, minifig_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(inventory_id, minifig_id)) WITHOUT ROWID`,
    `CREATE VIRTUAL TABLE ${t.setsFts} USING fts5(name, theme, content='', tokenize='${FTS_TOKENIZER}')`,
    `CREATE VIRTUAL TABLE ${t.partsFts} USING fts5(part_num, name, category, content='', tokenize='${FTS_TOKENIZER}')`,
  ];
}

export function releaseIndexes(releaseId: string): ReadonlyArray<string> {
  const t = releaseTables(releaseId);
  return [
    `CREATE INDEX ${t.themesByParent} ON ${t.themes}(parent_id)`,
    `CREATE INDEX ${t.setsByThemeYear} ON ${t.sets}(theme_id, year)`,
  ];
}

export function releaseSearchIndex(releaseId: string): ReadonlyArray<string> {
  const t = releaseTables(releaseId);
  return [
    `INSERT INTO ${t.setsFts}(rowid, name, theme) SELECT s.id, s.name, coalesce(th.path, '') FROM ${t.sets} s LEFT JOIN ${t.themes} th ON th.id = s.theme_id`,
    `INSERT INTO ${t.partsFts}(rowid, part_num, name, category) SELECT p.id, p.part_num, p.name, coalesce(c.name, '') FROM ${t.parts} p LEFT JOIN ${t.partCategories} c ON c.id = p.cat_id`,
    `INSERT INTO ${t.setsFts}(${t.setsFts}) VALUES('optimize')`,
    `INSERT INTO ${t.partsFts}(${t.partsFts}) VALUES('optimize')`,
  ];
}

export function dropRelease(releaseId: string): ReadonlyArray<string> {
  const t = releaseTables(releaseId);
  return [
    t.setsFts,
    t.partsFts,
    t.inventoryMinifigs,
    t.inventoryParts,
    t.minifigs,
    t.parts,
    t.partCategories,
    t.colors,
    t.sets,
    t.themes,
  ].map((table) => `DROP TABLE IF EXISTS ${table}`);
}
