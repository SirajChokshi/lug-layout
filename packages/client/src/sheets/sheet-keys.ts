import { lduFromMm } from "@brr/math";
import { cmText } from "../edit/size-labels.ts";
import type { PlanSheet, SheetPlacement } from "../plan/plan-sheet.ts";
import type { DrawItem, Paint, Point } from "./draw-list.ts";
import { drawableRings } from "./plan-drawing.ts";
import { plural, text, type Block } from "./sheet-blocks.ts";
import { PAINTS, SMALL_MM, TEXT_MM, textStyle } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";
import type { TableHeights } from "./table-heights.ts";

export interface KeyTable {
  readonly widthMm: number;
  readonly rowCount: number;
  breaksBefore(row: number): boolean;
  column(from: number, to: number, continuing: boolean): Block;
}

export const KEY_ROW_MM = 5;
const KEY_PARTS_MM = 30;
const KEY_LABEL_MM = 36;
const RULE_LIFT_MM = 3.5;
const NOTE_INDENT = "  ";
const COLUMN_GAP_CHARACTERS = 2;
const SWATCH_WIDTH_MM = 6;
const SWATCH_HEIGHT_MM = 3;
const TEXT_BOLD = textStyle(TEXT_MM, { bold: true });
const SMALL = textStyle(SMALL_MM);
const SMALL_BOLD = textStyle(SMALL_MM, { bold: true });
const SMALL_END = textStyle(SMALL_MM, { anchor: "end" });
const SMALL_BOLD_END = textStyle(SMALL_MM, { anchor: "end", bold: true });
const PLACEMENT_TITLE = "Key: numbers on the plan";
const TABLE_TITLE = "Tables: numbers on the plan";

function rule(from: Point, to: Point, paint: Paint = PAINTS.rule): DrawItem {
  return { kind: "line", role: "rule", paint, from, to };
}

function baseline(row: number): number {
  return (row + 1) * KEY_ROW_MM - 1;
}

function placementLine(placement: SheetPlacement): string {
  const notes = [placement.label];
  if (placement.flagged) notes.push("plan issue");
  if (!drawableRings(placement.rings)) notes.push("not drawn: no finite footprint");
  return notes.join(" · ");
}

const NOT_CHECKED_TITLE = "Not checked yet:";

type PlacementRow =
  | { readonly kind: "title" }
  | { readonly kind: "header" }
  | { readonly kind: "placement"; readonly placement: SheetPlacement; readonly label: string }
  | { readonly kind: "continuation"; readonly text: string }
  | { readonly kind: "total" }
  | { readonly kind: "gap" }
  | { readonly kind: "notes-title" }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "note-wrap"; readonly text: string };

const KEPT_WITH_NEXT: ReadonlySet<PlacementRow["kind"]> = new Set([
  "title",
  "header",
  "notes-title",
]);
const KEPT_WITH_PREVIOUS: ReadonlySet<PlacementRow["kind"]> = new Set([
  "continuation",
  "gap",
  "note-wrap",
]);

export class PlacementKey implements KeyTable {
  readonly widthMm: number;
  private readonly rows: ReadonlyArray<PlacementRow>;

  constructor(
    private readonly typeface: ISheetTypeface,
    private readonly sheet: PlanSheet,
    maxWidthMm: number,
  ) {
    let width = typeface.widthMm(PLACEMENT_TITLE, TEXT_MM);
    for (const placement of sheet.placements) {
      width = Math.max(width, KEY_LABEL_MM + typeface.widthMm(placementLine(placement), SMALL_MM));
    }
    this.widthMm = Math.min(width, maxWidthMm);
    this.rows = this.rowsAt(this.widthMm);
  }

  get rowCount(): number {
    return this.rows.length;
  }

  breaksBefore(row: number): boolean {
    const at = this.rows[row];
    const before = this.rows[row - 1];
    return (
      at !== undefined &&
      !KEPT_WITH_PREVIOUS.has(at.kind) &&
      (before === undefined || !KEPT_WITH_NEXT.has(before.kind))
    );
  }

