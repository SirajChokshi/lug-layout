import { writeStoredZip } from "@brr/storage/zip";
import { inject, injectable } from "inversify";
import { SHEET_TYPEFACE } from "../tokens.ts";
import {
  samePaint,
  type DrawItem,
  type GroupItem,
  type Paint,
  type PaintedItem,
  type Rgb,
  type Similarity,
  type TextItem,
} from "./draw-list.ts";
import type { SheetDocument, SheetPage } from "./sheet-document.ts";
import { PAPER } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";

export interface SheetFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly pages: number;
}

export interface ISheetWriter {
  write(document: SheetDocument, baseName: string): SheetFile;
}

export interface ISvgSheetWriter extends ISheetWriter {
  pageSvg(page: SheetPage, title: string): string;
}

const DECIMALS = 1000;
const SCALE_DIGITS = 12;
const HALO_MM = 0.8;
const PAGE_NUMBER_DIGITS = 2;
const FIRST_PRINTABLE = 0x20;
const XML_WHITESPACE = new Set([0x09, 0x0a, 0x0d]);

function xmlCharacters(content: string): string {
  return [...content]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= FIRST_PRINTABLE || XML_WHITESPACE.has(code);
    })
    .join("");
}

export function svgNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`a sheet can't hold ${value}`);
  const rounded = Math.round(value * DECIMALS) / DECIMALS;
  return String(rounded === 0 ? 0 : rounded);
}

function scaleNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`a sheet can't scale by ${value}`);
  return String(Number(value.toPrecision(SCALE_DIGITS)));
}

