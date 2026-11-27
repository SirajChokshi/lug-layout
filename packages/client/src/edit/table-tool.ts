import type { LduRect, TableTop, TableTurn } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { GUIDE_GRID_STUDS, type GuideSegment } from "@brr/render";
import type { IPlanService, PlanView } from "../plan/plan-service.ts";
import type { ITableLibrary } from "../plan/table-library.ts";
import { rulerGuides, type Ruler } from "./measure-tool.ts";
import { lengthText, type LabelView } from "./size-labels.ts";

export const GUIDE_GRID_LDU = GUIDE_GRID_STUDS * STUD_LDU;
const DIMENSION_OFFSET_LDU = 3 * STUD_LDU;
const DRAFT_TABLE_ID = "draft-table";
const STAMP_TABLE_ID = "stamp-table";

export interface ArmedTable {
  readonly typeId: number;
  readonly turn: TableTurn;
}

interface TableEdges {
  readonly minX: boolean;
  readonly maxX: boolean;
  readonly minZ: boolean;
  readonly maxZ: boolean;
}

interface TableHandle {
  readonly planId: string;
  readonly tableId: string;
  readonly rect: LduRect;
  readonly edges: TableEdges;
  readonly typed: boolean;
}

interface TableDrag {
  readonly handle: TableHandle | null;
  readonly startX: number;
  readonly startZ: number;
  rect: LduRect | null;
}

interface ShownTable {
  readonly id: string;
  readonly rect: LduRect;
}

const MOVE: TableEdges = { minX: true, maxX: true, minZ: true, maxZ: true };

function snapToGuideGrid(ldu: number): number {
  return Math.round(ldu / GUIDE_GRID_LDU) * GUIDE_GRID_LDU + 0;
}

function isMove(edges: TableEdges): boolean {
  return edges.minX && edges.maxX && edges.minZ && edges.maxZ;
}

function sameRect(a: LduRect, b: LduRect): boolean {
  return a.minX === b.minX && a.maxX === b.maxX && a.minZ === b.minZ && a.maxZ === b.maxZ;
}

function sameStamp(a: LduRect | null, b: LduRect | null): boolean {
  return a === null || b === null ? a === b : sameRect(a, b);
}

function sameHandle(a: TableHandle | null, b: TableHandle | null): boolean {
  if (a === null || b === null) return a === b;
  const { edges } = a;
  return (
    a.planId === b.planId &&
    a.tableId === b.tableId &&
    edges.minX === b.edges.minX &&
    edges.maxX === b.edges.maxX &&
    edges.minZ === b.edges.minZ &&
    edges.maxZ === b.edges.maxZ
  );
}

function nearEdges(
  at: number,
  min: number,
  max: number,
  tolerance: number,
): readonly [boolean, boolean] {
  const toMin = Math.abs(at - min);
  const toMax = Math.abs(at - max);
  return [toMin <= tolerance && toMin <= toMax, toMax <= tolerance && toMax < toMin];
}

function drawnRect(ax: number, az: number, bx: number, bz: number): LduRect | null {
  const minX = snapToGuideGrid(Math.min(ax, bx));
  const maxX = snapToGuideGrid(Math.max(ax, bx));
  const minZ = snapToGuideGrid(Math.min(az, bz));
  const maxZ = snapToGuideGrid(Math.max(az, bz));
  return maxX > minX && maxZ > minZ ? { minX, minZ, maxX, maxZ } : null;
}

function movedRect(rect: LduRect, edges: TableEdges, dx: number, dz: number): LduRect {
  if (isMove(edges)) {
    const sx = snapToGuideGrid(dx);
    const sz = snapToGuideGrid(dz);
    return {
      minX: rect.minX + sx,
      maxX: rect.maxX + sx,
      minZ: rect.minZ + sz,
      maxZ: rect.maxZ + sz,
    };
  }
  return {
    minX: edges.minX
      ? Math.min(snapToGuideGrid(rect.minX + dx), rect.maxX - GUIDE_GRID_LDU)
      : rect.minX,
    maxX: edges.maxX
      ? Math.max(snapToGuideGrid(rect.maxX + dx), rect.minX + GUIDE_GRID_LDU)
      : rect.maxX,
    minZ: edges.minZ
      ? Math.min(snapToGuideGrid(rect.minZ + dz), rect.maxZ - GUIDE_GRID_LDU)
      : rect.minZ,
    maxZ: edges.maxZ
      ? Math.max(snapToGuideGrid(rect.maxZ + dz), rect.minZ + GUIDE_GRID_LDU)
      : rect.maxZ,
  };
}

function outline(rect: LduRect, y: number, out: GuideSegment[]): void {
  const { minX, minZ, maxX, maxZ } = rect;
  out.push(
    { kind: "draft", ax: minX, ay: y, az: minZ, bx: maxX, by: y, bz: minZ },
    { kind: "draft", ax: maxX, ay: y, az: minZ, bx: maxX, by: y, bz: maxZ },
    { kind: "draft", ax: maxX, ay: y, az: maxZ, bx: minX, by: y, bz: maxZ },
    { kind: "draft", ax: minX, ay: y, az: maxZ, bx: minX, by: y, bz: minZ },
  );
}