  column(from: number, to: number, continuing: boolean): Block {
    const shown = this.rows.slice(from, to);
    const placementsContinue = shown.some(
      (row) => row.kind === "placement" || row.kind === "continuation",
    );
    const rows: PlacementRow[] = [
      ...(continuing && placementsContinue ? [{ kind: "header" } satisfies PlacementRow] : []),
      ...shown,
    ];
    return {
      width: this.widthMm,
      height: rows.length * KEY_ROW_MM,
      items: rows.flatMap((row, i) => this.row(row, baseline(i))),
    };
  }

  private rowsAt(widthMm: number): ReadonlyArray<PlacementRow> {
    const rows: PlacementRow[] = [{ kind: "title" }, { kind: "header" }];
    for (const placement of this.sheet.placements) {
      const [label = "", ...more] = this.typeface.wrapped(
        placementLine(placement),
        SMALL_MM,
        widthMm - KEY_LABEL_MM,
      );
      rows.push(
        { kind: "placement", placement, label },
        ...more.map((line): PlacementRow => ({ kind: "continuation", text: line })),
      );
    }
    rows.push({ kind: "total" });
    const { notChecked } = this.sheet.verdict;
    if (notChecked.length > 0) rows.push({ kind: "gap" }, { kind: "notes-title" });
    const indentMm = this.typeface.widthMm(NOTE_INDENT, SMALL_MM);
    for (const check of notChecked) {
      const [first = "", ...more] = this.typeface.wrapped(
        `· ${check}`,
        SMALL_MM,
        widthMm - indentMm,
      );
      rows.push(
        { kind: "note", text: first },
        ...more.map((line): PlacementRow => ({ kind: "note-wrap", text: `${NOTE_INDENT}${line}` })),
      );
    }
    return rows;
  }

  private row(row: PlacementRow, y: number): DrawItem[] {
    switch (row.kind) {
      case "title":
        return [text([0, y], PLACEMENT_TITLE, TEXT_BOLD)];
      case "header":
        return [
          text([0, y], "No.", SMALL_BOLD),
          text([KEY_PARTS_MM, y], "Parts", SMALL_BOLD_END),
          text([KEY_LABEL_MM, y], "Placement", SMALL_BOLD),
        ];
      case "placement":
        return [
          text([0, y], String(row.placement.number), SMALL_BOLD),
          text([KEY_PARTS_MM, y], row.placement.parts.toLocaleString("en-US"), SMALL_END),
          text([KEY_LABEL_MM, y], row.label, SMALL),
        ];
      case "continuation":
        return [text([KEY_LABEL_MM, y], row.text, SMALL)];
      case "total":
        return [
          rule([0, y - RULE_LIFT_MM], [this.widthMm, y - RULE_LIFT_MM]),
          text(
            [KEY_PARTS_MM, y],
            this.sheet.placements
              .reduce((sum, placement) => sum + placement.parts, 0)
              .toLocaleString("en-US"),
            SMALL_BOLD_END,
          ),
          text(
            [KEY_LABEL_MM, y],
            `Total: ${plural(this.sheet.placements.length, "placement", "placements")}`,
            SMALL_BOLD,
          ),
        ];
      case "gap":
        return [];
      case "notes-title":
        return [text([0, y], NOT_CHECKED_TITLE, SMALL)];
      case "note":
      case "note-wrap":
        return [text([0, y], row.text, SMALL)];
      default: {
        const unhandled: never = row;
        throw new Error(`unhandled key row ${String(unhandled)}`);
      }
    }
  }
}

interface ScheduleColumn {
  readonly header: string;
  readonly values: ReadonlyArray<string>;
}

type ScheduleRow =
  | { readonly kind: "title" }
  | { readonly kind: "header" }
  | { readonly kind: "table"; readonly index: number }
  | { readonly kind: "total" };

export class TableSchedule implements KeyTable {
  readonly widthMm: number;
  private readonly columns: ReadonlyArray<ScheduleColumn>;
  private readonly lefts: ReadonlyArray<number>;
  private readonly rows: ReadonlyArray<ScheduleRow>;

