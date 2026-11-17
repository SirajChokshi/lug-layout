import type { LduRect } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import type { GuideSegment } from "@brr/render";
import type { IPlanService } from "../plan/plan-service.ts";
import {
  GUIDE_GRID_LDU,
  lengthText,
  rulerGuides,
  type LabelView,
  type Ruler,
} from "./layout-guides.ts";

const DIMENSION_OFFSET_LDU = 3 * STUD_LDU;

export interface TableEdges {
  readonly minX: boolean;
  readonly maxX: boolean;
  readonly minZ: boolean;
  readonly maxZ: boolean;
}

export interface TableHandle {
  readonly tableId: string;
  readonly rect: LduRect;
  readonly edges: TableEdges;
}

interface TableDrag {
  readonly handle: TableHandle | null;
  readonly startX: number;
  readonly startZ: number;
  rect: LduRect | null;
}

const MOVE: TableEdges = { minX: true, maxX: true, minZ: true, maxZ: true };

export function snapToGuideGrid(ldu: number): number {
  return Math.round(ldu / GUIDE_GRID_LDU) * GUIDE_GRID_LDU + 0;
}

function isMove(edges: TableEdges): boolean {
  return edges.minX && edges.maxX && edges.minZ && edges.maxZ;
}

function spanned(a: number, b: number): readonly [number, number] {
  const lo = snapToGuideGrid(Math.min(a, b));
  const hi = snapToGuideGrid(Math.max(a, b));
  return hi > lo ? [lo, hi] : [lo, lo + GUIDE_GRID_LDU];
}

export function drawnRect(ax: number, az: number, bx: number, bz: number): LduRect {
  const [minX, maxX] = spanned(ax, bx);
  const [minZ, maxZ] = spanned(az, bz);
  return { minX, minZ, maxX, maxZ };
}

export function movedRect(rect: LduRect, edges: TableEdges, dx: number, dz: number): LduRect {
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
  const minX = edges.minX
    ? Math.min(snapToGuideGrid(rect.minX + dx), rect.maxX - GUIDE_GRID_LDU)
    : rect.minX;
  const maxX = edges.maxX
    ? Math.max(snapToGuideGrid(rect.maxX + dx), rect.minX + GUIDE_GRID_LDU)
    : rect.maxX;
  const minZ = edges.minZ
    ? Math.min(snapToGuideGrid(rect.minZ + dz), rect.maxZ - GUIDE_GRID_LDU)
    : rect.minZ;
  const maxZ = edges.maxZ
    ? Math.max(snapToGuideGrid(rect.maxZ + dz), rect.minZ + GUIDE_GRID_LDU)
    : rect.maxZ;
  return { minX, minZ, maxX, maxZ };
}

function outline(rect: LduRect, y: number, kind: GuideSegment["kind"]): GuideSegment[] {
  const { minX, minZ, maxX, maxZ } = rect;
  return [
    { kind, ax: minX, ay: y, az: minZ, bx: maxX, by: y, bz: minZ },
    { kind, ax: maxX, ay: y, az: minZ, bx: maxX, by: y, bz: maxZ },
    { kind, ax: maxX, ay: y, az: maxZ, bx: minX, by: y, bz: maxZ },
    { kind, ax: minX, ay: y, az: maxZ, bx: minX, by: y, bz: minZ },
  ];
}

function edgeSegments(handle: TableHandle, y: number): GuideSegment[] {
  const { rect, edges } = handle;
  const [north, east, south, west] = outline(rect, y, "draft");
  if (isMove(edges)) return outline(rect, y, "draft");
  return [
    ...(edges.minZ && north ? [north] : []),
    ...(edges.maxX && east ? [east] : []),
    ...(edges.maxZ && south ? [south] : []),
    ...(edges.minX && west ? [west] : []),
  ];
}

function widthRuler(rect: LduRect): Ruler {
  const z = rect.minZ - DIMENSION_OFFSET_LDU;
  return { ax: rect.minX, az: z, bx: rect.maxX, bz: z };
}