function edgeGuides(handle: TableHandle, y: number, out: GuideSegment[]): void {
  const { rect, edges } = handle;
  if (isMove(edges)) {
    outline(rect, y, out);
    return;
  }
  const { minX, minZ, maxX, maxZ } = rect;
  if (edges.minZ) out.push({ kind: "draft", ax: minX, ay: y, az: minZ, bx: maxX, by: y, bz: minZ });
  if (edges.maxX) out.push({ kind: "draft", ax: maxX, ay: y, az: minZ, bx: maxX, by: y, bz: maxZ });
  if (edges.maxZ) out.push({ kind: "draft", ax: minX, ay: y, az: maxZ, bx: maxX, by: y, bz: maxZ });
  if (edges.minX) out.push({ kind: "draft", ax: minX, ay: y, az: minZ, bx: minX, by: y, bz: maxZ });
}

function widthRuler(rect: LduRect): Ruler {
  const z = rect.minZ - DIMENSION_OFFSET_LDU;
  return { ax: rect.minX, az: z, bx: rect.maxX, bz: z };
}

function depthRuler(rect: LduRect): Ruler {
  const x = rect.maxX + DIMENSION_OFFSET_LDU;
  return { ax: x, az: rect.minZ, bx: x, bz: rect.maxZ };
}

function dimensionLabels(id: string, rect: LduRect, y: number, out: LabelView[]): void {
  const width = widthRuler(rect);
  const depth = depthRuler(rect);
  out.push(
    {
      id: `${id}-width`,
      kind: "table",
      text: lengthText(rect.maxX - rect.minX),
      x: (width.ax + width.bx) / 2,
      y,
      z: width.az,
    },
    {
      id: `${id}-depth`,
      kind: "table",
      text: lengthText(rect.maxZ - rect.minZ),
      x: depth.ax,
      y,
      z: (depth.az + depth.bz) / 2,
    },
  );
}

function numberLabel(top: TableTop, rect: LduRect, y: number): LabelView {
  return {
    id: `${top.id}-number`,
    kind: "table",
    text: String(top.number),
    x: (rect.minX + rect.maxX) / 2,
    y,
    z: (rect.minZ + rect.maxZ) / 2,
  };
}

export class TableTool {
  private hover: TableHandle | null = null;
  private drag: TableDrag | null = null;
  private planId: string | null = null;
  private view: PlanView | null = null;
  private armed: ArmedTable | null = null;
  private stamp: LduRect | null = null;
  private stamping = false;
  private cursorX = 0;
  private cursorZ = 0;

  constructor(
    private readonly plans: IPlanService,
    private readonly library: ITableLibrary,
    private readonly y: number,
  ) {}

  get dragging(): boolean {
    return this.drag !== null || this.stamping;
  }

  get hoveredTable(): string | null {
    return this.hover?.tableId ?? null;
  }

  get armedTable(): ArmedTable | null {
    return this.armed;
  }

  arm(typeId: number | null): void {
    this.cancel();
    this.armed = typeId === null ? null : { typeId, turn: 0 };
    this.stamp = null;
  }

  turn(): boolean {
    const armed = this.armed;
    if (armed) {
      this.armed = { ...armed, turn: armed.turn === 0 ? 1 : 0 };
      if (this.stamp) this.stamp = this.stampAt(this.cursorX, this.cursorZ);
      return true;
    }
    const hover = this.hover;
    if (!hover || this.drag) return false;
    this.hover = null;
    this.plans.turnTable(hover.planId, hover.tableId);
    return true;
  }

  planChanged(): boolean {
    const shown = this.stamp;
    const armed = this.armed;
    if (armed && !this.library.types().some((type) => type.id === armed.typeId)) this.arm(null);
    this.stamp = shown && this.armed ? this.stampAt(this.cursorX, this.cursorZ) : null;
    const restamped = armed !== this.armed || !sameStamp(shown, this.stamp);
    const planId = this.plans.activePlanId();
    const view = planId === null ? null : this.plans.regionView(planId);
    if (planId === this.planId && view === this.view) return restamped;
    this.planId = planId;
    this.view = view;
    this.cancel();
    return true;
  }

  hoverAt(x: number, z: number, tolerance: number): boolean {
    this.cursorX = x;
    this.cursorZ = z;
    if (this.armed) {
      const stamp = this.stampAt(x, z);
      if (sameStamp(stamp, this.stamp)) return false;
      this.stamp = stamp;
      return true;
    }
    if (this.drag) return false;
    const hover = this.handleAt(x, z, tolerance);
    if (sameHandle(hover, this.hover)) return false;
    this.hover = hover;
    return true;
  }