  constructor(
    private readonly typeface: ISheetTypeface,
    private readonly sheet: PlanSheet,
    private readonly heights: TableHeights,
    maxWidthMm: number,
  ) {
    const { tables, room } = sheet;
    this.columns = [
      { header: "No.", values: tables.map((_, i) => String(i + 1)) },
      { header: "Height", values: tables.map((t) => `${cmText(lduFromMm(t.heightMm))} cm`) },
      {
        header: "Size",
        values: tables.map(
          (t) =>
            `${cmText(t.surface.maxX - t.surface.minX)} × ${cmText(t.surface.maxZ - t.surface.minZ)} cm`,
        ),
      },
      {
        header: "Studs on the lattice",
        values: tables.map((t) => `${t.studs.studsWide} × ${t.studs.studsDeep}`),
      },
      {
        header: "From left, back wall",
        values: tables.map(
          (t) => `${cmText(t.surface.minX - room.minX)}, ${cmText(t.surface.minZ - room.minZ)} cm`,
        ),
      },
      { header: "Table", values: tables.map((t) => t.name) },
    ];
    const lefts: number[] = [];
    let at = 0;
    this.columns.forEach((column, i) => {
      lefts.push(at);
      const characters = Math.max(
        [...column.header].length,
        ...column.values.map((value) => [...value].length),
      );
      at += typeface.widthMm("x".repeat(characters + COLUMN_GAP_CHARACTERS), SMALL_MM);
      if (i === 0) at += SWATCH_WIDTH_MM + typeface.widthMm(" ", SMALL_MM);
    });
    this.lefts = lefts;
    this.widthMm = Math.min(Math.max(at, typeface.widthMm(TABLE_TITLE, TEXT_MM)), maxWidthMm);
    this.rows = [
      { kind: "title" },
      { kind: "header" },
      ...tables.map((_, index): ScheduleRow => ({ kind: "table", index })),
      { kind: "total" },
    ];
  }

  get rowCount(): number {
    return this.rows.length;
  }

  breaksBefore(row: number): boolean {
    return row > 0 && row < this.rows.length;
  }

  column(from: number, to: number, continuing: boolean): Block {
    const rows: ScheduleRow[] = [
      ...(continuing ? [{ kind: "header" } satisfies ScheduleRow] : []),
      ...this.rows.slice(from, to),
    ];
    return {
      width: this.widthMm,
      height: rows.length * KEY_ROW_MM,
      items: rows.flatMap((row, i) => this.row(row, baseline(i))),
    };
  }

  private cell(column: number, y: number, content: string, bold: boolean): DrawItem {
    const left = this.lefts[column] ?? 0;
    const last = column === this.columns.length - 1;
    const shown = last ? this.typeface.fitted(content, SMALL_MM, this.widthMm - left) : content;
    return text([left, y], shown, bold ? SMALL_BOLD : SMALL);
  }

  private row(row: ScheduleRow, y: number): DrawItem[] {
    switch (row.kind) {
      case "title":
        return [text([0, y], TABLE_TITLE, TEXT_BOLD)];
      case "header":
        return this.columns.map((column, i) => this.cell(i, y, column.header, true));
      case "table": {
        const table = this.sheet.tables[row.index];
        if (!table) return [];
        const swatchLeft =
          (this.lefts[1] ?? 0) - SWATCH_WIDTH_MM - this.typeface.widthMm(" ", SMALL_MM);
        return [
          ...this.columns.map((column, i) =>
            this.cell(i, y, column.values[row.index] ?? "", i === 0),
          ),
          {
            kind: "rect",
            role: "swatch",
            paint: this.heights.paintOf(table.heightMm),
            box: {
              x: swatchLeft,
              y: y - SWATCH_HEIGHT_MM + 0.5,
              width: SWATCH_WIDTH_MM,
              height: SWATCH_HEIGHT_MM,
            },
          },
        ];
      }
      case "total":
        return [
          rule([0, y - RULE_LIFT_MM], [this.widthMm, y - RULE_LIFT_MM]),
          text(
            [0, y],
            `${plural(this.sheet.tables.length, "table", "tables")} at ${plural(this.heights.heightsMm.length, "height", "heights")}`,
            SMALL_BOLD,
          ),
        ];
      default: {
        const unhandled: never = row;
        throw new Error(`unhandled schedule row ${String(unhandled)}`);
      }
    }
  }
}
