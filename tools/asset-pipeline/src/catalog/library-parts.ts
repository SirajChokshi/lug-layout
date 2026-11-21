import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  LIBRARY_PARTS_FORMAT,
  type CrosswalkFile,
  type CrosswalkSourcePin,
  type LibraryPartsFile,
} from "@brr/schema/bundle";
import { parseCsv } from "./csv.ts";
import { LDRAW_NAMESPACE, type LdrawPartFacts } from "./crosswalk.ts";
import { listedCategory, type LdrawCategories } from "./part-categories.ts";

const UNOFFICIAL_PREFIX = "Unofficial_";
const PART_COLUMN = "part_num";
const COLOR_COLUMN = "color_id";

export type InventoryColorCounts = ReadonlyMap<string, ReadonlyMap<number, number>>;

export interface LibraryPartsInputs {
  readonly ldrawParts: ReadonlyMap<string, LdrawPartFacts>;
  readonly categories: LdrawCategories;
  readonly crosswalk: CrosswalkFile;
  readonly inventoryColors: InventoryColorCounts;
  readonly ldrawColors: ReadonlySet<number>;
}

export interface LibraryPartsReport {
  readonly scanned: number;
  readonly listed: number;
  readonly unlisted: number;
  readonly unofficial: number;
  readonly withoutRebrickable: number;
  readonly withoutProducedColor: number;
}

export interface DerivedLibraryParts {
  readonly file: LibraryPartsFile;
  readonly report: LibraryPartsReport;
}

interface ListedPart {
  readonly id: string;
  readonly facts: LdrawPartFacts;
  readonly category: string;
  readonly rebrickable: string;
  readonly colors: ReadonlyArray<number>;
}

export function inventoryColorCounts(csvText: string): InventoryColorCounts {
  const lines = csvText.split("\n");
  const header = parseCsv(lines[0] ?? "")[0] ?? [];
  const partColumn = header.indexOf(PART_COLUMN);
  const colorColumn = header.indexOf(COLOR_COLUMN);
  if (partColumn < 0 || colorColumn < 0) {
    throw new Error(`inventory parts have no ${PART_COLUMN} or ${COLOR_COLUMN} column`);
  }
  const counts = new Map<string, Map<number, number>>();
  for (let line = 1; line < lines.length; line++) {
    const text = lines[line]?.replace(/\r$/u, "") ?? "";
    if (text === "") continue;
    const cells = text.includes('"') ? (parseCsv(text)[0] ?? []) : text.split(",");
    if (cells.length !== header.length) {
      throw new Error(
        `inventory parts line ${line + 1} has ${cells.length} cells, not ${header.length}`,
      );
    }
    const part = cells[partColumn] ?? "";
    const color = Number(cells[colorColumn]);
    const byColor = counts.get(part) ?? new Map<number, number>();
    byColor.set(color, (byColor.get(color) ?? 0) + 1);
    counts.set(part, byColor);
  }
  return counts;
}

export async function readInventoryColorCounts(path: string): Promise<InventoryColorCounts> {
  return inventoryColorCounts(gunzipSync(await readFile(path)).toString("utf8"));
}

function ldrawColorOfRebrickable(
  crosswalk: CrosswalkFile,
  ldrawColors: ReadonlySet<number>,
): ReadonlyMap<number, number> {
  const claims = new Map<number, number[]>();
  for (const [code, color] of Object.entries(crosswalk.colors)) {
    if (color.rebrickable === null || !ldrawColors.has(Number(code))) continue;
    claims.set(color.rebrickable, [...(claims.get(color.rebrickable) ?? []), Number(code)]);
  }
  const unique = new Map<number, number>();
  for (const [rebrickable, codes] of claims) {
    const [only] = codes;
    if (codes.length === 1 && only !== undefined) unique.set(rebrickable, only);
  }
  return unique;
}

function producedColors(
  counts: ReadonlyMap<number, number> | undefined,
  ldrawOf: ReadonlyMap<number, number>,
): ReadonlyArray<number> {
  const byLdraw = new Map<number, number>();
  for (const [rebrickable, count] of counts ?? []) {
    const code = ldrawOf.get(rebrickable);
    if (code !== undefined) byLdraw.set(code, (byLdraw.get(code) ?? 0) + count);
  }
  return [...byLdraw]
    .toSorted(([codeA, countA], [codeB, countB]) => countB - countA || codeA - codeB)
    .map(([code]) => code);
}

function byId(a: ListedPart, b: ListedPart): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function deriveLibraryParts(
  inputs: LibraryPartsInputs,
  sources: Readonly<Record<string, CrosswalkSourcePin>>,
): DerivedLibraryParts {
  const ldrawOf = ldrawColorOfRebrickable(inputs.crosswalk, inputs.ldrawColors);
  const listed: ListedPart[] = [];
  let unlisted = 0;
  let unofficial = 0;
  let withoutRebrickable = 0;
  let withoutProducedColor = 0;
  for (const [id, facts] of inputs.ldrawParts) {
    const category = listedCategory(facts, inputs.categories);
    if (category === null) {
      unlisted++;
      continue;
    }
    if (facts.ldrawOrg.startsWith(UNOFFICIAL_PREFIX)) {
      unofficial++;
      continue;
    }
    const rebrickable = inputs.crosswalk.parts[LDRAW_NAMESPACE + id]?.rebrickable ?? null;
    if (rebrickable === null) {
      withoutRebrickable++;
      continue;
    }
    const colors = producedColors(inputs.inventoryColors.get(rebrickable), ldrawOf);
    if (colors.length === 0) {
      withoutProducedColor++;
      continue;
    }
    listed.push({ id, facts, category, rebrickable, colors });
  }
  listed.sort(byId);
  const categories = [...new Set(listed.map((part) => part.category))].toSorted();
  const categoryIndex = new Map(categories.map((category, index) => [category, index]));
  return {
    file: {
      format: LIBRARY_PARTS_FORMAT,
      sources,
      categories,
      parts: {
        id: listed.map((part) => part.id),
        title: listed.map((part) => part.facts.title),
        category: listed.map((part) => categoryIndex.get(part.category) ?? 0),
        keywords: listed.map((part) => [...part.facts.keywords]),
        rebrickable: listed.map((part) => part.rebrickable),
        colorCount: listed.map((part) => part.colors.length),
        colors: listed.flatMap((part) => part.colors),
      },
    },
    report: {
      scanned: inputs.ldrawParts.size,
      listed: listed.length,
      unlisted,
      unofficial,
      withoutRebrickable,
      withoutProducedColor,
    },
  };
}
