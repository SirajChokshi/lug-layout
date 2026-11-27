import type { LduRect } from "@brr/domain";
import { inject, injectable } from "inversify";
import { areaText } from "../edit/size-labels.ts";
import type { PlanSheet } from "../plan/plan-sheet.ts";
import { PLAN_DRAWING, SHEET_TILER, SHEET_TYPEFACE } from "../tokens.ts";
import { DrawBounds } from "./draw-bounds.ts";
import { group, IDENTITY, translation, type Box, type DrawItem, type Point } from "./draw-list.ts";
import { ISO_SCALE_DENOMINATORS, largestFittingScale, scaleText } from "./drawing-scale.ts";
import {
  orientationsFor,
  pageSize,
  paperSize,
  type Orientation,
  type PageSize,
  type PaperSize,
} from "./paper.ts";
import {
  ALL_LAYERS,
  GEOMETRY_LAYERS,
  type IPlanDrawing,
  type SheetDrawing,
  type SheetLayerId,
} from "./plan-drawing.ts";
import {
  CHECK_BAR_MM,
  partsListText,
  placed,
  plural,
  SheetBlocks,
  text,
  verdictText,
  type Block,
  type KeyRow,
  type TitleContent,
  type TitleLine,
} from "./sheet-blocks.ts";
import {
  sheetLayoutProblems,
  type SheetDocument,
  type SheetLayout,
  type SheetPage,
} from "./sheet-document.ts";
import { legendEntries, registrationMark, type LegendExtra } from "./sheet-legend.ts";
import { PAINTS, SMALL_MM, TEXT_MM, TITLE_MM, textStyle } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";
import type { ISheetTiler, TileGrid } from "./tile-grid.ts";

export interface ISheetComposer {
  compose(sheet: PlanSheet, layout: SheetLayout): SheetDocument;
}

const WHOLE_MARGIN_MM = 15;
const PAPER_MARGIN_MM = 10;
const GAP_MM = 8;
const FOOTER_LINES = 4;
const LINE_SPACING = 1.3;
const FOOTER_MM = FOOTER_LINES * SMALL_MM * LINE_SPACING + 2;
const REGISTRATION_REACH = 0.45;
const TILE_NAME_GAP_MM = 4;
const CHECK_TICK_MM = 2;
const MIN_KEY_ROWS = 3;
const PRINT_AT_100 = "print at 100% (actual size)";
const TILE_INSTRUCTIONS =
  "Print every page at 100% (actual size). Trim one page along a dashed seam and lay it over its neighbour so the registration marks meet.";
const TILE_NAME = textStyle(TITLE_MM, { bold: true });
const TILE_LABEL = textStyle(TEXT_MM, { bold: true, anchor: "middle", halo: true });
const CHECK_LABEL = textStyle(SMALL_MM, { anchor: "middle" });

type FooterKind =
  | { readonly kind: "disclaimer" }
  | { readonly kind: "page"; readonly label: string }
  | {
      readonly kind: "tile";
      readonly grid: TileGrid;
      readonly column: number;
      readonly row: number;
      readonly denominator: number;
    };

interface PageDraft {
  readonly name: string;
  readonly size: PageSize;
  readonly items: DrawItem[];
  readonly footer: FooterKind;
}

interface KeyRegion {
  readonly page: PageDraft;
  readonly box: Box;
}

type TitleFor = (denominator: number) => TitleContent;

const LONGEST_SCALE = ISO_SCALE_DENOMINATORS.at(-1) ?? 1;

interface BodyPage {
  readonly draft: PageDraft;
  readonly regions: ReadonlyArray<KeyRegion>;
  readonly keyWidthMm: number;
}

interface PaperPage {
  readonly orientation: Orientation;
  readonly size: PageSize;
  readonly content: Box;
}

