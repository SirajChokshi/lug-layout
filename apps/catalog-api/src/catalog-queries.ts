import type { D1Cost } from "./http.ts";
import { MODULE_KIND, MODULE_KIND_TOKEN, SET_KIND_TOKEN, releaseTables } from "./release-schema.ts";
import { MIN_PREFIX_LENGTH, type SearchKind } from "./routes.ts";

export type CatalogReader = Pick<D1DatabaseSession, "prepare" | "batch">;

export interface ThemeRef {
  readonly id: number;
  readonly path: string;
}

export interface SetSummary {
  readonly id: string;
  readonly kind: "set" | "module";
  readonly name: string;
  readonly year: number | null;
  readonly numParts: number | null;
  readonly theme: ThemeRef | null;
  readonly author: string | null;
  readonly footprint: string | null;
  readonly tags: ReadonlyArray<string>;
}

export interface PartSummary {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}

export interface SearchHits {
  readonly set?: ReadonlyArray<SetSummary>;
  readonly module?: ReadonlyArray<SetSummary>;
  readonly part?: ReadonlyArray<PartSummary>;
}

export interface InventoryLot {
  readonly part: { readonly id: string; readonly name: string };
  readonly color: {
    readonly id: number;
    readonly name: string | null;
    readonly rgb: string | null;
    readonly isTransparent: boolean;
  };
  readonly quantity: number;
  readonly isSpare: boolean;
}

export interface InventoryMinifig {
  readonly id: string;
  readonly name: string;
  readonly numParts: number | null;
  readonly quantity: number;
}

export interface SetInventory {
  readonly set: SetSummary & { readonly description: string | null };
  readonly lots: ReadonlyArray<InventoryLot>;
  readonly minifigs: ReadonlyArray<InventoryMinifig>;
}

export interface ThemeNode {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly parentId: number | null;
  readonly setCount: number;
  readonly moduleCount: number;
}

export interface ThemePage {
  readonly theme: ThemeNode;
  readonly children: ReadonlyArray<ThemeNode>;
  readonly sets: ReadonlyArray<SetSummary>;
}

export interface Measured<T> {
  readonly value: T;
  readonly cost: D1Cost;
}

interface SetRow {
  readonly set_num: string;
  readonly name: string;
  readonly year: number | null;
  readonly num_parts: number | null;
  readonly kind: number;
  readonly theme_id: number | null;
  readonly theme_path: string | null;
  readonly author: string | null;
  readonly footprint: string | null;
  readonly tags: string | null;
  readonly description: string | null;
}

interface PartRow {
  readonly part_num: string;
  readonly name: string;
  readonly category: string | null;
}

interface LotRow {
  readonly part_num: string;
  readonly part_name: string;
  readonly color_id: number;
  readonly color_name: string | null;
  readonly rgb: string | null;
  readonly is_trans: number | null;
  readonly quantity: number;
  readonly is_spare: number;
}

interface MinifigRow {
  readonly fig_num: string;
  readonly name: string;
  readonly num_parts: number | null;
  readonly quantity: number;
}

interface ThemeRow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly parent_id: number | null;
  readonly set_count: number;
  readonly module_count: number;
}

const setColumns = (sets: string, themes: string): string =>
  `${sets}.set_num, ${sets}.name, ${sets}.year, ${sets}.num_parts, ${sets}.kind, ${sets}.theme_id, ${themes}.path AS theme_path, ${sets}.author, ${sets}.footprint, ${sets}.tags, ${sets}.description`;

const themeColumns = "id, name, path, parent_id, set_count, module_count";

export function ftsMatchExpression(tokens: ReadonlyArray<string>): string {
  return tokens
    .map((token, index) => {
      const phrase = `"${token.replaceAll('"', '""')}"`;
      const typing = index === tokens.length - 1 && token.length >= MIN_PREFIX_LENGTH;
      return typing ? `${phrase}*` : phrase;
    })
    .join(" ");
}

