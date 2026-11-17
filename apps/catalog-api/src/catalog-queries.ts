import type {
  InventoryResponse,
  PartSummary,
  SearchKind,
  SearchResponse,
  SetSummary,
  ThemeNode,
  ThemePageResponse,
  ThemeRootsResponse,
} from "@brr/schema/catalog-api";
import { MIN_PREFIX_LETTERS } from "@brr/schema/catalog-api";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import * as v from "valibot";
import type { D1Cost } from "./http.ts";
import {
  ColorRow,
  InventoryMinifigRow,
  InventoryPartRow,
  MinifigRow,
  MODULE_KIND,
  MODULE_KIND_TOKEN,
  PartCategoryRow,
  PartRow,
  SET_KIND_TOKEN,
  SetRow,
  ThemeRow,
  releaseTables,
} from "./release-schema.ts";
import { inventoryHref, themeHref } from "./routes.ts";

export type CatalogReader = Pick<D1DatabaseSession, "prepare" | "batch">;

export interface Measured<T> {
  readonly value: T;
  readonly cost: D1Cost;
}

const SET_SUMMARY_COLUMNS = [
  "set_num",
  "name",
  "year",
  "num_parts",
  "kind",
  "theme_id",
  "author",
  "footprint",
  "tags",
  "description",
] as const;

const SetSummaryRow = v.object({
  ...v.pick(SetRow, SET_SUMMARY_COLUMNS).entries,
  theme_path: v.nullable(ThemeRow.entries.path),
});

const PartHitRow = v.object({
  ...v.pick(PartRow, ["part_num", "name"]).entries,
  category: v.nullable(PartCategoryRow.entries.name),
});

const LotRow = v.object({
  part_num: PartRow.entries.part_num,
  part_name: PartRow.entries.name,
  color_id: InventoryPartRow.entries.color_id,
  color_name: v.nullable(ColorRow.entries.name),
  rgb: ColorRow.entries.rgb,
  is_trans: ColorRow.entries.is_trans,
  quantity: InventoryPartRow.entries.quantity,
  is_spare: InventoryPartRow.entries.is_spare,
});

const MinifigLotRow = v.object({
  ...v.pick(MinifigRow, ["fig_num", "name", "num_parts"]).entries,
  quantity: InventoryMinifigRow.entries.quantity,
});

const setColumns = (sets: string, themes: string): string =>
  [
    ...SET_SUMMARY_COLUMNS.map((column) => `${sets}.${column}`),
    `${themes}.path AS theme_path`,
  ].join(", ");

const themeColumns = Object.keys(ThemeRow.entries).join(", ");

function rowsOf<const TRow extends v.GenericSchema>(
  row: TRow,
  result: D1Result | undefined,
  label: string,
): ReadonlyArray<v.InferOutput<TRow>> {
  return decodedOrThrow(decode(v.array(row), result?.results ?? []), label);
}

export function ftsMatchExpression(tokens: ReadonlyArray<string>): string {
  return tokens
    .map((token, index) => {
      const phrase = `"${token.replaceAll('"', '""')}"`;
      const typing = index === tokens.length - 1 && token.length >= MIN_PREFIX_LETTERS;
      return typing ? `${phrase}*` : phrase;
    })
    .join(" ");
}