function paperPage(paper: PaperSize, orientation: Orientation): PaperPage {
  const size = pageSize(paper, orientation);
  return {
    orientation,
    size,
    content: {
      x: PAPER_MARGIN_MM,
      y: PAPER_MARGIN_MM,
      width: size.widthMm - 2 * PAPER_MARGIN_MM,
      height: size.heightMm - 2 * PAPER_MARGIN_MM,
    },
  };
}

function fits(extent: Box, area: Box): boolean {
  return extent.width <= area.width && extent.height <= area.height;
}

function finiteRect(rect: LduRect): boolean {
  return [rect.minX, rect.minZ, rect.maxX, rect.maxZ].every(Number.isFinite);
}

function bestBy<T extends object>(candidates: ReadonlyArray<T>, cost: (candidate: T) => number): T {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (best === null || cost(candidate) < cost(best)) best = candidate;
  }
  if (best === null) throw new Error("no candidate layouts");
  return best;
}

interface DrawingView {
  readonly overlay: ReadonlyArray<DrawItem>;
  readonly origin: Point;
  readonly size: PageSize;
}

function placedDrawing(
  drawing: SheetDrawing,
  at: Point,
  origin: Point = [drawing.extent.x, drawing.extent.y],
  extra: ReadonlyArray<DrawItem> = [],
): DrawItem {
  return group(
    "drawing",
    [...drawing.layers.flatMap((layer) => layer.items), ...extra],
    translation(at[0] - origin[0], at[1] - origin[1]),
  );
}

@injectable()
export class SheetComposer implements ISheetComposer {
  private readonly blocks: SheetBlocks;
  private readonly bounds: DrawBounds;

  constructor(
    @inject(SHEET_TYPEFACE) private readonly typeface: ISheetTypeface,
    @inject(PLAN_DRAWING) private readonly drawings: IPlanDrawing,
    @inject(SHEET_TILER) private readonly tiler: ISheetTiler,
  ) {
    this.blocks = new SheetBlocks(typeface);
    this.bounds = new DrawBounds(typeface);
  }

  compose(sheet: PlanSheet, layout: SheetLayout): SheetDocument {
    const problems = sheetLayoutProblems(layout);
    if (problems.length > 0) throw new RangeError(problems.join(" "));
    switch (layout.kind) {
      case "whole":
        return this.finished(sheet, this.whole(sheet));
      case "fit":
        return this.finished(
          sheet,
          this.fitted(sheet, paperSize(layout.paper), layout.orientation),
        );
      case "tiled":
        return this.finished(
          sheet,
          this.tiled(
            sheet,
            paperSize(layout.paper),
            layout.orientation,
            layout.denominator,
            layout.overlapMm,
          ),
        );
      default: {
        const unhandled: never = layout;
        throw new Error(`unhandled sheet layout ${String(unhandled)}`);
      }
    }
  }

  private whole(sheet: PlanSheet): PageDraft[] {
    const drawing = this.drawings.draw(sheet, 1, ALL_LAYERS);
    const legend = this.legend(sheet, []);
    const keyWidth = this.blocks.keyWidth(sheet, Number.POSITIVE_INFINITY);
    const sideWidth = Math.max(legend.width, keyWidth);
    const contentWidth = drawing.extent.width + GAP_MM + sideWidth;
    const title = this.blocks.title(this.titleContent(sheet, 1, "drawn at 1:1", []), contentWidth);
    const top = WHOLE_MARGIN_MM + title.height;
    const sideLeft = WHOLE_MARGIN_MM + drawing.extent.width + GAP_MM;
    const key = this.blocks.keyColumn(sheet, this.blocks.keyRows(sheet, keyWidth), keyWidth);
    const bodyHeight = Math.max(drawing.extent.height, key.height + GAP_MM + legend.height);
    const page: PageDraft = {
      name: "sheet",
      size: {
        widthMm: 2 * WHOLE_MARGIN_MM + contentWidth,
        heightMm: top + bodyHeight + GAP_MM + SMALL_MM + WHOLE_MARGIN_MM,
      },
      items: [],
      footer: { kind: "disclaimer" },
    };
    page.items.push(
      placed("title-block", title, [WHOLE_MARGIN_MM, WHOLE_MARGIN_MM]),
      placedDrawing(drawing, [WHOLE_MARGIN_MM, top]),
      placed("key", key, [sideLeft, top]),
      placed("legend", legend, [sideLeft, top + key.height + GAP_MM]),
    );
    return [page];
  }

