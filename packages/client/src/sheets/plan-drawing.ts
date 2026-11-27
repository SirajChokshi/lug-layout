import type { LduRect, OutlineRing } from "@brr/domain";
import { lduFromMm, mmFromLdu } from "@brr/math";
import { inject, injectable } from "inversify";
import { cmText, lengthText } from "../edit/size-labels.ts";
import type { PlanSheet, SheetPlacement } from "../plan/plan-sheet.ts";
import { SHEET_TYPEFACE } from "../tokens.ts";
import {
  group,
  type Box,
  type DrawItem,
  type Paint,
  type Point,
  type Similarity,
  type TextStyle,
} from "./draw-list.ts";
import { PAINTS, SMALL_MM, TEXT_MM, textStyle } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";
import type { TableHeights } from "./table-heights.ts";

export const SHEET_LAYER_IDS = [
  "room",
  "tables",
  "obstacles",
  "roadway",
  "models",
  "track",
  "ramps",
  "dimensions",
  "numbers",
  "table-numbers",
] as const;

export type SheetLayerId = (typeof SHEET_LAYER_IDS)[number];

export const GEOMETRY_LAYERS: ReadonlySet<SheetLayerId> = new Set([
  "room",
  "tables",
  "obstacles",
  "roadway",
  "models",
  "track",
  "ramps",
]);

export const PLAN_LAYERS: ReadonlySet<SheetLayerId> = new Set(
  SHEET_LAYER_IDS.filter((id) => id !== "table-numbers"),
);

export interface SheetLayer {
  readonly id: SheetLayerId;
  readonly items: ReadonlyArray<DrawItem>;
}

export interface SheetDrawing {
  readonly denominator: number;
  readonly extent: Box;
  readonly layers: ReadonlyArray<SheetLayer>;
}

export interface IPlanDrawing {
  draw(
    sheet: PlanSheet,
    denominator: number,
    layers: ReadonlySet<SheetLayerId>,
    heights?: TableHeights | null,
  ): SheetDrawing;
  extent(sheet: PlanSheet, denominator: number, layers: ReadonlySet<SheetLayerId>): Box;
  layersOf(sheet: PlanSheet): ReadonlyArray<SheetLayerId>;
}

const DIMENSION_BAND_MM = 18;
const PLAIN_BAND_MM = 4;
const DIMENSION_OFFSET_MM = 7;
const TICK_MM = 2;
const LABEL_LIFT_MM = 1;
const TABLE_TEXT_INSET_MM = 2;
const OBSTACLE_TEXT_INSET_MM = 1;
const NUMBER_RADIUS_MM = 3.5;
const HATCH_SPACING_MM = 4;

const SMALL_HALO = textStyle(SMALL_MM, { halo: true });
const SMALL_MIDDLE_HALO = textStyle(SMALL_MM, { anchor: "middle", halo: true });
const NUMBER_TEXT = textStyle(SMALL_MM, { anchor: "middle", bold: true });
const TABLE_NUMBER_RADIUS_MM = 5;
const TABLE_NUMBER_TEXT = textStyle(TEXT_MM, { anchor: "middle", bold: true });

function isFiniteRect(rect: LduRect): boolean {
  return (
    Number.isFinite(rect.minX) &&
    Number.isFinite(rect.minZ) &&
    Number.isFinite(rect.maxX) &&
    Number.isFinite(rect.maxZ)
  );
}

export function ringsBounds(rings: ReadonlyArray<OutlineRing>): LduRect {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
  }
  return { minX, minZ, maxX, maxZ };
}

export function rectRings({ minX, minZ, maxX, maxZ }: LduRect): ReadonlyArray<OutlineRing> {
  return [
    [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
    ],
  ];
}

export function drawableRings(rings: ReadonlyArray<OutlineRing>): boolean {
  return rings.length > 0 && isFiniteRect(ringsBounds(rings));
}

function unionOf(rects: ReadonlyArray<LduRect>): LduRect {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    if (!isFiniteRect(rect)) continue;
    minX = Math.min(minX, rect.minX);
    minZ = Math.min(minZ, rect.minZ);
    maxX = Math.max(maxX, rect.maxX);
    maxZ = Math.max(maxZ, rect.maxZ);
  }
  return isFiniteRect({ minX, minZ, maxX, maxZ }) ? { minX, minZ, maxX, maxZ } : EMPTY_RECT;
}

