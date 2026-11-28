import * as v from "valibot";
import { ContributorId } from "./document.ts";
import { CatalogRef, Count, SafeInteger, schemaVersionField, strictMessage } from "./fields.ts";

export const INVENTORY_FORMAT = "brr.inventory";
export const INVENTORY_DIRECTORY = "inventories/";

const Quantity = v.pipe(Count, v.minValue(1, "must be at least 1"));

const RebrickableLineV2 = v.strictObject(
  { part: v.pipe(v.string(), v.minLength(1, "is empty")), color: SafeInteger, quantity: Quantity },
  strictMessage,
);
const LdrawLineV2 = v.strictObject(
  { part: CatalogRef, color: SafeInteger, quantity: Quantity },
  strictMessage,
);

export interface InventoryLine {
  readonly part: string;
  readonly color: number;
  readonly quantity: number;
}

export interface InventoryLines {
  readonly rebrickable: ReadonlyArray<InventoryLine>;
  readonly ldraw: ReadonlyArray<InventoryLine>;
}

export function compareInventoryLines(a: InventoryLine, b: InventoryLine): number {
  return a.part === b.part ? a.color - b.color : a.part < b.part ? -1 : 1;
}

function ascendingLines(lines: ReadonlyArray<InventoryLine>): boolean {
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1];
    const current = lines[i];
    if (previous && current && compareInventoryLines(previous, current) >= 0) return false;
  }
  return true;
}

const LINES_IN_ORDER = "must list each part and colour once, by part then colour";

const RebrickableLinesV2 = v.pipe(
  v.array(RebrickableLineV2),
  v.minLength(1, "is empty: leave it out instead"),
  v.check((lines) => ascendingLines(lines), LINES_IN_ORDER),
);

const LdrawLinesV2 = v.pipe(
  v.array(LdrawLineV2),
  v.minLength(1, "is empty: leave it out instead"),
  v.check((lines) => ascendingLines(lines), LINES_IN_ORDER),
);

export const InventoryV2 = v.pipe(
  v.strictObject(
    {
      format: v.literal(INVENTORY_FORMAT, `must be "${INVENTORY_FORMAT}"`),
      schemaVersion: schemaVersionField(2),
      contributor: ContributorId,
      rebrickable: v.exactOptional(RebrickableLinesV2),
      ldraw: v.exactOptional(LdrawLinesV2),
    },
    strictMessage,
  ),
  v.check(
    (inventory) => inventory.rebrickable !== undefined || inventory.ldraw !== undefined,
    "must hold a part",
  ),
);
export type InventoryV2 = v.InferOutput<typeof InventoryV2>;

export const InventoryEntryV2 = v.strictObject(
  { contributor: ContributorId, parts: Quantity },
  strictMessage,
);
export type InventoryEntryV2 = v.InferOutput<typeof InventoryEntryV2>;

function ascendingContributors(entries: ReadonlyArray<InventoryEntryV2>): boolean {
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (previous && current && previous.contributor >= current.contributor) return false;
  }
  return true;
}

export const InventoryListV2 = v.pipe(
  v.array(InventoryEntryV2),
  v.minLength(1, "is empty: leave it out instead"),
  v.check(
    (entries) => ascendingContributors(entries),
    "must list contributors in strictly ascending order",
  ),
);

export function inventoryPath(contributor: number): string {
  return `${INVENTORY_DIRECTORY}${contributor}.json`;
}

export function inventoryFile(contributor: number, lines: InventoryLines): InventoryV2 {
  return {
    format: INVENTORY_FORMAT,
    schemaVersion: 2,
    contributor,
    ...(lines.rebrickable.length > 0 ? { rebrickable: [...lines.rebrickable] } : {}),
    ...(lines.ldraw.length > 0 ? { ldraw: [...lines.ldraw] } : {}),
  };
}

export function inventoryLines(file: InventoryV2): InventoryLines {
  return { rebrickable: file.rebrickable ?? [], ldraw: file.ldraw ?? [] };
}

export function inventoryParts(lines: InventoryLines): number {
  let parts = 0;
  for (const line of lines.rebrickable) parts += line.quantity;
  for (const line of lines.ldraw) parts += line.quantity;
  return parts;
}

export function inventoryEntry(file: InventoryV2): InventoryEntryV2 {
  return { contributor: file.contributor, parts: inventoryParts(inventoryLines(file)) };
}