export async function searchCatalog(
  db: CatalogReader,
  release: string,
  tokens: ReadonlyArray<string>,
  kinds: ReadonlyArray<SearchKind>,
  limit: number,
): Promise<Measured<SearchHits>> {
  const t = releaseTables(release);
  const text = ftsMatchExpression(tokens);
  const statements = kinds.map((kind) => {
    switch (kind) {
      case "set":
      case "module":
        return db
          .prepare(
            `WITH hits AS (SELECT rowid AS id, rank FROM ${t.setsFts} WHERE ${t.setsFts} MATCH ?1 ORDER BY rank LIMIT ?2) SELECT ${setColumns("s", "th")} FROM hits JOIN ${t.sets} s ON s.id = hits.id LEFT JOIN ${t.themes} th ON th.id = s.theme_id ORDER BY hits.rank`,
          )
          .bind(
            `{kind} : "${kind === "set" ? SET_KIND_TOKEN : MODULE_KIND_TOKEN}" AND {name theme} : (${text})`,
            limit,
          );
      case "part":
        return db
          .prepare(
            `WITH hits AS (SELECT rowid AS id, rank FROM ${t.partsFts} WHERE ${t.partsFts} MATCH ?1 ORDER BY rank LIMIT ?2) SELECT p.part_num, p.name, c.name AS category FROM hits JOIN ${t.parts} p ON p.id = hits.id LEFT JOIN ${t.partCategories} c ON c.id = p.cat_id ORDER BY hits.rank`,
          )
          .bind(text, limit);
      default: {
        const exhaustive: never = kind;
        throw new Error(`unhandled search kind ${String(exhaustive)}`);
      }
    }
  });
  const results = await db.batch(statements);
  const hits: Record<string, ReadonlyArray<SetSummary> | ReadonlyArray<PartSummary>> = {};
  kinds.forEach((kind, index) => {
    const rows = results[index]?.results ?? [];
    hits[kind] =
      kind === "part"
        ? (rows as ReadonlyArray<PartRow>).map(toPartSummary)
        : (rows as ReadonlyArray<SetRow>).map(toSetSummary);
  });
  return { value: hits as SearchHits, cost: costOf(results) };
}

export async function setInventory(
  db: CatalogReader,
  release: string,
  setNum: string,
): Promise<Measured<SetInventory | undefined>> {
  const t = releaseTables(release);
  const results = await db.batch([
    db
      .prepare(
        `SELECT ${setColumns("s", "th")} FROM ${t.sets} s LEFT JOIN ${t.themes} th ON th.id = s.theme_id WHERE s.set_num = ?1`,
      )
      .bind(setNum),
    db
      .prepare(
        `SELECT p.part_num, p.name AS part_name, ip.color_id, c.name AS color_name, c.rgb, c.is_trans, ip.quantity, ip.is_spare FROM ${t.sets} s JOIN ${t.inventoryParts} ip ON ip.inventory_id = s.id JOIN ${t.parts} p ON p.id = ip.part_id LEFT JOIN ${t.colors} c ON c.id = ip.color_id WHERE s.set_num = ?1 ORDER BY ip.is_spare, p.part_num, ip.color_id`,
      )
      .bind(setNum),
    db
      .prepare(
        `SELECT m.fig_num, m.name, m.num_parts, im.quantity FROM ${t.sets} s JOIN ${t.inventoryMinifigs} im ON im.inventory_id = s.id JOIN ${t.minifigs} m ON m.id = im.minifig_id WHERE s.set_num = ?1 ORDER BY m.fig_num`,
      )
      .bind(setNum),
  ]);
  const cost = costOf(results);
  const setRow = (results[0]?.results as ReadonlyArray<SetRow> | undefined)?.[0];
  if (setRow === undefined) return { value: undefined, cost };
  const lots = (results[1]?.results ?? []) as ReadonlyArray<LotRow>;
  const minifigs = (results[2]?.results ?? []) as ReadonlyArray<MinifigRow>;
  return {
    value: {
      set: { ...toSetSummary(setRow), description: setRow.description },
      lots: lots.map((row) => ({
        part: { id: row.part_num, name: row.part_name },
        color: {
          id: row.color_id,
          name: row.color_name,
          rgb: row.rgb,
          isTransparent: row.is_trans === 1,
        },
        quantity: row.quantity,
        isSpare: row.is_spare === 1,
      })),
      minifigs: minifigs.map((row) => ({
        id: row.fig_num,
        name: row.name,
        numParts: row.num_parts,
        quantity: row.quantity,
      })),
    },
    cost,
  };
}