function depthRuler(rect: LduRect): Ruler {
  const x = rect.maxX + DIMENSION_OFFSET_LDU;
  return { ax: x, az: rect.minZ, bx: x, bz: rect.maxZ };
}

function dimensionLabels(id: string, rect: LduRect, y: number): LabelView[] {
  const width = widthRuler(rect);
  const depth = depthRuler(rect);
  return [
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
  ];
}

export class TableTool {
  private hover: TableHandle | null = null;
  private drag: TableDrag | null = null;

  constructor(private readonly plans: IPlanService) {}

  tables(): ReadonlyArray<TableHandle> {
    const snapshot = this.plans.snapshot();
    const check = snapshot.checks.find((c) => c.regionId === snapshot.activePlanId);
    return (check?.tables ?? []).map((top) => ({
      tableId: top.id,
      rect: top.surface,
      edges: MOVE,
    }));
  }

  handleAt(x: number, z: number, tolerance: number): TableHandle | null {
    for (const table of this.tables()) {
      const { rect } = table;
      const inX = x > rect.minX - tolerance && x < rect.maxX + tolerance;
      const inZ = z > rect.minZ - tolerance && z < rect.maxZ + tolerance;
      if (!inX || !inZ) continue;
      const edges: TableEdges = {
        minX: Math.abs(x - rect.minX) <= tolerance,
        maxX: Math.abs(x - rect.maxX) <= tolerance,
        minZ: Math.abs(z - rect.minZ) <= tolerance,
        maxZ: Math.abs(z - rect.maxZ) <= tolerance,
      };
      const onEdge = edges.minX || edges.maxX || edges.minZ || edges.maxZ;
      return { ...table, edges: onEdge ? edges : MOVE };
    }
    return null;
  }

  hoverAt(x: number, z: number, tolerance: number): void {
    if (!this.drag) this.hover = this.handleAt(x, z, tolerance);
  }

  hovered(): TableHandle | null {
    return this.hover;
  }

  begin(x: number, z: number, tolerance: number): void {
    this.drag = { handle: this.handleAt(x, z, tolerance), startX: x, startZ: z, rect: null };
  }

  move(x: number, z: number): void {
    const drag = this.drag;
    if (!drag) return;
    drag.rect = drag.handle
      ? movedRect(drag.handle.rect, drag.handle.edges, x - drag.startX, z - drag.startZ)
      : drawnRect(drag.startX, drag.startZ, x, z);
  }

  end(): boolean {
    const drag = this.drag;
    this.drag = null;
    const rect = drag?.rect;
    if (!drag || !rect) return false;
    const planId = this.plans.snapshot().activePlanId;
    if (drag.handle && planId !== null) this.plans.placeTable(planId, drag.handle.tableId, rect);
    else this.plans.drawTable(rect);
    this.hover = null;
    return true;
  }

  cancel(): void {
    this.drag = null;
    this.hover = null;
  }

  removeHovered(): void {
    const planId = this.plans.snapshot().activePlanId;
    if (!this.hover || planId === null) return;
    this.plans.removeTable(planId, this.hover.tableId);
    this.hover = null;
  }

  guides(y: number): GuideSegment[] {
    const draft = this.drag?.rect ?? null;
    const shown = this.tables().map((t) =>
      draft && t.tableId === this.drag?.handle?.tableId ? draft : t.rect,
    );
    if (draft && !this.drag?.handle) shown.push(draft);
    const segments = shown.flatMap((rect) => [
      ...rulerGuides(widthRuler(rect), y, "dimension"),
      ...rulerGuides(depthRuler(rect), y, "dimension"),
    ]);
    if (draft) segments.push(...outline(draft, y, "draft"));
    else if (this.hover) segments.push(...edgeSegments(this.hover, y));
    return segments;
  }

  labels(y: number): LabelView[] {
    const draft = this.drag?.rect ?? null;
    const draggedId = this.drag?.handle?.tableId ?? null;
    const labels = this.tables().flatMap((t) =>
      dimensionLabels(t.tableId, draft && t.tableId === draggedId ? draft : t.rect, y),
    );
    if (draft && draggedId === null) labels.push(...dimensionLabels("draft-table", draft, y));
    return labels;
  }
}
