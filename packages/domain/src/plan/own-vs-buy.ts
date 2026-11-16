import type { CatalogLine } from "../bom/catalog-ids.ts";
import { brickLinkWantedListXml, rebrickableCsv } from "../bom/export-formats.ts";
import type { PlanBom, PlanBomEntry } from "./buildable.ts";

export interface OwnedLine {
  readonly part: string;
  readonly color: number;
  readonly quantity: number;
}

export interface PartsCollection {
  readonly name: string;
  readonly lines: ReadonlyArray<OwnedLine>;
  readonly parts: number;
}

export interface ParsedCollection {
  readonly collection: PartsCollection | null;
  readonly problems: ReadonlyArray<string>;
}

export interface OwnBuyLine {
  readonly entry: PlanBomEntry;
  readonly own: number;
  readonly buy: number;
}

export interface OwnBuy {
  readonly lines: ReadonlyArray<OwnBuyLine>;
  readonly ownParts: number;
  readonly buyParts: number;
}

export interface PlanFiles {
  readonly rebrickableCsv: string;
  readonly brickLinkXml: string;
  readonly plainCsv: string;
  readonly anyColourParts: number;
  readonly unmappedParts: number;
}

const REBRICKABLE_HEADER = ["part", "color", "quantity"] as const;

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function isWholePositive(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function parsePartsCsv(name: string, text: string): ParsedCollection {
  const rows = text
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  const [header, ...body] = rows;
  const columns = header ? splitCsvLine(header).map((cell) => cell.toLowerCase()) : [];
  const index = REBRICKABLE_HEADER.map((column) => columns.indexOf(column));
  const [partAt, colorAt, quantityAt] = index;
  if (
    partAt === undefined ||
    colorAt === undefined ||
    quantityAt === undefined ||
    index.includes(-1)
  ) {
    return {
      collection: null,
      problems: [`${name}: the first row must name the columns Part, Color and Quantity`],
    };
  }
  const totals = new Map<string, OwnedLine>();
  const problems: string[] = [];
  body.forEach((row, i) => {
    const cells = splitCsvLine(row);
    const part = cells[partAt] ?? "";
    const color = Number(cells[colorAt]);
    const quantity = Number(cells[quantityAt]);
    if (part === "" || !Number.isInteger(color) || color < 0 || !isWholePositive(quantity)) {
      problems.push(
        `${name} row ${i + 2}: "${row}" is not a part id, colour id and positive quantity`,
      );
      return;
    }
    const key = `${part}\u0000${color}`;
    totals.set(key, { part, color, quantity: (totals.get(key)?.quantity ?? 0) + quantity });
  });
  const lines = [...totals.values()];
  return {
    collection: { name, lines, parts: lines.reduce((sum, line) => sum + line.quantity, 0) },
    problems,
  };
}

function take(pool: Map<string, number>, key: string, wanted: number): number {
  const owned = Math.min(pool.get(key) ?? 0, wanted);
  pool.set(key, (pool.get(key) ?? 0) - owned);
  return owned;
}

export function ownVsBuy(bom: PlanBom, collection: PartsCollection): OwnBuy {
  const remaining = new Map<string, number>();
  const remainingAnyColour = new Map<string, number>();
  for (const line of collection.lines) {
    remaining.set(`${line.part}\u0000${line.color}`, line.quantity);
    remainingAnyColour.set(line.part, (remainingAnyColour.get(line.part) ?? 0) + line.quantity);
  }
  const coloured = bom.lines.map((entry) => {
    const { part, color } = entry.rebrickable;
    if (part === null || entry.ldrawColor === null || color === null) return 0;
    const own = take(remaining, `${part}\u0000${color}`, entry.quantity);
    take(remainingAnyColour, part, own);
    return own;
  });
  const lines = bom.lines.map((entry, i): OwnBuyLine => {
    const part = entry.rebrickable.part;
    const own =
      entry.ldrawColor === null && part !== null
        ? take(remainingAnyColour, part, entry.quantity)
        : (coloured[i] ?? 0);
    return { entry, own, buy: entry.quantity - own };
  });
  return {
    lines,
    ownParts: lines.reduce((sum, line) => sum + line.own, 0),
    buyParts: lines.reduce((sum, line) => sum + line.buy, 0),
  };
}

function catalogLines(
  entries: ReadonlyArray<{ readonly entry: PlanBomEntry; readonly quantity: number }>,
  system: "rebrickable" | "bricklink",
): CatalogLine[] {
  const merged = new Map<string, CatalogLine>();
  for (const { entry, quantity } of entries) {
    const { part, color } = entry[system];
    if (quantity <= 0 || part === null || color === null) continue;
    const key = `${part}\u0000${color}`;
    merged.set(key, { part, color, quantity: (merged.get(key)?.quantity ?? 0) + quantity });
  }
  return [...merged.values()].toSorted((a, b) =>
    a.part === b.part ? a.color - b.color : a.part < b.part ? -1 : 1,
  );
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isMappedIn(entry: PlanBomEntry, system: "rebrickable" | "bricklink"): boolean {
  const ids = entry[system];
  return ids.part !== null && (entry.ldrawColor === null || ids.color !== null);
}

export function planFiles(bom: PlanBom, ownBuy: OwnBuy | null): PlanFiles {
  const wanted = bom.lines.map((entry, i) => ({
    entry,
    own: ownBuy?.lines[i]?.own ?? 0,
    quantity: ownBuy?.lines[i]?.buy ?? entry.quantity,
  }));
  const header = [
    "LDraw part",
    "LDraw colour",
    "Need",
    "Own",
    "Buy",
    "Rebrickable part",
    "Rebrickable colour",
    "BrickLink part",
    "BrickLink colour",
  ];
  const rows = wanted.map(({ entry, own, quantity }) =>
    [
      entry.part,
      entry.ldrawColor,
      entry.quantity,
      own,
      quantity,
      entry.rebrickable.part,
      entry.rebrickable.color,
      entry.bricklink.part,
      entry.bricklink.color,
    ]
      .map(csvCell)
      .join(","),
  );
  return {
    rebrickableCsv: rebrickableCsv(catalogLines(wanted, "rebrickable")),
    brickLinkXml: brickLinkWantedListXml(catalogLines(wanted, "bricklink")),
    plainCsv: [header.join(","), ...rows].join("\r\n") + "\r\n",
    anyColourParts: wanted
      .filter(({ entry }) => entry.ldrawColor === null)
      .reduce((sum, { quantity }) => sum + quantity, 0),
    unmappedParts: wanted
      .filter(({ entry }) => !isMappedIn(entry, "rebrickable") || !isMappedIn(entry, "bricklink"))
      .reduce((sum, { quantity }) => sum + quantity, 0),
  };
}