  private fitted(sheet: PlanSheet, paper: PaperSize, choice: Orientation | "auto"): PageDraft[] {
    const legend = this.legend(sheet, []);
    const titleFor =
      (orientation: Orientation): TitleFor =>
      (denominator) =>
        this.titleContent(
          sheet,
          denominator,
          `drawn at ${scaleText(denominator)} to fit one ${paper.name} page (${orientation})`,
          [],
        );
    const best = bestBy(
      orientationsFor(choice).map((orientation) => {
        const page = paperPage(paper, orientation);
        const area = this.bodyArea(page, legend, titleFor(orientation));
        const denominator = largestFittingScale((n) =>
          fits(this.drawings.extent(sheet, n, ALL_LAYERS), area),
        );
        return { page, area, denominator };
      }),
      (candidate) => candidate.denominator,
    );
    const drawing = this.drawings.draw(sheet, best.denominator, ALL_LAYERS);
    const first = this.bodyPage(
      "sheet",
      best.page,
      legend,
      titleFor(best.page.orientation),
      drawing,
      {
        overlay: [],
        origin: [drawing.extent.x, drawing.extent.y],
        size: { widthMm: drawing.extent.width, heightMm: drawing.extent.height },
      },
    );
    return this.withKey(sheet, best.page, first);
  }