  unhover(): boolean {
    if (this.armed) {
      if (this.stamp === null || this.stamping) return false;
      this.stamp = null;
      return true;
    }
    if (this.drag || this.hover === null) return false;
    this.hover = null;
    return true;
  }

  begin(x: number, z: number, tolerance: number): void {
    if (this.armed) {
      this.stamping = true;
      this.hoverAt(x, z, tolerance);
      return;
    }
    this.drag = { handle: this.handleAt(x, z, tolerance), startX: x, startZ: z, rect: null };
  }

  move(x: number, z: number): boolean {
    if (this.armed) return this.hoverAt(x, z, 0);
    const drag = this.drag;
    if (!drag) return false;
    const rect = drag.handle
      ? movedRect(drag.handle.rect, drag.handle.edges, x - drag.startX, z - drag.startZ)
      : drawnRect(drag.startX, drag.startZ, x, z);
    if (rect === drag.rect || (rect && drag.rect && sameRect(rect, drag.rect))) return false;
    drag.rect = rect;
    return true;
  }

  end(): void {
    const armed = this.armed;
    if (armed && this.stamping) {
      this.stamping = false;
      const stamp = this.stamp;
      if (stamp) this.library.place(armed.typeId, armed.turn, stamp.minX, stamp.minZ);
      return;
    }
    const drag = this.drag;
    this.drag = null;
    const rect = drag?.rect;
    if (!drag || !rect) return;
    this.hover = null;
    const { handle } = drag;
    if (handle === null) this.plans.drawTable(rect);
    else if (!sameRect(rect, handle.rect))
      this.plans.placeTable(handle.planId, handle.tableId, rect);
  }

  cancel(): void {
    this.drag = null;
    this.hover = null;
    this.stamping = false;
  }

  removeHovered(): void {
    const hover = this.hover;
    if (!hover) return;
    this.hover = null;
    this.plans.removeTable(hover.planId, hover.tableId);
  }

  guides(): ReadonlyArray<GuideSegment> {
    const out: GuideSegment[] = [];
    for (const { rect } of this.shown()) {
      rulerGuides(widthRuler(rect), this.y, "ruler", out);
      rulerGuides(depthRuler(rect), this.y, "ruler", out);
    }
    const draft = this.drag?.rect ?? this.stamp;
    if (draft) outline(draft, this.y, out);
    else if (this.hover) edgeGuides(this.hover, this.y, out);
    return out;
  }

  labels(): ReadonlyArray<LabelView> {
    const out: LabelView[] = [];
    const drag = this.drag;
    for (const top of this.tops()) {
      const dragged = drag?.rect && drag.handle?.tableId === top.id ? drag.rect : top.surface;
      out.push(numberLabel(top, dragged, this.y));
    }
    for (const { id, rect } of this.shown()) dimensionLabels(id, rect, this.y, out);
    return out;
  }

  private stampAt(x: number, z: number): LduRect | null {
    const armed = this.armed;
    return armed ? this.library.stampAt(armed.typeId, armed.turn, x, z) : null;
  }

  private shown(): ReadonlyArray<ShownTable> {
    const drag = this.drag;
    const draggedId = drag?.handle?.tableId ?? null;
    const shown = this.tables().map(({ tableId, rect }) => ({
      id: tableId,
      rect: drag?.rect && tableId === draggedId ? drag.rect : rect,
    }));
    if (drag?.rect && draggedId === null) shown.push({ id: DRAFT_TABLE_ID, rect: drag.rect });
    if (this.stamp) shown.push({ id: STAMP_TABLE_ID, rect: this.stamp });
    return shown;
  }

  private tops(): ReadonlyArray<TableTop> {
    const planId = this.plans.activePlanId();
    return planId === null ? [] : this.plans.regionView(planId).tables;
  }

  private tables(): ReadonlyArray<TableHandle> {
    const planId = this.plans.activePlanId();
    if (planId === null) return [];
    return this.tops().map((top) => ({
      planId,
      tableId: top.id,
      rect: top.surface,
      edges: MOVE,
      typed: top.typeId !== undefined,
    }));
  }

  private handleAt(x: number, z: number, tolerance: number): TableHandle | null {
    for (const table of this.tables()) {
      const { rect } = table;
      const inX = x > rect.minX - tolerance && x < rect.maxX + tolerance;
      const inZ = z > rect.minZ - tolerance && z < rect.maxZ + tolerance;
      if (!inX || !inZ) continue;
      if (table.typed) return table;
      const [minX, maxX] = nearEdges(x, rect.minX, rect.maxX, tolerance);
      const [minZ, maxZ] = nearEdges(z, rect.minZ, rect.maxZ, tolerance);
      const onEdge = minX || maxX || minZ || maxZ;
      return { ...table, edges: onEdge ? { minX, maxX, minZ, maxZ } : MOVE };
    }
    return null;
  }
}