export async function searchCatalog(
  db: CatalogReader,
  origin: string,
  release: string,
  tokens: ReadonlyArray<string>,
  kinds: ReadonlyArray<SearchKind>,
  limit: number,
): Promise<Measured<v.InferInput<typeof SearchResponse>["results"]>> {
  const t = releaseTables(release);
  const text = ftsMatchExpression(tokens);
  const statements = kinds.map((kind) => {
    switch (kind) {
      case "set":
      case "module":
        return db
          .prepare(
            `WITH hits AS (SELECT rowid AS id, rank FROM ${t.sets_fts} WHERE ${t.sets_fts} MATCH ?1 ORDER BY rank LIMIT ?2) SELECT ${setColumns("s", "th")} FROM hits JOIN ${t.sets} s ON s.id = hits.id LEFT JOIN ${t.themes} th ON th.id = s.theme_id ORDER BY hits.rank`,
          )
          .bind(
            `{kind} : "${kind === "set" ? SET_KIND_TOKEN : MODULE_KIND_TOKEN}" AND {name theme} : (${text})`,
            limit,
          );
      case "part":
        return db
          .prepare(
            `WITH hits AS (SELECT rowid AS id, rank FROM ${t.parts_fts} WHERE ${t.parts_fts} MATCH ?1 ORDER BY rank LIMIT ?2) SELECT p.part_num, p.name, c.name AS category FROM hits JOIN ${t.parts} p ON p.id = hits.id LEFT JOIN ${t.part_categories} c ON c.id = p.cat_id ORDER BY hits.rank`,
          )
          .bind(text, limit);
      default: {
        const exhaustive: never = kind;
        throw new Error(`unhandled search kind ${String(exhaustive)}`);
      }
    }
  });
  const results = await db.batch(statements);
  const resultOf = (kind: SearchKind): D1Result | undefined =>
    kinds.includes(kind) ? results[kinds.indexOf(kind)] : undefined;
  const setsOf = (kind: "set" | "module") =>
    kinds.includes(kind)
      ? rowsOf(SetSummaryRow, resultOf(kind), `${kind} search`).map((row) =>
          toSetSummary(origin, release, row),
        )
      : undefined;
  const sets = setsOf("set");
  const modules = setsOf("module");
  const parts = kinds.includes("part")
    ? rowsOf(PartHitRow, resultOf("part"), "part search").map(toPartSummary)
    : undefined;
  return {
    value: {
      ...(sets === undefined ? {} : { set: sets }),
      ...(modules === undefined ? {} : { module: modules }),
      ...(parts === undefined ? {} : { part: parts }),
    },
    cost: costOf(results),
  };
}

export async function setInventory(
  db: CatalogReader,
  origin: string,
  release: string,
  setNum: string,
): Promise<Measured<v.InferInput<typeof InventoryResponse> | undefined>> {
  const t = releaseTables(release);
  const results = await db.batch([
    db
      .prepare(
        `SELECT ${setColumns("s", "th")} FROM ${t.sets} s LEFT JOIN ${t.themes} th ON th.id = s.theme_id WHERE s.set_num = ?1`,
      )
      .bind(setNum),
    db
      .prepare(
        `SELECT p.part_num, p.name AS part_name, ip.color_id, c.name AS color_name, c.rgb, c.is_trans, ip.quantity, ip.is_spare FROM ${t.sets} s JOIN ${t.inventory_parts} ip ON ip.inventory_id = s.id JOIN ${t.parts} p ON p.id = ip.part_id LEFT JOIN ${t.colors} c ON c.id = ip.color_id WHERE s.set_num = ?1 ORDER BY ip.is_spare, p.part_num, ip.color_id`,
      )
      .bind(setNum),
    db
      .prepare(
        `SELECT m.fig_num, m.name, m.num_parts, im.quantity FROM ${t.sets} s JOIN ${t.inventory_minifigs} im ON im.inventory_id = s.id JOIN ${t.minifigs} m ON m.id = im.minifig_id WHERE s.set_num = ?1 ORDER BY m.fig_num`,
      )
      .bind(setNum),
  ]);
  const cost = costOf(results);
  const [setRow] = rowsOf(SetSummaryRow, results[0], "inventory set");
  if (setRow === undefined) return { value: undefined, cost };
  const lots = rowsOf(LotRow, results[1], "inventory lots").map((row) => ({
    part: { id: row.part_num, name: row.part_name },
    color: {
      id: row.color_id,
      name: row.color_name,
      rgb: row.rgb,
      isTransparent: row.is_trans === 1,
    },
    quantity: row.quantity,
    isSpare: row.is_spare === 1,
  }));
  const minifigs = rowsOf(MinifigLotRow, results[2], "inventory minifigs").map((row) => ({
    id: row.fig_num,
    name: row.name,
    numParts: row.num_parts,
    quantity: row.quantity,
  }));
  const regular = lots.filter((lot) => !lot.isSpare);
  return {
    value: {
      release,
      set: { ...toSetSummary(origin, release, setRow), description: setRow.description },
      totals: {
        lots: regular.length,
        parts: regular.reduce((sum, lot) => sum + lot.quantity, 0),
        spareLots: lots.length - regular.length,
        minifigs: minifigs.reduce((sum, fig) => sum + fig.quantity, 0),
      },
      lots,
      minifigs,
    },
    cost,
  };
}

