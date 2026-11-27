import { lduFromMm } from "@brr/math";
import { tableFitsType } from "@brr/schema/world";
import {
  mmRectInWorld,
  regionAround,
  type LduRect,
  type PlanRegion,
  type PlanTable,
  type TableType,
} from "./plan-region.ts";

export const TABLE_TURNS = [0, 1] as const;
export type TableTurn = (typeof TABLE_TURNS)[number];

export interface TableTypeSize {
  readonly widthMm: number;
  readonly depthMm: number;
}

export function tableName(number: number): string {
  return `Table ${number}`;
}

export function lowestFreeTableNumber(tables: ReadonlyArray<Pick<PlanTable, "number">>): number {
  const used = new Set(tables.map((table) => table.number));
  let number = 1;
  while (used.has(number)) number++;
  return number;
}

export function tableTypeSize(type: TableType, turn: TableTurn): TableTypeSize {
  return turn === 0
    ? { widthMm: type.widthMm, depthMm: type.depthMm }
    : { widthMm: type.depthMm, depthMm: type.widthMm };
}

export function tableTypeRect(
  type: TableType,
  turn: TableTurn,
  cornerX: number,
  cornerZ: number,
): LduRect {
  const size = tableTypeSize(type, turn);
  return {
    minX: cornerX,
    minZ: cornerZ,
    maxX: cornerX + lduFromMm(size.widthMm),
    maxZ: cornerZ + lduFromMm(size.depthMm),
  };
}

export function tableTurnOf(table: PlanTable, type: TableType): TableTurn {
  return table.rect.width === type.widthMm && table.rect.depth === type.depthMm ? 0 : 1;
}

export function tableTypeOf(
  table: PlanTable,
  types: ReadonlyArray<TableType>,
): TableType | undefined {
  return table.typeId === undefined ? undefined : types.find((type) => type.id === table.typeId);
}

export function untypedTable(table: PlanTable): PlanTable {
  if (table.typeId === undefined) return table;
  const { typeId: _typeId, ...untyped } = table;
  return untyped;
}

export function withTypeKept(table: PlanTable, types: ReadonlyArray<TableType>): PlanTable {
  const type = tableTypeOf(table, types);
  return type && tableFitsType(table, type) ? table : untypedTable(table);
}

export function turnedTable(table: PlanTable): PlanTable {
  const { rect } = table;
  return { ...table, rect: { ...rect, width: rect.depth, depth: rect.width } };
}

function retypedTable(
  table: PlanTable,
  before: TableType | undefined,
  after: TableType | undefined,
): PlanTable {
  if (!after) return untypedTable(table);
  if (before === after) return table;
  const size = tableTypeSize(after, before ? tableTurnOf(table, before) : 0);
  const { rect } = table;
  if (
    rect.width === size.widthMm &&
    rect.depth === size.depthMm &&
    table.heightMm === after.heightMm
  ) {
    return table;
  }
  return {
    ...table,
    rect: { ...rect, width: size.widthMm, depth: size.depthMm },
    heightMm: after.heightMm,
  };
}

function grownAroundTables(region: PlanRegion): PlanRegion {
  let grown = region;
  for (let i = 0; i < region.footprint.tables.length; i++) {
    const table = grown.footprint.tables[i];
    if (table) grown = regionAround(grown, mmRectInWorld(grown, table.rect));
  }
  return grown;
}

export function retypedRegion(
  region: PlanRegion,
  before: ReadonlyArray<TableType>,
  after: ReadonlyArray<TableType>,
): PlanRegion {
  let changed = false;
  const tables = region.footprint.tables.map((table) => {
    if (table.typeId === undefined) return table;
    const next = retypedTable(table, tableTypeOf(table, before), tableTypeOf(table, after));
    if (next !== table) changed = true;
    return next;
  });
  if (!changed) return region;
  return grownAroundTables({ ...region, footprint: { ...region.footprint, tables } });
}

export function placedTableCounts(region: PlanRegion): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const table of region.footprint.tables) {
    if (table.typeId !== undefined) counts.set(table.typeId, (counts.get(table.typeId) ?? 0) + 1);
  }
  return counts;
}