const EMPTY_RECT: LduRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

function rowRuns(cells: ReadonlyArray<LduRect>): LduRect[] {
  const sorted = cells.toSorted(
    (a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ || a.minX - b.minX || a.maxX - b.maxX,
  );
  const runs: LduRect[] = [];
  for (const cell of sorted) {
    const last = runs.at(-1);
    if (last && last.minZ === cell.minZ && last.maxZ === cell.maxZ && cell.minX <= last.maxX) {
      runs[runs.length - 1] = { ...last, maxX: Math.max(last.maxX, cell.maxX) };
    } else {
      runs.push(cell);
    }
  }
  return runs;
}

function mergedCells(cells: ReadonlyArray<LduRect>): LduRect[] {
  const columns = rowRuns(cells).toSorted(
    (a, b) => a.minX - b.minX || a.maxX - b.maxX || a.minZ - b.minZ,
  );
  const merged: LduRect[] = [];
  for (const run of columns) {
    const last = merged.at(-1);
    if (last && last.minX === run.minX && last.maxX === run.maxX && run.minZ <= last.maxZ) {
      merged[merged.length - 1] = { ...last, maxZ: Math.max(last.maxZ, run.maxZ) };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

export function sheetBounds(sheet: PlanSheet): LduRect {
  return unionOf([
    sheet.room,
    ...sheet.tables.map((table) => table.surface),
    ...sheet.obstacles.map((obstacle) => obstacle.rect),
    ...sheet.roadway,
    ...sheet.ramps.map(ringsBounds),
    ...sheet.placements.map((placement) => ringsBounds(placement.rings)),
  ]);
}

function bandFor(layers: ReadonlySet<SheetLayerId>): number {
  return layers.has("dimensions") ? DIMENSION_BAND_MM : PLAIN_BAND_MM;
}

class DrawingFrame {
  readonly mmPerLdu: number;

  constructor(
    private readonly sheet: PlanSheet,
    readonly bounds: LduRect,
    denominator: number,
    private readonly bandMm: number,
  ) {
    this.mmPerLdu = mmFromLdu(1) / denominator;
  }

  get extent(): Box {
    return {
      x: -this.bandMm,
      y: -this.bandMm,
      width: (this.bounds.maxX - this.bounds.minX) * this.mmPerLdu + 2 * this.bandMm,
      height: (this.bounds.maxZ - this.bounds.minZ) * this.mmPerLdu + 2 * this.bandMm,
    };
  }

  get lduTransform(): Similarity {
    return {
      scale: this.mmPerLdu,
      dx: -(this.bounds.minX - this.sheet.originX) * this.mmPerLdu,
      dy: -(this.bounds.minZ - this.sheet.originZ) * this.mmPerLdu,
    };
  }

  x(ldu: number): number {
    return (ldu - this.bounds.minX) * this.mmPerLdu;
  }

  z(ldu: number): number {
    return (ldu - this.bounds.minZ) * this.mmPerLdu;
  }

  localBox(rect: LduRect): Box {
    return {
      x: rect.minX - this.sheet.originX,
      y: rect.minZ - this.sheet.originZ,
      width: rect.maxX - rect.minX,
      height: rect.maxZ - rect.minZ,
    };
  }

  localRings(rings: ReadonlyArray<OutlineRing>): ReadonlyArray<ReadonlyArray<Point>> {
    return rings.map((ring) =>
      ring.map(([x, z]): Point => [x - this.sheet.originX, z - this.sheet.originZ]),
    );
  }

  hatch(rect: LduRect): ReadonlyArray<ReadonlyArray<Point>> {
    const spacing = HATCH_SPACING_MM / this.mmPerLdu;
    const box = this.localBox(rect);
    const left = box.x;
    const right = box.x + box.width;
    const top = box.y;
    const bottom = box.y + box.height;
    const segments: Point[][] = [];
    for (let k = Math.ceil((left - bottom) / spacing); k * spacing <= right - top; k++) {
      const offset = k * spacing;
      const from = Math.max(left, top + offset);
      const to = Math.min(right, bottom + offset);
      if (from < to) {
        segments.push([
          [from, from - offset],
          [to, to - offset],
        ]);
      }
    }
    return segments;
  }
}

function rectItem(role: string, paint: Paint, box: Box): DrawItem {
  return { kind: "rect", role, paint, box };
}

function path(role: string, paint: Paint, rings: ReadonlyArray<ReadonlyArray<Point>>): DrawItem {
  return { kind: "path", role, paint, rings, closed: true };
}

function dimensionLine(from: Point, to: Point): DrawItem {
  return { kind: "line", role: "dimension", paint: PAINTS.dimension, from, to };
}

function text(
  at: Point,
  content: string,
  style: TextStyle,
  turn: "none" | "counterclockwise" = "none",
): DrawItem {
  return { kind: "text", role: "label", style, at, text: content, turn };
}

function horizontalDimension(x1: number, x2: number, y: number, label: string): DrawItem[] {
  return [
    dimensionLine([x1, y], [x2, y]),
    dimensionLine([x1, y - TICK_MM], [x1, y + TICK_MM]),
    dimensionLine([x2, y - TICK_MM], [x2, y + TICK_MM]),
    text([(x1 + x2) / 2, y - LABEL_LIFT_MM], label, SMALL_MIDDLE_HALO),
  ];
}

function verticalDimension(x: number, z1: number, z2: number, label: string): DrawItem[] {
  return [
    dimensionLine([x, z1], [x, z2]),
    dimensionLine([x - TICK_MM, z1], [x + TICK_MM, z1]),
    dimensionLine([x - TICK_MM, z2], [x + TICK_MM, z2]),
    text([x - LABEL_LIFT_MM, (z1 + z2) / 2], label, SMALL_MIDDLE_HALO, "counterclockwise"),
  ];
}

function placementPaint(placement: SheetPlacement): Paint {
  switch (placement.segment) {
    case "model":
      return placement.flagged ? PAINTS.modelFlagged : PAINTS.model;
    case "track":
      return placement.flagged ? PAINTS.trackFlagged : PAINTS.track;
    default: {
      const unhandled: never = placement.segment;
      throw new Error(`unhandled plan segment ${String(unhandled)}`);
    }
  }
}

export function segmentLayer(segment: SheetPlacement["segment"]): SheetLayerId {
  switch (segment) {
    case "model":
      return "models";
    case "track":
      return "track";
    default: {
      const unhandled: never = segment;
      throw new Error(`unhandled plan segment ${String(unhandled)}`);
    }
  }
}

function placementRole(placement: SheetPlacement): string {
  return placement.flagged ? `${placement.segment} flagged` : placement.segment;
}

@injectable()
export class PlanDrawing implements IPlanDrawing {
  constructor(@inject(SHEET_TYPEFACE) private readonly typeface: ISheetTypeface) {}

  extent(sheet: PlanSheet, denominator: number, layers: ReadonlySet<SheetLayerId>): Box {
    return new DrawingFrame(sheet, sheetBounds(sheet), denominator, bandFor(layers)).extent;
  }

  layersOf(sheet: PlanSheet): ReadonlyArray<SheetLayerId> {
    const placed = sheet.placements.filter((placement) => drawableRings(placement.rings));
    const present: Readonly<Record<SheetLayerId, boolean>> = {
      room: isFiniteRect(sheet.room),
      tables: sheet.tables.some((table) => isFiniteRect(table.surface)),
      obstacles: sheet.obstacles.some((obstacle) => isFiniteRect(obstacle.rect)),
      roadway: sheet.roadway.some(isFiniteRect),
      models: placed.some((placement) => placement.segment === "model"),
      track: placed.some((placement) => placement.segment === "track"),
      ramps: sheet.ramps.some(drawableRings),
      dimensions:
        isFiniteRect(sheet.room) ||
        sheet.tables.some((table) => isFiniteRect(table.surface)) ||
        sheet.obstacles.some((obstacle) => isFiniteRect(obstacle.rect)),
      numbers: placed.length > 0,
      "table-numbers": sheet.tables.some((table) => isFiniteRect(table.surface)),
    };
    return SHEET_LAYER_IDS.filter((id) => present[id]);
  }

  draw(
    sheet: PlanSheet,
    denominator: number,
    layers: ReadonlySet<SheetLayerId>,
    heights: TableHeights | null = null,
  ): SheetDrawing {
    const frame = new DrawingFrame(sheet, sheetBounds(sheet), denominator, bandFor(layers));
    const drawn: SheetLayer[] = [];
    for (const id of SHEET_LAYER_IDS) {
      if (!layers.has(id)) continue;
      const items = this.layerItems(id, sheet, frame, heights, layers);
      if (items.length === 0) continue;
      drawn.push({
        id,
        items: [
          group(`layer-${id}`, items, GEOMETRY_LAYERS.has(id) ? frame.lduTransform : undefined),
        ],
      });
    }
    return { denominator, extent: frame.extent, layers: drawn };
  }

  private layerItems(
    id: SheetLayerId,
    sheet: PlanSheet,
    frame: DrawingFrame,
    heights: TableHeights | null,
    layers: ReadonlySet<SheetLayerId>,
  ): DrawItem[] {
    switch (id) {
      case "room":
        return isFiniteRect(sheet.room)
          ? [rectItem("room", PAINTS.room, frame.localBox(sheet.room))]
          : [];
      case "tables":
        return sheet.tables
          .filter((table) => isFiniteRect(table.surface))
          .map((table) =>
            rectItem(
              "table",
              heights ? heights.paintOf(table.heightMm) : PAINTS.table,
              frame.localBox(table.surface),
            ),
          );
      case "obstacles":
        return sheet.obstacles
          .filter((obstacle) => isFiniteRect(obstacle.rect))
          .flatMap((obstacle): DrawItem[] => [
            rectItem("obstacle", PAINTS.obstacle, frame.localBox(obstacle.rect)),
            {
              kind: "path",
              role: "hatch",
              paint: PAINTS.hatch,
              rings: frame.hatch(obstacle.rect),
              closed: false,
            },
          ]);
      case "roadway":
        return mergedCells(sheet.roadway)
          .filter(isFiniteRect)
          .map((run) => rectItem("roadway", PAINTS.roadway, frame.localBox(run)));
      case "models":
        return this.placementItems(sheet, frame, "model");
      case "track":
        return this.placementItems(sheet, frame, "track");
      case "ramps":
        return sheet.ramps
          .filter(drawableRings)
          .map((ramp) => path("ramp", PAINTS.ramp, frame.localRings(ramp)));
      case "dimensions":
        return this.dimensionItems(sheet, frame);
      case "numbers":
        return this.numberItems(sheet, frame, layers);
      case "table-numbers":
        return this.tableNumberItems(sheet, frame);
      default: {
        const unhandled: never = id;
        throw new Error(`unhandled sheet layer ${String(unhandled)}`);
      }
    }
  }

  private placementItems(
    sheet: PlanSheet,
    frame: DrawingFrame,
    segment: SheetPlacement["segment"],
  ): DrawItem[] {
    return sheet.placements
      .filter((placement) => placement.segment === segment && drawableRings(placement.rings))
      .map((placement) =>
        path(
          placementRole(placement),
          placementPaint(placement),
          frame.localRings(placement.rings),
        ),
      );
  }

  private dimensionItems(sheet: PlanSheet, frame: DrawingFrame): DrawItem[] {
    const items: DrawItem[] = [];
    for (const table of sheet.tables) {
      const { surface, studs } = table;
      if (!isFiniteRect(surface)) continue;
      const left = frame.x(surface.minX);
      const right = frame.x(surface.maxX);
      const top = frame.z(surface.minZ);
      const bottom = frame.z(surface.maxZ);
      items.push(
        ...horizontalDimension(
          left,
          right,
          top - DIMENSION_OFFSET_MM,
          lengthText(surface.maxX - surface.minX),
        ),
        ...verticalDimension(
          left - DIMENSION_OFFSET_MM,
          top,
          bottom,
          lengthText(surface.maxZ - surface.minZ),
        ),
        ...this.tableNotes(
          [
            `${table.name} · ${cmText(lduFromMm(table.heightMm))} cm high · ${studs.studsWide} × ${studs.studsDeep} studs on the lattice`,
            `from the left wall ${lengthText(surface.minX - sheet.room.minX)}, from the back wall ${lengthText(surface.minZ - sheet.room.minZ)}`,
          ],
          { x: left, y: top, width: right - left, height: bottom - top },
        ),
      );
    }
    const { room } = sheet;
    if (isFiniteRect(room)) {
      items.push(
        ...horizontalDimension(
          frame.x(room.minX),
          frame.x(room.maxX),
          frame.z(room.maxZ) + DIMENSION_OFFSET_MM + SMALL_MM,
          `room ${lengthText(room.maxX - room.minX)}`,
        ),
        ...verticalDimension(
          frame.x(room.maxX) + DIMENSION_OFFSET_MM + SMALL_MM,
          frame.z(room.minZ),
          frame.z(room.maxZ),
          `room ${lengthText(room.maxZ - room.minZ)}`,
        ),
      );
    }
    for (const obstacle of sheet.obstacles) {
      if (!isFiniteRect(obstacle.rect)) continue;
      items.push(
        text(
          [
            frame.x(obstacle.rect.minX) + OBSTACLE_TEXT_INSET_MM,
            frame.z(obstacle.rect.minZ) + SMALL_MM + OBSTACLE_TEXT_INSET_MM,
          ],
          obstacle.name,
          SMALL_HALO,
        ),
      );
    }
    return items;
  }

  private tableNotes(lines: ReadonlyArray<string>, table: Box): DrawItem[] {
    const width = table.width - 2 * TABLE_TEXT_INSET_MM;
    const rows = Math.floor((table.height - TABLE_TEXT_INSET_MM) / (SMALL_MM + LABEL_LIFT_MM));
    const shown = lines.slice(0, Math.max(0, rows));
    const bottom = table.y + table.height - TABLE_TEXT_INSET_MM;
    return shown.flatMap((line, i) => {
      const fitted = this.typeface.fitted(line, SMALL_MM, width);
      if (fitted === "") return [];
      const fromBottom = shown.length - 1 - i;
      return [
        text(
          [table.x + TABLE_TEXT_INSET_MM, bottom - fromBottom * (SMALL_MM + LABEL_LIFT_MM)],
          fitted,
          SMALL_HALO,
        ),
      ];
    });
  }

  private tableNumberItems(sheet: PlanSheet, frame: DrawingFrame): DrawItem[] {
    return sheet.tables.flatMap((table, i): DrawItem[] => {
      if (!isFiniteRect(table.surface)) return [];
      const cx = frame.x((table.surface.minX + table.surface.maxX) / 2);
      const cz = frame.z((table.surface.minZ + table.surface.maxZ) / 2);
      return [
        {
          kind: "circle",
          role: "table-number",
          paint: PAINTS.tableNumber,
          center: [cx, cz],
          radius: TABLE_NUMBER_RADIUS_MM,
        },
        {
          kind: "text",
          role: "table-number",
          style: TABLE_NUMBER_TEXT,
          at: [cx, cz + this.typeface.capHeightMm(TEXT_MM) / 2],
          text: String(i + 1),
          turn: "none",
        },
      ];
    });
  }

  private numberItems(
    sheet: PlanSheet,
    frame: DrawingFrame,
    layers: ReadonlySet<SheetLayerId>,
  ): DrawItem[] {
    return sheet.placements
      .filter(
        (placement) =>
          layers.has(segmentLayer(placement.segment)) && drawableRings(placement.rings),
      )
      .flatMap((placement): DrawItem[] => {
        const bounds = ringsBounds(placement.rings);
        const cx = frame.x((bounds.minX + bounds.maxX) / 2);
        const cz = frame.z((bounds.minZ + bounds.maxZ) / 2);
        return [
          {
            kind: "circle",
            role: placement.flagged ? "number flagged" : "number",
            paint: placement.flagged ? PAINTS.numberFlagged : PAINTS.number,
            center: [cx, cz],
            radius: NUMBER_RADIUS_MM,
          },
          {
            kind: "text",
            role: "number",
            style: NUMBER_TEXT,
            at: [cx, cz + this.typeface.capHeightMm(SMALL_MM) / 2],
            text: String(placement.number),
            turn: "none",
          },
        ];
      });
  }
}
