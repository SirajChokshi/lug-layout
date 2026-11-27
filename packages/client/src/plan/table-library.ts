import {
  placedTableCounts,
  tableTypeRect,
  tableTypeSize,
  type LduRect,
  type TableTurn,
  type TableType,
} from "@brr/domain";
import { lduFromMm } from "@brr/math";
import { GUIDE_GRID_STUDS } from "@brr/render";
import { decode, type Decoded, type Issue } from "@brr/schema/decode";
import { TABLE_TYPE_ID_MAX, TableTypeRecordV2 } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import { GUIDE_GRID_LDU } from "../edit/table-tool.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import type { DrawnTable, IPlanService } from "./plan-service.ts";

const TYPE_PATH = "table type";
const LIBRARY_FULL = `holds ${TABLE_TYPE_ID_MAX + 1} table types already`;

export type TableTypeInput = Omit<TableType, "id">;

export interface TableTypeUsage {
  readonly type: TableType;
  readonly placed: number;
  readonly short: number;
}

export interface ITableLibrary {
  types(): ReadonlyArray<TableType>;
  addType(input: TableTypeInput): Decoded<number>;
  updateType(typeId: number, patch: Partial<TableTypeInput>): ReadonlyArray<Issue>;
  removeType(typeId: number): void;
  stampAt(typeId: number, turn: TableTurn, x: number, z: number): LduRect;
  place(typeId: number, turn: TableTurn, cornerX: number, cornerZ: number): DrawnTable;
  turnTable(planId: string, tableId: string): void;
  usage(planId: string | null): ReadonlyArray<TableTypeUsage>;
}

function onTableGrid(ldu: number): number {
  return Math.round(ldu / GUIDE_GRID_LDU) * GUIDE_GRID_LDU + 0;
}

function freeTypeId(types: ReadonlyArray<TableType>): number | null {
  const last = types.at(-1)?.id ?? -1;
  if (last < TABLE_TYPE_ID_MAX) return last + 1;
  const used = new Set(types.map((type) => type.id));
  for (let id = 0; id <= TABLE_TYPE_ID_MAX; id++) if (!used.has(id)) return id;
  return null;
}

function byId(a: TableType, b: TableType): number {
  return a.id - b.id;
}

function validType(type: TableType): Decoded<TableType> {
  const decoded = decode(TableTypeRecordV2, type, TYPE_PATH);
  return decoded.ok ? { ok: true, value: type } : decoded;
}

@injectable()
export class TableLibrary implements ITableLibrary {
  constructor(@inject(PLAN_SERVICE) private readonly plans: IPlanService) {}

  types(): ReadonlyArray<TableType> {
    return this.plans.tableTypes();
  }

  private type(typeId: number): TableType {
    const type = this.types().find((t) => t.id === typeId);
    if (!type) throw new Error(`no table type ${typeId}`);
    return type;
  }

  addType(input: TableTypeInput): Decoded<number> {
    const types = this.types();
    const id = freeTypeId(types);
    if (id === null) return { ok: false, issues: [{ path: "library", message: LIBRARY_FULL }] };
    const added = validType({ ...input, id });
    if (!added.ok) return added;
    const next = [...types, added.value];
    next.sort(byId);
    this.plans.setTableTypes(next);
    return { ok: true, value: id };
  }

  updateType(typeId: number, patch: Partial<TableTypeInput>): ReadonlyArray<Issue> {
    const updated = validType({ ...this.type(typeId), ...patch, id: typeId });
    if (!updated.ok) return updated.issues;
    this.plans.setTableTypes(this.types().map((t) => (t.id === typeId ? updated.value : t)));
    return [];
  }

  removeType(typeId: number): void {
    this.type(typeId);
    this.plans.setTableTypes(this.types().filter((t) => t.id !== typeId));
  }

  stampAt(typeId: number, turn: TableTurn, x: number, z: number): LduRect {
    const size = tableTypeSize(this.type(typeId), turn);
    const cornerX = onTableGrid(x - lduFromMm(size.widthMm) / 2);
    const cornerZ = onTableGrid(z - lduFromMm(size.depthMm) / 2);
    return tableTypeRect(this.type(typeId), turn, cornerX, cornerZ);
  }

  place(typeId: number, turn: TableTurn, cornerX: number, cornerZ: number): DrawnTable {
    if (onTableGrid(cornerX) !== cornerX || onTableGrid(cornerZ) !== cornerZ) {
      throw new RangeError(
        `table corner (${cornerX}, ${cornerZ}) is off the ${GUIDE_GRID_STUDS}-stud grid`,
      );
    }
    return this.plans.drawTable(tableTypeRect(this.type(typeId), turn, cornerX, cornerZ), typeId);
  }

  turnTable(planId: string, tableId: string): void {
    this.plans.turnTable(planId, tableId);
  }

  usage(planId: string | null): ReadonlyArray<TableTypeUsage> {
    const region = this.plans.plans().find((plan) => plan.id === planId);
    const counts = region ? placedTableCounts(region) : new Map<number, number>();
    return this.types().map((type) => {
      const placed = counts.get(type.id) ?? 0;
      return { type, placed, short: Math.max(0, placed - type.owned) };
    });
  }
}
