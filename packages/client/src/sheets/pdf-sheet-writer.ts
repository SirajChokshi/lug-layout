import { inject, injectable } from "inversify";
import { SHEET_TYPEFACE } from "../tokens.ts";
import {
  samePaint,
  type DrawItem,
  type GroupItem,
  type Paint,
  type PaintedItem,
  type Point,
  type Rgb,
  type TextItem,
} from "./draw-list.ts";
import { PdfFile, pdfLiteral, pdfNumber, pdfTextString } from "./pdf/pdf-file.ts";
import { winAnsi } from "./pdf/win-ansi.ts";
import type { ISheetWriter, SheetDocument, SheetFile, SheetPage } from "./sheet-document.ts";
import { PAPER } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";

const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;
const POINTS_PER_MM = POINTS_PER_INCH / MM_PER_INCH;
const SCALE_DECIMALS = 10;
const COLOR_DECIMALS = 4;
const BYTE = 255;
const SVG_MITER_LIMIT = 4;
const HALO_MM = 0.8;
const ROUND_JOIN = 1;
const STROKE_TEXT = 1;
const FILL_TEXT = 0;
const CIRCLE_KAPPA = 0.5522847498307936;
const LISTED_MISSING = 10;
const PRODUCER = "Brick Railroad";
const REGULAR_FONT = "F1";
const BOLD_FONT = "F2";

function color(value: Rgb): string {
  return [value.r, value.g, value.b].map((c) => pdfNumber(c / BYTE, COLOR_DECIMALS)).join(" ");
}

function point([x, y]: Point): string {
  return `${pdfNumber(x)} ${pdfNumber(y)}`;
}

function paintOperator(paint: Paint): string {
  if (paint.fill !== null && paint.stroke !== null) return "B";
  if (paint.fill !== null) return "f";
  if (paint.stroke !== null) return "S";
  return "n";
}

function opacitiesOf(items: ReadonlyArray<DrawItem>, into: Set<number>): void {
  for (const item of items) {
    if (item.kind === "group") opacitiesOf(item.items, into);
    else if (item.kind !== "text" && item.paint.fill !== null && item.paint.fillOpacity !== 1) {
      into.add(item.paint.fillOpacity);
    }
  }
}

class PdfPageContent {
  private readonly out: string[] = [];

  constructor(
    private readonly typeface: ISheetTypeface,
    private readonly states: ReadonlyMap<number, string>,
    private readonly missing: Set<string>,
  ) {}

  content(page: SheetPage): string {
    const heightPt = page.size.heightMm * POINTS_PER_MM;
    const scale = pdfNumber(POINTS_PER_MM, SCALE_DECIMALS);
    this.out.push(
      "q",
      `${scale} 0 0 -${scale} 0 ${pdfNumber(heightPt)} cm`,
      `${SVG_MITER_LIMIT} M`,
    );
    this.items(page.items, 1);
    this.out.push("Q");
    return this.out.join("\n");
  }

  private items(items: ReadonlyArray<DrawItem>, scale: number): void {
    let run: PaintedItem[] = [];
    const flush = (): void => {
      const [first] = run;
      if (!first) return;
      this.out.push("q", ...this.paint(first.paint, scale));
      for (const item of run) this.painted(item);
      this.out.push("Q");
      run = [];
    };
    for (const item of items) {
      switch (item.kind) {
        case "rect":
        case "path":
        case "line":
        case "circle": {
          const [first] = run;
          if (first && !samePaint(first.paint, item.paint)) flush();
          run.push(item);
          break;
        }
        case "text":
          flush();
          this.text(item, scale);
          break;
        case "group":
          flush();
          this.group(item, scale);
          break;
        default: {
          const unhandled: never = item;
          throw new Error(`unhandled draw item ${String(unhandled)}`);
        }
      }
    }
    flush();
  }

  private paint(paint: Paint, scale: number): string[] {
    const ops: string[] = [];
    if (paint.fill !== null) {
      ops.push(`${color(paint.fill)} rg`);
      if (paint.fillOpacity !== 1) {
        const state = this.states.get(paint.fillOpacity);
        if (state === undefined) throw new Error(`no graphics state for ${paint.fillOpacity}`);
        ops.push(`/${state} gs`);
      }
    }
    if (paint.stroke !== null) {
      ops.push(`${color(paint.stroke)} RG`, `${pdfNumber(paint.strokeMm / scale)} w`);
      ops.push(`[${paint.dashMm.map((dash) => pdfNumber(dash / scale)).join(" ")}] 0 d`);
    }
    return ops;
  }

  private painted(item: PaintedItem): void {
    const operator = paintOperator(item.paint);
    switch (item.kind) {
      case "rect": {
        const { x, y, width, height } = item.box;
        this.out.push(
          `${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re ${operator}`,
        );
        return;
      }
      case "path": {
        const close = item.closed ? " h" : "";
        const rings = item.rings.filter((ring) => ring.length > 0);
        if (rings.length === 0) return;
        const segments = rings.map(
          (ring) =>
            `${ring.map((corner, i) => `${point(corner)} ${i === 0 ? "m" : "l"}`).join(" ")}${close}`,
        );
        this.out.push(`${segments.join(" ")} ${operator}`);
        return;
      }
      case "line":
        this.out.push(
          `${point(item.from)} m ${point(item.to)} l ${item.paint.stroke === null ? "n" : "S"}`,
        );
        return;
      case "circle": {
        const [cx, cy] = item.center;
        const r = item.radius;
        const k = r * CIRCLE_KAPPA;
        this.out.push(
          [
            `${point([cx + r, cy])} m`,
            `${point([cx + r, cy + k])} ${point([cx + k, cy + r])} ${point([cx, cy + r])} c`,
            `${point([cx - k, cy + r])} ${point([cx - r, cy + k])} ${point([cx - r, cy])} c`,
            `${point([cx - r, cy - k])} ${point([cx - k, cy - r])} ${point([cx, cy - r])} c`,
            `${point([cx + k, cy - r])} ${point([cx + r, cy - k])} ${point([cx + r, cy])} c`,
            `h ${operator}`,
          ].join(" "),
        );
        return;
      }
      default: {
        const unhandled: never = item;
        throw new Error(`unhandled painted item ${String(unhandled)}`);
      }
    }
  }

