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

export type TableTurn = 0 | 1;

export function tableName(number: number): string {
  return `Table ${number}`;
}

export function lowestFreeTableNumber(tables: ReadonlyArray<Pick<PlanTable, "number">>): number {
  const used = new Set(tables.map((table) => table.number));
  let number = 1;
  while (used.has(number)) number++;
  return number;
}

export function tableTypeSize(type: TableType, turn: TableTurn) {
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

function typeOf(table: PlanTable, types: ReadonlyArray<TableType>): TableType | undefined {
  return table.typeId === undefined ? undefined : types.find((type) => type.id === table.typeId);
}

function untyped(table: PlanTable): PlanTable {
  const { typeId: _typeId, ...rest } = table;
  return rest;
}

export function withTypeKept(table: PlanTable, types: ReadonlyArray<TableType>): PlanTable {
  if (table.typeId === undefined) return table;
  const type = typeOf(table, types);
  return type && tableFitsType(table, type) ? table : untyped(table);
}

export function turnedTable(table: PlanTable): PlanTable {
  const { rect } = table;
  return { ...table, rect: { ...rect, width: rect.depth, depth: rect.width } };
}

function retypedTable(table: PlanTable, before?: TableType, after?: TableType): PlanTable {
  if (!after) return untyped(table);
  if (before === after) return table;
  const { rect } = table;
  const size = tableTypeSize(after, before && rect.width !== before.widthMm ? 1 : 0);
  const sized = rect.width === size.widthMm && rect.depth === size.depthMm;
  if (sized && table.heightMm === after.heightMm) return table;
  return {
    ...table,
    rect: { ...rect, width: size.widthMm, depth: size.depthMm },
    heightMm: after.heightMm,
  };
}

export function retypedRegion(
  region: PlanRegion,
  before: ReadonlyArray<TableType>,
  after: ReadonlyArray<TableType>,
): PlanRegion {
  const tables = region.footprint.tables.map((table) =>
    table.typeId === undefined
      ? table
      : retypedTable(table, typeOf(table, before), typeOf(table, after)),
  );
  if (tables.every((table, i) => table === region.footprint.tables[i])) return region;
  let grown: PlanRegion = { ...region, footprint: { ...region.footprint, tables } };
  for (let i = 0; i < tables.length; i++) {
    const table = grown.footprint.tables[i];
    if (table) grown = regionAround(grown, mmRectInWorld(grown, table.rect));
  }
  return grown;
}

export function placedTableCounts(region: PlanRegion): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const { typeId } of region.footprint.tables) {
    if (typeId !== undefined) counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
  }
  return counts;
}
