import type { BomLine } from "./bom-counter.ts";

export type CatalogSystem = "rebrickable" | "bricklink";

export interface PartComponent {
  readonly part: string;
  readonly color: number;
}

export interface PartCrosswalkEntry {
  readonly rebrickable: string | null;
  readonly bricklink: string | null;
  readonly bricklinkFromKeywordOnly?: boolean;
  readonly components?: ReadonlyArray<PartComponent>;
}

export const INHERITED_COLOR = 16;
const MAX_COMPONENT_DEPTH = 8;

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
  readonly fromKeywordOnly: boolean;
}

export type MissingMapping = "part" | "color" | "part-and-color";

export interface ResolvedLine extends BomLine {
  readonly expandedFrom: string | null;
}

export interface UnmappedLine extends ResolvedLine {
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

function expand(
  line: BomLine,
  expandedFrom: string | null,
  crosswalk: Crosswalk,
  depth: number,
  out: ResolvedLine[],
): void {
  const components = crosswalk.parts.get(line.part)?.components;
  if (!components || components.length === 0 || depth >= MAX_COMPONENT_DEPTH) {
    out.push({ ...line, expandedFrom });
    return;
  }
  for (const component of components) {
    const ldrawColor = component.color === INHERITED_COLOR ? line.ldrawColor : component.color;
    expand(
      { part: component.part, ldrawColor, quantity: line.quantity },
      expandedFrom ?? line.part,
      crosswalk,
      depth + 1,
      out,
    );
  }
}

export function resolveLines(
  lines: ReadonlyArray<BomLine>,
  crosswalk: Crosswalk,
): ReadonlyArray<ResolvedLine> {
  const out: ResolvedLine[] = [];
  for (const line of lines) expand(line, null, crosswalk, 0, out);
  return out;
}

export function toCatalog(
  lines: ReadonlyArray<BomLine>,
  crosswalk: Crosswalk,
  system: CatalogSystem,
): CatalogBom {
  const merged = new Map<string, CatalogLine>();
  const unmapped: UnmappedLine[] = [];
  for (const line of resolveLines(lines, crosswalk)) {
    const entry = crosswalk.parts.get(line.part);
    const part = entry?.[system] ?? null;
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
    const fromKeywordOnly = system === "bricklink" && entry?.bricklinkFromKeywordOnly === true;
    merged.set(key, {
      part,
      color,
      quantity: (existing?.quantity ?? 0) + line.quantity,
      fromKeywordOnly: (existing?.fromKeywordOnly ?? false) || fromKeywordOnly,
    });
  }
  const sorted = [...merged.values()].toSorted((a, b) =>
    a.part === b.part ? a.color - b.color : a.part < b.part ? -1 : 1,
  );
  return { system, lines: sorted, unmapped };
}