export async function themeRoots(
  db: CatalogReader,
  origin: string,
  release: string,
): Promise<Measured<v.InferInput<typeof ThemeRootsResponse>>> {
  const t = releaseTables(release);
  const results = await db.batch([
    db.prepare(`SELECT ${themeColumns} FROM ${t.themes} WHERE parent_id IS NULL ORDER BY name, id`),
  ]);
  const rows = rowsOf(ThemeRow, results[0], "theme roots");
  return {
    value: { release, themes: rows.map((row) => toThemeNode(origin, release, row)) },
    cost: costOf(results),
  };
}

export async function themePage(
  db: CatalogReader,
  origin: string,
  release: string,
  themeId: number,
  limit: number,
  offset: number,
): Promise<Measured<v.InferInput<typeof ThemePageResponse> | undefined>> {
  const t = releaseTables(release);
  const results = await db.batch([
    db.prepare(`SELECT ${themeColumns} FROM ${t.themes} WHERE id = ?1`).bind(themeId),
    db
      .prepare(`SELECT ${themeColumns} FROM ${t.themes} WHERE parent_id = ?1 ORDER BY name, id`)
      .bind(themeId),
    db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION ALL SELECT child.id FROM ${t.themes} child JOIN subtree ON child.parent_id = subtree.id) SELECT ${setColumns("s", "th")} FROM subtree JOIN ${t.sets} s INDEXED BY ${t.sets_theme_year} ON s.theme_id = subtree.id JOIN ${t.themes} th ON th.id = s.theme_id ORDER BY s.year DESC, s.set_num LIMIT ?2 OFFSET ?3`,
      )
      .bind(themeId, limit, offset),
  ]);
  const cost = costOf(results);
  const [theme] = rowsOf(ThemeRow, results[0], "theme");
  if (theme === undefined) return { value: undefined, cost };
  const total = theme.set_count + theme.module_count;
  const nextOffset = offset + limit;
  return {
    value: {
      release,
      theme: toThemeNode(origin, release, theme),
      children: rowsOf(ThemeRow, results[1], "theme children").map((row) =>
        toThemeNode(origin, release, row),
      ),
      sets: rowsOf(SetSummaryRow, results[2], "theme sets").map((row) =>
        toSetSummary(origin, release, row),
      ),
      page: {
        limit,
        offset,
        total,
        next:
          nextOffset < total
            ? `${themeHref(origin, release, themeId)}?limit=${limit}&offset=${nextOffset}`
            : null,
      },
    },
    cost,
  };
}

function toSetSummary(
  origin: string,
  release: string,
  row: v.InferOutput<typeof SetSummaryRow>,
): v.InferInput<typeof SetSummary> {
  return {
    id: row.set_num,
    kind: row.kind === MODULE_KIND ? "module" : "set",
    name: row.name,
    year: row.year,
    numParts: row.num_parts,
    theme:
      row.theme_id === null || row.theme_path === null
        ? null
        : {
            id: row.theme_id,
            path: row.theme_path,
            href: themeHref(origin, release, row.theme_id),
          },
    author: row.author,
    footprint: row.footprint,
    tags: row.tags === null || row.tags === "" ? [] : row.tags.split(","),
    href: inventoryHref(origin, release, row.set_num),
  };
}

function toPartSummary(row: v.InferOutput<typeof PartHitRow>): v.InferInput<typeof PartSummary> {
  return { id: row.part_num, name: row.name, category: row.category ?? "" };
}

function toThemeNode(
  origin: string,
  release: string,
  row: ThemeRow,
): v.InferInput<typeof ThemeNode> {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    parentId: row.parent_id,
    setCount: row.set_count,
    moduleCount: row.module_count,
    href: themeHref(origin, release, row.id),
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