export async function themeRoots(
  db: CatalogReader,
  release: string,
): Promise<Measured<ReadonlyArray<ThemeNode>>> {
  const t = releaseTables(release);
  const results = await db.batch([
    db.prepare(`SELECT ${themeColumns} FROM ${t.themes} WHERE parent_id IS NULL ORDER BY name, id`),
  ]);
  const rows = (results[0]?.results ?? []) as ReadonlyArray<ThemeRow>;
  return { value: rows.map(toThemeNode), cost: costOf(results) };
}

export async function themePage(
  db: CatalogReader,
  release: string,
  themeId: number,
  limit: number,
  offset: number,
): Promise<Measured<ThemePage | undefined>> {
  const t = releaseTables(release);
  const results = await db.batch([
    db.prepare(`SELECT ${themeColumns} FROM ${t.themes} WHERE id = ?1`).bind(themeId),
    db
      .prepare(`SELECT ${themeColumns} FROM ${t.themes} WHERE parent_id = ?1 ORDER BY name, id`)
      .bind(themeId),
    db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION ALL SELECT child.id FROM ${t.themes} child JOIN subtree ON child.parent_id = subtree.id) SELECT ${setColumns("s", "th")} FROM subtree JOIN ${t.sets} s INDEXED BY ${t.setsByThemeYear} ON s.theme_id = subtree.id JOIN ${t.themes} th ON th.id = s.theme_id ORDER BY s.year DESC, s.set_num LIMIT ?2 OFFSET ?3`,
      )
      .bind(themeId, limit, offset),
  ]);
  const cost = costOf(results);
  const theme = (results[0]?.results as ReadonlyArray<ThemeRow> | undefined)?.[0];
  if (theme === undefined) return { value: undefined, cost };
  return {
    value: {
      theme: toThemeNode(theme),
      children: ((results[1]?.results ?? []) as ReadonlyArray<ThemeRow>).map(toThemeNode),
      sets: ((results[2]?.results ?? []) as ReadonlyArray<SetRow>).map(toSetSummary),
    },
    cost,
  };
}

function toSetSummary(row: SetRow): SetSummary {
  return {
    id: row.set_num,
    kind: row.kind === MODULE_KIND ? "module" : "set",
    name: row.name,
    year: row.year,
    numParts: row.num_parts,
    theme:
      row.theme_id === null || row.theme_path === null
        ? null
        : { id: row.theme_id, path: row.theme_path },
    author: row.author,
    footprint: row.footprint,
    tags: row.tags === null || row.tags === "" ? [] : row.tags.split(","),
  };
}

function toPartSummary(row: PartRow): PartSummary {
  return { id: row.part_num, name: row.name, category: row.category ?? "" };
}

function toThemeNode(row: ThemeRow): ThemeNode {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    parentId: row.parent_id,
    setCount: row.set_count,
    moduleCount: row.module_count,
  };
}

function costOf(results: ReadonlyArray<D1Result>): D1Cost {
  return results.reduce<D1Cost>(
    (total, result) => ({
      durationMs: total.durationMs + result.meta.duration,
      rowsRead: total.rowsRead + result.meta.rows_read,
    }),
    { durationMs: 0, rowsRead: 0 },
  );
}
