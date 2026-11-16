import type { BomLine } from "./bom-counter.ts";

export type CatalogSystem = "rebrickable" | "bricklink";

export interface PartCrosswalkEntry {
  readonly rebrickable: string | null;
  readonly bricklink: string | null;
}

export interface ColorCrosswalkEntry {
  readonly rebrickable: number | null;
  readonly bricklink: number | null;
}

export interface Crosswalk {
  readonly parts: ReadonlyMap<string, PartCrosswalkEntry>;
  readonly colors: ReadonlyMap<number, ColorCrosswalkEntry>;
}

export interface CatalogLine {
  readonly part: string;
  readonly color: number;
  readonly quantity: number;
}

export type MissingMapping = "part" | "color" | "part-and-color";

export interface UnmappedLine extends BomLine {
  readonly missing: MissingMapping;
}

export interface CatalogBom {
  readonly system: CatalogSystem;
  readonly lines: ReadonlyArray<CatalogLine>;
  readonly unmapped: ReadonlyArray<UnmappedLine>;
}

function missingMapping(part: string | null): MissingMapping {
  return part === null ? "part-and-color" : "color";
}

export function toCatalog(
  lines: ReadonlyArray<BomLine>,
  crosswalk: Crosswalk,
  system: CatalogSystem,
): CatalogBom {
  const merged = new Map<string, CatalogLine>();
  const unmapped: UnmappedLine[] = [];
  for (const line of lines) {
    const part = crosswalk.parts.get(line.part)?.[system] ?? null;
    const color = crosswalk.colors.get(line.ldrawColor)?.[system] ?? null;
    if (color === null) {
      unmapped.push({ ...line, missing: missingMapping(part) });
      continue;
    }
    if (part === null) {
      unmapped.push({ ...line, missing: "part" });
      continue;
    }
    const key = `${part}\u0000${color}`;
    const existing = merged.get(key);
    merged.set(key, { part, color, quantity: (existing?.quantity ?? 0) + line.quantity });
  }
  const sorted = [...merged.values()].toSorted((a, b) =>
    a.part === b.part ? a.color - b.color : a.part < b.part ? -1 : 1,
  );
  return { system, lines: sorted, unmapped };
}

export function totalQuantity(lines: ReadonlyArray<{ readonly quantity: number }>): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}
