import { isCustomPartId } from "@brr/schema/bundle";
import type { Crosswalk, MissingMapping, ResolvedLine } from "./catalog-ids.ts";

export interface OwnedPart {
  readonly part: string;
  readonly color: number;
  readonly quantity: number;
}

export interface RejectedRow {
  readonly line: number;
  readonly text: string;
}

export interface OwnedParts {
  readonly name: string;
  readonly parts: ReadonlyArray<OwnedPart>;
  readonly total: number;
  readonly rejected: ReadonlyArray<RejectedRow>;
}

export type OwnedPartsRead =
  | { readonly ok: true; readonly owned: OwnedParts }
  | { readonly ok: false; readonly problem: string };

export interface OwnBuyLine extends ResolvedLine {
  readonly rebrickable: { readonly part: string; readonly color: number } | null;
  readonly own: number;
  readonly buy: number;
}

export interface UnknownOwnedPart extends OwnedPart {
  readonly missing: MissingMapping;
}

export interface OwnVsBuy {
  readonly lines: ReadonlyArray<OwnBuyLine>;
  readonly own: number;
  readonly buy: number;
  readonly unmatched: number;
  readonly custom: number;
  readonly unknown: ReadonlyArray<UnknownOwnedPart>;
  readonly shortfall: ReadonlyArray<ResolvedLine>;
}

interface CsvRow {
  readonly line: number;
  readonly text: string;
  readonly cells: ReadonlyArray<string>;
}

const BYTE_ORDER_MARK = "\uFEFF";
const COLUMNS = ["part", "color", "quantity"] as const;
const COLOR_ID = /^-?\d+$/u;
const WHOLE_NUMBER = /^\d+$/u;

function csvRows(text: string): CsvRow[] {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let rowStart = 0;
  const endRow = (end: number): void => {
    cells.push(cell);
    const raw = source.slice(rowStart, end);
    if (raw.trim() !== "")
      rows.push({ line: rowLine, text: raw, cells: cells.map((c) => c.trim()) });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && source[i + 1] !== "\n")) line++;
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      endRow(i);
      if (ch === "\r" && source[i + 1] === "\n") i++;
      line++;
      rowLine = line;
      rowStart = i + 1;
    } else {
      cell += ch;
    }
  }
  endRow(source.length);
  return rows;
}

function ownedKey(part: string, color: number): string {
  return `${part}\u0000${color}`;
}

export function readOwnedPartsCsv(name: string, text: string): OwnedPartsRead {
  const [header, ...body] = csvRows(text);
  const columns = header?.cells.map((cell) => cell.toLowerCase()) ?? [];
  const [partAt, colorAt, quantityAt] = COLUMNS.map((column) => columns.indexOf(column));
  if (
    partAt === undefined ||
    colorAt === undefined ||
    quantityAt === undefined ||
    partAt < 0 ||
    colorAt < 0 ||
    quantityAt < 0
  ) {
    return {
      ok: false,
      problem: `${name}: the first row must name the columns Part, Color and Quantity`,
    };
  }
  const totals = new Map<string, OwnedPart>();
  const rejected: RejectedRow[] = [];
  for (const row of body) {
    const part = row.cells[partAt] ?? "";
    const colorText = row.cells[colorAt] ?? "";
    const quantityText = row.cells[quantityAt] ?? "";
    const color = Number(colorText);
    const key = ownedKey(part, color);
    const quantity = (totals.get(key)?.quantity ?? 0) + Number(quantityText);
    if (
      part === "" ||
      !COLOR_ID.test(colorText) ||
      !Number.isSafeInteger(color) ||
      !WHOLE_NUMBER.test(quantityText) ||
      Number(quantityText) === 0 ||
      !Number.isSafeInteger(quantity)
    ) {
      rejected.push({ line: row.line, text: row.text });
      continue;
    }
    totals.set(key, { part, color, quantity });
  }
  const parts = [...totals.values()];
  return {
    ok: true,
    owned: { name, parts, total: parts.reduce((sum, p) => sum + p.quantity, 0), rejected },
  };
}

function unknownParts(crosswalk: Crosswalk, owned: OwnedParts): UnknownOwnedPart[] {
  const knownParts = new Set<string>();
  const knownColors = new Set<number>();
  for (const entry of crosswalk.parts.values()) {
    if (entry.rebrickable !== null) knownParts.add(entry.rebrickable);
  }
  for (const entry of crosswalk.colors.values()) {
    if (entry.rebrickable !== null) knownColors.add(entry.rebrickable);
  }
  return owned.parts.flatMap((owning): UnknownOwnedPart[] => {
    const partKnown = knownParts.has(owning.part);
    const colorKnown = knownColors.has(owning.color);
    if (partKnown && colorKnown) return [];
    const missing: MissingMapping = partKnown ? "color" : colorKnown ? "part" : "part-and-color";
    return [{ ...owning, missing }];
  });
}

export function ownVsBuy(
  resolved: ReadonlyArray<ResolvedLine>,
  crosswalk: Crosswalk,
  owned: OwnedParts,
): OwnVsBuy {
  const available = new Map<string, number>();
  for (const owning of owned.parts) {
    const key = ownedKey(owning.part, owning.color);
    available.set(key, (available.get(key) ?? 0) + owning.quantity);
  }
  let own = 0;
  let unmatched = 0;
  let custom = 0;
  const lines: OwnBuyLine[] = [];
  for (const line of resolved) {
    if (isCustomPartId(line.part)) {
      custom += line.quantity;
      continue;
    }
    const part = crosswalk.parts.get(line.part)?.rebrickable ?? null;
    const color = crosswalk.colors.get(line.ldrawColor)?.rebrickable ?? null;
    if (part === null || color === null) {
      unmatched += line.quantity;
      lines.push({ ...line, rebrickable: null, own: 0, buy: line.quantity });
      continue;
    }
    const key = ownedKey(part, color);
    const left = available.get(key) ?? 0;
    const taken = Math.min(left, line.quantity);
    available.set(key, left - taken);
    own += taken;
    lines.push({ ...line, rebrickable: { part, color }, own: taken, buy: line.quantity - taken });
  }
  const need = lines.reduce((sum, line) => sum + line.quantity, 0);
  return {
    lines,
    own,
    buy: need - own,
    unmatched,
    custom,
    unknown: unknownParts(crosswalk, owned),
    shortfall: lines.flatMap((line): ResolvedLine[] =>
      line.buy > 0
        ? [
            {
              part: line.part,
              ldrawColor: line.ldrawColor,
              quantity: line.buy,
              expandedFrom: line.expandedFrom,
            },
          ]
        : [],
    ),
  };
}
