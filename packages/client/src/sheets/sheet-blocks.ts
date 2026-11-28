import { STUD_LDU } from "@brr/math";
import { lengthText } from "../edit/size-labels.ts";
import type { PlanSheet } from "../plan/plan-sheet.ts";
import {
  group,
  translation,
  type Box,
  type DrawItem,
  type GroupItem,
  type Paint,
  type Point,
  type TextStyle,
} from "./draw-list.ts";
import { scaleText } from "./drawing-scale.ts";
import { PAINTS, SMALL_MM, TEXT_MM, TITLE_MM, textStyle } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";

export interface Block {
  readonly width: number;
  readonly height: number;
  readonly items: ReadonlyArray<DrawItem>;
}

export function placed(role: string, block: Block | ReadonlyArray<DrawItem>, at: Point): GroupItem {
  const items = "items" in block ? block.items : block;
  return group(role, items, translation(at[0], at[1]));
}

export const CHECK_BAR_MM = 64;
const CHECK_BAR_STUDS = 8;
const TICK_MM = 2;
const LINE_SPACING = 1.3;
const TITLE_SPACING = 1.25;
const CHECK_LABEL_GAP_MM = 4;
const LEGEND_SWATCH_MM = 8;
const LEGEND_SWATCH_HEIGHT_MM = 4;
const LEGEND_LABEL_GAP_MM = 3;
const LEGEND_ROW_MM = 6;
const BLOCK_PADDING_MM = 4;
const TITLE_STYLE = textStyle(TITLE_MM, { bold: true });
const TEXT = textStyle(TEXT_MM);
const TEXT_BOLD = textStyle(TEXT_MM, { bold: true });
const SMALL = textStyle(SMALL_MM);

export function text(at: Point, content: string, style: TextStyle, role = "label"): DrawItem {
  return { kind: "text", role, style, at, text: content, turn: "none" };
}