function escaped(content: string): string {
  return xmlCharacters(content)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hex(color: Rgb): string {
  return `#${[color.r, color.g, color.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function paintAttributes(paint: Paint, scale: number): string {
  const attributes = [`fill="${paint.fill === null ? "none" : hex(paint.fill)}"`];
  if (paint.fill !== null && paint.fillOpacity !== 1) {
    attributes.push(`fill-opacity="${svgNumber(paint.fillOpacity)}"`);
  }
  if (paint.stroke === null) {
    attributes.push(`stroke="none"`);
  } else {
    attributes.push(
      `stroke="${hex(paint.stroke)}"`,
      `stroke-width="${svgNumber(paint.strokeMm / scale)}"`,
    );
    if (paint.dashMm.length > 0) {
      attributes.push(
        `stroke-dasharray="${paint.dashMm.map((dash) => svgNumber(dash / scale)).join(" ")}"`,
      );
    }
  }
  return attributes.join(" ");
}

function transformAttribute(transform: Similarity): string {
  const parts: string[] = [];
  if (transform.dx !== 0 || transform.dy !== 0) {
    parts.push(`translate(${svgNumber(transform.dx)} ${svgNumber(transform.dy)})`);
  }
  if (transform.scale !== 1) parts.push(`scale(${scaleNumber(transform.scale)})`);
  return parts.length === 0 ? "" : ` transform="${parts.join(" ")}"`;
}

class SvgPage {
  private clips = 0;
  private readonly out: string[] = [];

  constructor(private readonly typeface: ISheetTypeface) {}

  page(page: SheetPage, title: string): string {
    const width = svgNumber(page.size.widthMm);
    const height = svgNumber(page.size.heightMm);
    this.out.push(
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="${this.typeface.svgFontFamily}">`,
      `<title>${escaped(title)}</title>`,
    );
    this.items(page.items, 1);
    this.out.push(`</svg>`, "");
    return this.out.join("\n");
  }

  private items(items: ReadonlyArray<DrawItem>, scale: number): void {
    let run: PaintedItem[] = [];
    const flush = (): void => {
      const [first] = run;
      if (!first) return;
      this.out.push(`<g ${paintAttributes(first.paint, scale)}>`);
      for (const item of run) this.out.push(this.painted(item));
      this.out.push(`</g>`);
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
          this.out.push(this.text(item, scale));
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

  private group(item: GroupItem, scale: number): void {
    let clip = "";
    if (item.clip) {
      this.clips += 1;
      const id = `clip-${this.clips}`;
      const box = item.clip;
      this.out.push(
        `<clipPath id="${id}"><rect x="${svgNumber(box.x)}" y="${svgNumber(box.y)}" width="${svgNumber(box.width)}" height="${svgNumber(box.height)}"/></clipPath>`,
      );
      clip = ` clip-path="url(#${id})"`;
    }
    this.out.push(`<g class="${escaped(item.role)}"${transformAttribute(item.transform)}${clip}>`);
    this.items(item.items, scale * item.transform.scale);
    this.out.push(`</g>`);
  }

  private painted(item: PaintedItem): string {
    const role = escaped(item.role);
    switch (item.kind) {
      case "rect":
        return `<rect class="${role}" x="${svgNumber(item.box.x)}" y="${svgNumber(item.box.y)}" width="${svgNumber(item.box.width)}" height="${svgNumber(item.box.height)}"/>`;
      case "path": {
        const close = item.closed ? "Z" : "";
        const d = item.rings
          .map(
            (ring) =>
              `M${ring.map(([x, y]) => `${svgNumber(x)} ${svgNumber(y)}`).join("L")}${close}`,
          )
          .join("");
        return `<path class="${role}" d="${d}"/>`;
      }
      case "line":
        return `<line class="${role}" x1="${svgNumber(item.from[0])}" y1="${svgNumber(item.from[1])}" x2="${svgNumber(item.to[0])}" y2="${svgNumber(item.to[1])}"/>`;
      case "circle":
        return `<circle class="${role}" cx="${svgNumber(item.center[0])}" cy="${svgNumber(item.center[1])}" r="${svgNumber(item.radius)}"/>`;
      default: {
        const unhandled: never = item;
        throw new Error(`unhandled painted item ${String(unhandled)}`);
      }
    }
  }

  private text(item: TextItem, scale: number): string {
    const { style } = item;
    const [x, y] = item.at;
    const attributes = [
      `class="${escaped(item.role)}"`,
      `x="${svgNumber(x)}"`,
      `y="${svgNumber(y)}"`,
      `font-size="${svgNumber(style.sizeMm / scale)}"`,
      `fill="${hex(style.color)}"`,
    ];
    if (style.bold) attributes.push(`font-weight="bold"`);
    if (style.anchor !== "start") attributes.push(`text-anchor="${style.anchor}"`);
    if (style.halo) {
      attributes.push(
        `paint-order="stroke"`,
        `stroke="${hex(PAPER)}"`,
        `stroke-width="${svgNumber(HALO_MM / scale)}"`,
        `stroke-linejoin="round"`,
      );
    }
    if (item.turn === "counterclockwise") {
      attributes.push(`transform="rotate(-90 ${svgNumber(x)} ${svgNumber(y)})"`);
    }
    return `<text ${attributes.join(" ")}>${escaped(item.text)}</text>`;
  }
}

const utf8 = new TextEncoder();

@injectable()
export class SvgSheetWriter implements ISvgSheetWriter {
  constructor(@inject(SHEET_TYPEFACE) private readonly typeface: ISheetTypeface) {}

  pageSvg(page: SheetPage, title: string): string {
    return new SvgPage(this.typeface).page(page, title);
  }

  write(document: SheetDocument, baseName: string): SheetFile {
    const pages = document.pages;
    const [only] = pages;
    if (only && pages.length === 1) {
      return {
        fileName: `${baseName}.svg`,
        mimeType: "image/svg+xml",
        bytes: utf8.encode(this.pageSvg(only, document.title)),
        pages: 1,
      };
    }
    const entries = pages.map((page, i) => ({
      name: `${String(i + 1).padStart(PAGE_NUMBER_DIGITS, "0")}-${page.name}.svg`,
      bytes: utf8.encode(this.pageSvg(page, `${document.title} · ${page.name}`)),
    }));
    return {
      fileName: `${baseName}.svg.zip`,
      mimeType: "application/zip",
      bytes: writeStoredZip(entries),
      pages: pages.length,
    };
  }
}