  private group(item: GroupItem, scale: number): void {
    const { transform } = item;
    this.out.push(
      "q",
      `${pdfNumber(transform.scale, SCALE_DECIMALS)} 0 0 ${pdfNumber(transform.scale, SCALE_DECIMALS)} ${pdfNumber(transform.dx)} ${pdfNumber(transform.dy)} cm`,
    );
    if (item.clip) {
      const { x, y, width, height } = item.clip;
      this.out.push(
        `${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re W n`,
      );
    }
    this.items(item.items, scale * transform.scale);
    this.out.push("Q");
  }

  private text(item: TextItem, scale: number): void {
    const { style } = item;
    const size = style.sizeMm / scale;
    const width = this.typeface.widthMm(item.text, size);
    const back = style.anchor === "start" ? 0 : style.anchor === "middle" ? width / 2 : width;
    const [x, y] = item.at;
    const matrix =
      item.turn === "none"
        ? `1 0 0 -1 ${pdfNumber(x - back)} ${pdfNumber(y)}`
        : `0 -1 -1 0 ${pdfNumber(x)} ${pdfNumber(y + back)}`;
    const encoded = winAnsi(item.text);
    for (const character of encoded.missing) this.missing.add(character);
    const font = `/${style.bold ? BOLD_FONT : REGULAR_FONT} ${pdfNumber(size)} Tf`;
    const shown = `${pdfLiteral(encoded.bytes)} Tj`;
    this.out.push("q");
    if (style.halo) {
      this.out.push(
        `${color(PAPER)} RG ${pdfNumber(HALO_MM / scale)} w ${ROUND_JOIN} j`,
        `BT ${font} ${STROKE_TEXT} Tr ${matrix} Tm ${shown} ET`,
      );
    }
    this.out.push(
      `${color(style.color)} rg`,
      `BT ${font} ${FILL_TEXT} Tr ${matrix} Tm ${shown} ET`,
      "Q",
    );
  }
}

@injectable()
export class PdfSheetWriter implements ISheetWriter {
  constructor(@inject(SHEET_TYPEFACE) private readonly typeface: ISheetTypeface) {}

  write(document: SheetDocument, baseName: string): SheetFile {
    const file = new PdfFile();
    const catalog = file.reserve();
    const pageTree = file.reserve();
    const regular = file.add(this.font(false));
    const bold = file.add(this.font(true));
    const opacities = new Set<number>();
    for (const page of document.pages) opacitiesOf(page.items, opacities);
    const states = new Map<number, string>();
    const stateRefs: string[] = [];
    [...opacities]
      .toSorted((a, b) => a - b)
      .forEach((opacity, i) => {
        const name = `GS${i + 1}`;
        states.set(opacity, name);
        const id = file.add(`<< /Type /ExtGState /ca ${pdfNumber(opacity)} >>`);
        stateRefs.push(`/${name} ${id} 0 R`);
      });
    const resources = `<< /Font << /${REGULAR_FONT} ${regular} 0 R /${BOLD_FONT} ${bold} 0 R >>${stateRefs.length === 0 ? "" : ` /ExtGState << ${stateRefs.join(" ")} >>`} >>`;
    const missing = new Set<string>();
    const pages = document.pages.map((page) => {
      const content = file.addStream(
        new PdfPageContent(this.typeface, states, missing).content(page),
      );
      const width = pdfNumber(page.size.widthMm * POINTS_PER_MM);
      const height = pdfNumber(page.size.heightMm * POINTS_PER_MM);
      return file.add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${width} ${height}] /Resources ${resources} /Contents ${content} 0 R >>`,
      );
    });
    file.set(
      pageTree,
      `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    );
    file.set(catalog, `<< /Type /Catalog /Pages ${pageTree} 0 R >>`);
    const info = file.add(
      `<< /Title ${pdfTextString(document.title)} /Producer ${pdfTextString(PRODUCER)} >>`,
    );
    return {
      fileName: `${baseName}.pdf`,
      mimeType: "application/pdf",
      bytes: file.bytes(catalog, info),
      pages: pages.length,
      notes: missingNote([...missing]),
    };
  }

  private font(bold: boolean): string {
    return `<< /Type /Font /Subtype /Type1 /BaseFont /${this.typeface.pdfFontName(bold)} /Encoding /WinAnsiEncoding >>`;
  }
}

function missingNote(missing: ReadonlyArray<string>): ReadonlyArray<string> {
  if (missing.length === 0) return [];
  const listed = missing.slice(0, LISTED_MISSING).join(" ");
  const more =
    missing.length > LISTED_MISSING ? ` and ${missing.length - LISTED_MISSING} more` : "";
  return [
    `${missing.length === 1 ? "1 character isn't" : `${missing.length} characters aren't`} in the PDF's standard Courier font and print as "?": ${listed}${more}. The SVG sheets keep them.`,
  ];
}