function rule(from: Point, to: Point, paint: Paint = PAINTS.rule, role = "rule"): DrawItem {
  return { kind: "line", role, paint, from, to };
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface TitleLine {
  readonly text: string;
  readonly bold: boolean;
}

export interface TitleContent {
  readonly name: string;
  readonly lines: ReadonlyArray<TitleLine>;
  readonly denominator: number;
  readonly pixelsPerMm?: number;
}

export function verdictText({ verdict }: PlanSheet): string {
  if (verdict.unchecked !== null) return `Plan rules couldn't be checked: ${verdict.unchecked}`;
  if (verdict.buildable) return "Buildable as planned";
  const reasons = [verdict.issues === 0 ? "no errors" : plural(verdict.issues, "error", "errors")];
  if (verdict.unmeasured > 0) {
    reasons.push(`${plural(verdict.unmeasured, "placement", "placements")} not measured yet`);
  }
  if (verdict.notChecked.length > 0) {
    reasons.push(
      `${plural(verdict.notChecked.length, "check", "checks")} not made yet (see the key)`,
    );
  }
  return `Not buildable as planned yet: ${reasons.join(", ")}`;
}

export function partsListText({ partsList }: PlanSheet): string {
  if (partsList === null) return "Parts list: not counted while the plan rules can't be checked";
  const uncounted =
    partsList.uncounted > 0
      ? `, and ${plural(partsList.uncounted, "item", "items")} it can't count`
      : "";
  return `Parts list: ${partsList.parts.toLocaleString("en-US")} parts in ${plural(partsList.lines, "part and colour line", "part and colour lines")}, from ${plural(partsList.placements, "placement", "placements")}${uncounted}`;
}

export interface LegendEntry {
  readonly label: string;
  readonly swatch: (box: Box) => ReadonlyArray<DrawItem>;
}

export class SheetBlocks {
  constructor(private readonly typeface: ISheetTypeface) {}

  title(content: TitleContent, widthMm: number): Block {
    const items: DrawItem[] = [];
    let y = 0;
    for (const line of this.typeface.wrapped(content.name, TITLE_MM, widthMm)) {
      items.push(text([0, y + TITLE_MM], line, TITLE_STYLE, "title"));
      y += TITLE_MM * TITLE_SPACING;
    }
    for (const line of content.lines) {
      for (const wrapped of this.typeface.wrapped(line.text, TEXT_MM, widthMm)) {
        items.push(text([0, y + TEXT_MM], wrapped, line.bold ? TEXT_BOLD : TEXT));
        y += TEXT_MM * LINE_SPACING;
      }
    }
    y += BLOCK_PADDING_MM;
    const bar = this.checkBar(content.denominator, widthMm, content.pixelsPerMm);
    items.push(placed("check", bar, [0, y]));
    y += bar.height + BLOCK_PADDING_MM;
    items.push(rule([0, y], [widthMm, y]));
    return { width: widthMm, height: y + BLOCK_PADDING_MM, items };
  }

  checkBar(denominator: number, widthMm: number, pixelsPerMm?: number): Block {
    const barY = TICK_MM;
    const length = lengthText(CHECK_BAR_STUDS * denominator * STUD_LDU);
    const scale = denominator === 1 ? "" : ` at ${scaleText(denominator)}`;
    const label = this.typeface.fitted(
      pixelsPerMm === undefined
        ? `this bar measures ${CHECK_BAR_MM} mm at 100%: ${length}${scale}`
        : `this bar is ${CHECK_BAR_MM * pixelsPerMm} px at ${pixelsPerMm} px per mm: ${length}`,
      SMALL_MM,
      widthMm - CHECK_BAR_MM - CHECK_LABEL_GAP_MM,
    );
    return {
      width: widthMm,
      height: 2 * TICK_MM,
      items: [
        group("check-bar", [
          rule([0, barY], [CHECK_BAR_MM, barY], PAINTS.dimension, "check-bar"),
          rule([0, barY - TICK_MM], [0, barY + TICK_MM], PAINTS.dimension, "check-bar"),
          rule(
            [CHECK_BAR_MM, barY - TICK_MM],
            [CHECK_BAR_MM, barY + TICK_MM],
            PAINTS.dimension,
            "check-bar",
          ),
        ]),
        text([CHECK_BAR_MM + CHECK_LABEL_GAP_MM, barY + SMALL_MM / 3], label, SMALL),
      ],
    };
  }

  legend(entries: ReadonlyArray<LegendEntry>): Block {
    const labelX = LEGEND_SWATCH_MM + LEGEND_LABEL_GAP_MM;
    const items: DrawItem[] = [text([0, TEXT_MM], "Legend", TEXT_BOLD)];
    let width = this.typeface.widthMm("Legend", TEXT_MM);
    entries.forEach((entry, i) => {
      const top = TEXT_MM * LINE_SPACING + i * LEGEND_ROW_MM + 1;
      items.push(
        group(
          "legend-swatch",
          entry.swatch({
            x: 0,
            y: top,
            width: LEGEND_SWATCH_MM,
            height: LEGEND_SWATCH_HEIGHT_MM,
          }),
        ),
        text([labelX, top + LEGEND_SWATCH_HEIGHT_MM - 0.5], entry.label, SMALL, "legend"),
      );
      width = Math.max(width, labelX + this.typeface.widthMm(entry.label, SMALL_MM));
    });
    return {
      width,
      height: TEXT_MM * LINE_SPACING + entries.length * LEGEND_ROW_MM + BLOCK_PADDING_MM,
      items,
    };
  }

  footerLines(lines: ReadonlyArray<string>, widthMm: number, style: TextStyle = SMALL): Block {
    const wrapped = lines.flatMap((line) => this.typeface.wrapped(line, style.sizeMm, widthMm));
    const items = wrapped.map((line, i) =>
      text([0, (i + 1) * style.sizeMm * LINE_SPACING], line, style, "footer"),
    );
    return { width: widthMm, height: wrapped.length * style.sizeMm * LINE_SPACING, items };
  }
}