  private tiled(
    sheet: PlanSheet,
    paper: PaperSize,
    choice: Orientation | "auto",
    denominator: number,
    overlapMm: number,
  ): PageDraft[] {
    const drawing = this.drawings.draw(sheet, denominator, ALL_LAYERS);
    const best = bestBy(
      orientationsFor(choice).map((orientation) => {
        const page = paperPage(paper, orientation);
        const window = {
          widthMm: page.content.width,
          heightMm: page.content.height - FOOTER_MM - GAP_MM / 2,
        };
        return { page, grid: this.tiler.tile(drawing.extent, window, overlapMm) };
      }),
      (candidate) => candidate.grid.count,
    );
    const { grid, page } = best;
    const legend = this.legend(sheet, ["tile", "registration", "seam"]);
    const titleFor: TitleFor = (indexDenominator) =>
      this.titleContent(
        sheet,
        indexDenominator,
        `tiled at ${scaleText(denominator)} over ${plural(grid.count, "page", "pages")} of ${paper.name} (${page.orientation}) with a ${overlapMm} mm overlap; this index is at ${scaleText(indexDenominator)}`,
        [{ text: TILE_INSTRUCTIONS, bold: false }],
        false,
      );
    const area = this.bodyArea(page, legend, titleFor);
    const covered = grid.covered;
    const indexDenominator = largestFittingScale((n) =>
      fits(
        {
          x: 0,
          y: 0,
          width: (covered.width * denominator) / n,
          height: (covered.height * denominator) / n,
        },
        area,
      ),
    );
    const factor = denominator / indexDenominator;
    const index = this.drawings.draw(sheet, indexDenominator, GEOMETRY_LAYERS);
    const cover = this.bodyPage("cover", page, legend, titleFor, index, {
      overlay: this.tileIndex(grid, factor),
      origin: [covered.x * factor, covered.y * factor],
      size: { widthMm: covered.width * factor, heightMm: covered.height * factor },
    });
    const pages = this.withKey(sheet, page, cover);
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        pages.push(this.tilePage(page, drawing, grid, column, row));
      }
    }
    return pages;
  }

  private bodyArea(page: PaperPage, legend: Block, title: TitleFor): Box {
    const titleHeight = this.blocks.title(title(LONGEST_SCALE), page.content.width).height;
    const { content } = page;
    return {
      x: content.x,
      y: content.y + titleHeight,
      width: content.width - legend.width - GAP_MM,
      height: content.height - titleHeight - FOOTER_MM - GAP_MM,
    };
  }

  private bodyPage(
    name: string,
    page: PaperPage,
    legend: Block,
    title: TitleFor,
    drawing: SheetDrawing,
    view: DrawingView,
  ): BodyPage {
    const area = this.bodyArea(page, legend, title);
    const { content } = page;
    const draft: PageDraft = {
      name,
      size: page.size,
      items: [],
      footer: { kind: "page", label: name },
    };
    const legendLeft = content.x + content.width - legend.width;
    draft.items.push(
      placed("title-block", this.blocks.title(title(drawing.denominator), content.width), [
        content.x,
        content.y,
      ]),
      placedDrawing(drawing, [area.x, area.y], view.origin, view.overlay),
      placed("legend", legend, [legendLeft, area.y]),
    );
    const drawnWidth = view.size.widthMm;
    const drawnHeight = view.size.heightMm;
    const bottom = area.y + area.height;
    const regions: KeyRegion[] = [
      {
        page: draft,
        box: {
          x: area.x + drawnWidth + GAP_MM,
          y: area.y,
          width: area.width - drawnWidth - GAP_MM,
          height: drawnHeight,
        },
      },
      {
        page: draft,
        box: {
          x: area.x,
          y: area.y + drawnHeight + GAP_MM,
          width: area.width,
          height: bottom - (area.y + drawnHeight + GAP_MM),
        },
      },
      {
        page: draft,
        box: {
          x: legendLeft,
          y: area.y + legend.height + GAP_MM,
          width: legend.width,
          height: bottom - (area.y + legend.height + GAP_MM),
        },
      },
    ];
    return { draft, regions, keyWidthMm: area.width };
  }

  private withKey(sheet: PlanSheet, page: PaperPage, first: BodyPage): PageDraft[] {
    const pages: PageDraft[] = [first.draft];
    const width = this.blocks.keyWidth(sheet, first.keyWidthMm);
    const rows = this.blocks.keyRows(sheet, width);
    const rowMm = this.blocks.keyRowMm;
    const regions = [...first.regions];
    let next = 0;
    while (next < rows.length) {
      const region = regions.shift() ?? this.keyPage(pages, page);
      const capacity = Math.floor(region.box.height / rowMm);
      if (width > region.box.width || capacity < MIN_KEY_ROWS) continue;
      const columns = Math.floor((region.box.width + GAP_MM) / (width + GAP_MM));
      for (let column = 0; column < columns && next < rows.length; column++) {
        const taken: KeyRow[] = [];
        const continuing = next > 0 && rows[next]?.kind !== "header";
        if (continuing) taken.push({ kind: "header" });
        while (taken.length < capacity && next < rows.length) {
          const row = rows[next];
          if (row) taken.push(row);
          next++;
        }
        region.page.items.push(
          placed("key", this.blocks.keyColumn(sheet, taken, width), [
            region.box.x + column * (width + GAP_MM),
            region.box.y,
          ]),
        );
      }
    }
    return pages;
  }

  private keyPage(pages: PageDraft[], page: PaperPage): KeyRegion {
    const draft: PageDraft = {
      name: `key-${pages.length}`,
      size: page.size,
      items: [],
      footer: { kind: "page", label: "key, continued" },
    };
    pages.push(draft);
    const { content } = page;
    return {
      page: draft,
      box: {
        x: content.x,
        y: content.y,
        width: content.width,
        height: content.height - FOOTER_MM - GAP_MM,
      },
    };
  }

  private tileIndex(grid: TileGrid, factor: number): DrawItem[] {
    const items: DrawItem[] = [];
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const cell = grid.cell(column, row);
        const box = {
          x: cell.x * factor,
          y: cell.y * factor,
          width: cell.width * factor,
          height: cell.height * factor,
        };
        items.push(
          { kind: "rect", role: "tile-cell", paint: PAINTS.tileCell, box },
          text(
            [
              box.x + box.width / 2,
              box.y + box.height / 2 + this.typeface.capHeightMm(TEXT_MM) / 2,
            ],
            grid.name(column, row),
            TILE_LABEL,
            "tile-cell",
          ),
        );
      }
    }
    return [group("tile-index", items)];
  }

  private tilePage(
    page: PaperPage,
    drawing: SheetDrawing,
    grid: TileGrid,
    column: number,
    row: number,
  ): PageDraft {
    const window = grid.window(column, row);
    const covered = grid.covered;
    const at: Point = [page.content.x, page.content.y];
    const reach = grid.overlapMm * REGISTRATION_REACH;
    const overlays: DrawItem[] = [
      ...grid.seamsX().map((x): DrawItem => ({
        kind: "line",
        role: "seam",
        paint: PAINTS.seam,
        from: [x, covered.y],
        to: [x, covered.y + covered.height],
      })),
      ...grid.seamsY().map((y): DrawItem => ({
        kind: "line",
        role: "seam",
        paint: PAINTS.seam,
        from: [covered.x, y],
        to: [covered.x + covered.width, y],
      })),
      ...grid.marks().flatMap((mark) => registrationMark(mark, reach)),
    ];
    const content = [...drawing.layers.flatMap((layer) => layer.items), ...overlays];
    return {
      name: grid.name(column, row),
      size: page.size,
      items: [
        group(
          "tile",
          this.bounds.culled(content, IDENTITY, window),
          translation(at[0] - window.x, at[1] - window.y),
          window,
        ),
        {
          kind: "rect",
          role: "frame",
          paint: PAINTS.frame,
          box: { x: at[0], y: at[1], width: window.width, height: window.height },
        },
      ],
      footer: { kind: "tile", grid, column, row, denominator: drawing.denominator },
    };
  }

  private legend(sheet: PlanSheet, extras: ReadonlyArray<LegendExtra>): Block {
    const layers: ReadonlyArray<SheetLayerId> = this.drawings.layersOf(sheet);
    const flagged =
      sheet.placements.some((placement) => placement.flagged) &&
      (layers.includes("models") || layers.includes("track"));
    return this.blocks.legend(legendEntries(layers, flagged ? ["issue", ...extras] : extras));
  }

  private titleContent(
    sheet: PlanSheet,
    denominator: number,
    scaleLine: string,
    extra: ReadonlyArray<TitleLine>,
    printNote = true,
  ): TitleContent {
    const { room } = sheet;
    const roomText = finiteRect(room)
      ? `Room ${areaText(room.maxX - room.minX, room.maxZ - room.minZ)}`
      : "No room drawn";
    return {
      name: sheet.name,
      denominator,
      lines: [
        {
          text: `${roomText} · ${plural(sheet.tables.length, "table", "tables")} · ${scaleLine}${printNote ? `, ${PRINT_AT_100}` : ""}`,
          bold: false,
        },
        ...extra,
        { text: verdictText(sheet), bold: true },
        { text: partsListText(sheet), bold: false },
      ],
    };
  }

  private finished(sheet: PlanSheet, drafts: ReadonlyArray<PageDraft>): SheetDocument {
    const pages: SheetPage[] = drafts.map((draft, i) => ({
      name: draft.name,
      size: draft.size,
      items: [
        {
          kind: "rect",
          role: "page",
          paint: PAINTS.page,
          box: { x: 0, y: 0, width: draft.size.widthMm, height: draft.size.heightMm },
        },
        ...draft.items,
        ...this.footer(sheet, draft, i + 1, drafts.length),
      ],
    }));
    return { title: sheet.name, pages };
  }

  private footer(sheet: PlanSheet, draft: PageDraft, number: number, total: number): DrawItem[] {
    const { widthMm, heightMm } = draft.size;
    const footer = draft.footer;
    switch (footer.kind) {
      case "disclaimer":
        return [
          text(
            [WHOLE_MARGIN_MM, heightMm - WHOLE_MARGIN_MM],
            sheet.disclaimer,
            textStyle(SMALL_MM),
            "footer",
          ),
        ];
      case "page": {
        const width = widthMm - 2 * PAPER_MARGIN_MM;
        const block = this.blocks.footerLines(
          [`${sheet.name} · ${footer.label} · page ${number} of ${total}`, sheet.disclaimer],
          width,
        );
        return [
          placed("footer", block, [PAPER_MARGIN_MM, heightMm - PAPER_MARGIN_MM - block.height]),
        ];
      }
      case "tile":
        return this.tileFooter(sheet, draft.size, footer, number, total);
      default: {
        const unhandled: never = footer;
        throw new Error(`unhandled footer ${String(unhandled)}`);
      }
    }
  }

  private tileFooter(
    sheet: PlanSheet,
    size: PageSize,
    footer: Extract<FooterKind, { kind: "tile" }>,
    number: number,
    total: number,
  ): DrawItem[] {
    const { grid, column, row, denominator } = footer;
    const name = grid.name(column, row);
    const top = size.heightMm - PAPER_MARGIN_MM - FOOTER_MM + 1;
    const nameWidth = this.typeface.widthMm(name, TITLE_MM);
    const left = PAPER_MARGIN_MM + nameWidth + TILE_NAME_GAP_MM;
    const barLeft = size.widthMm - PAPER_MARGIN_MM - CHECK_BAR_MM;
    const neighbours = grid.neighbours(column, row);
    const sides = [
      neighbours.left === null ? null : `left ${neighbours.left}`,
      neighbours.right === null ? null : `right ${neighbours.right}`,
      neighbours.above === null ? null : `above ${neighbours.above}`,
      neighbours.below === null ? null : `below ${neighbours.below}`,
    ].filter((side) => side !== null);
    const beside = this.blocks.footerLines(
      [
        `tile ${name} · column ${column + 1} of ${grid.columns}, row ${row + 1} of ${grid.rows} · page ${number} of ${total}`,
        sides.length === 0 ? "a single page" : `joins ${sides.join(", ")}`,
      ].map((line) => this.typeface.fitted(line, SMALL_MM, barLeft - GAP_MM - left)),
      barLeft - GAP_MM - left,
    );
    const below = this.blocks.footerLines(
      [`${sheet.name} · ${scaleText(denominator)}, ${PRINT_AT_100}`, sheet.disclaimer],
      size.widthMm - 2 * PAPER_MARGIN_MM,
    );
    const barY = top + SMALL_MM * LINE_SPACING + CHECK_TICK_MM;
    return [
      text([PAPER_MARGIN_MM, top + TITLE_MM], name, TILE_NAME, "tile-name"),
      placed("footer", beside, [left, top]),
      placed("footer", below, [PAPER_MARGIN_MM, top + beside.height]),
      group("check-bar", [
        {
          kind: "line",
          role: "check-bar",
          paint: PAINTS.dimension,
          from: [barLeft, barY],
          to: [barLeft + CHECK_BAR_MM, barY],
        },
        {
          kind: "line",
          role: "check-bar",
          paint: PAINTS.dimension,
          from: [barLeft, barY - CHECK_TICK_MM],
          to: [barLeft, barY + CHECK_TICK_MM],
        },
        {
          kind: "line",
          role: "check-bar",
          paint: PAINTS.dimension,
          from: [barLeft + CHECK_BAR_MM, barY - CHECK_TICK_MM],
          to: [barLeft + CHECK_BAR_MM, barY + CHECK_TICK_MM],
        },
      ]),
      text(
        [barLeft + CHECK_BAR_MM / 2, barY - CHECK_TICK_MM - 0.5],
        `this bar measures ${CHECK_BAR_MM} mm at 100%`,
        CHECK_LABEL,
        "check-bar",
      ),
    ];
  }
}
