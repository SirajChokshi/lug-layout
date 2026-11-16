import { mmFromLdu, rot90Cos, rot90Sin } from "@brr/math";
import {
  placementId,
  type BuildableCatalog,
  type BuildablePlacement,
  type BuildableReport,
} from "./buildable.ts";
import { placedRect } from "./placed-geometry.ts";
import { regionOriginX, regionOriginZ, type LduRect, type PlanRegion } from "./plan-region.ts";
import type { PlanCheck } from "./plan-rules.ts";

export interface PlanSvgInput {
  readonly region: PlanRegion;
  readonly check: PlanCheck;
  readonly report: BuildableReport;
  readonly placements: ReadonlyArray<BuildablePlacement>;
  readonly catalog: BuildableCatalog;
  readonly colorNames: Readonly<Record<number, string>>;
  readonly disclaimer: string;
}

const PAGE_WIDTH_MM = 420;
const PAGE_HEIGHT_MM = 297;
const MARGIN_MM = 12;
const HEADER_MM = 26;
const FOOTER_MM = 14;
const TEXT_MM = 3.2;
const SMALL_TEXT_MM = 2.6;
const ROW_MM = 3.6;
const SHEET_COLUMNS = 4;
const SCALE_BAR_MM = 500;
const DEGREES_PER_QUARTER = 90;
const STANDARD_SCALES = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];

interface Mm {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function toMm(region: PlanRegion, bounds: LduRect): Mm {
  return {
    x: mmFromLdu(bounds.minX - regionOriginX(region)),
    z: mmFromLdu(bounds.minZ - regionOriginZ(region)),
    width: mmFromLdu(bounds.maxX - bounds.minX),
    depth: mmFromLdu(bounds.maxZ - bounds.minZ),
  };
}

function rect(mm: Mm, attributes: string): string {
  return `<rect x="${num(mm.x)}" y="${num(mm.z)}" width="${num(mm.width)}" height="${num(mm.depth)}" ${attributes}/>`;
}

function text(x: number, y: number, size: number, content: string, attributes = ""): string {
  return `<text x="${num(x)}" y="${num(y)}" font-size="${num(size)}" ${attributes}>${escape(content)}</text>`;
}

function chooseScale(region: PlanRegion): number {
  const width = PAGE_WIDTH_MM - 2 * MARGIN_MM;
  const depth = PAGE_HEIGHT_MM - 2 * MARGIN_MM - HEADER_MM - FOOTER_MM;
  const needed = Math.max(
    region.footprint.roomWidthMm / width,
    region.footprint.roomDepthMm / depth,
  );
  return STANDARD_SCALES.find((scale) => scale >= needed) ?? Math.ceil(needed);
}

function dimension(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label: string,
  size: number,
  stroke: number,
): string {
  const horizontal = y1 === y2;
  const tx = (x1 + x2) / 2;
  const ty = (y1 + y2) / 2;
  const rotate = horizontal ? "" : ` transform="rotate(-90 ${num(tx)} ${num(ty)})"`;
  return [
    `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="#444" stroke-width="${num(stroke)}" marker-start="url(#tick)" marker-end="url(#tick)"/>`,
    `<text x="${num(tx)}" y="${num(ty - size * 0.4)}" font-size="${num(size)}" text-anchor="middle"${rotate}>${escape(label)}</text>`,
  ].join("");
}

function verdictText(report: BuildableReport): string {
  switch (report.verdict) {
    case "buildable":
      return "Buildable as planned";
    case "draft":
      return `Not buildable as planned: ${report.errors} errors, ${report.warnings} warnings`;
    case "empty":
      return "Nothing placed in this plan";
    default: {
      const unhandled: never = report.verdict;
      throw new Error(`unhandled verdict ${String(unhandled)}`);
    }
  }
}

function planPage(input: PlanSvgInput, numbers: ReadonlyMap<string, number>): string {
  const { region, check, report, placements, catalog } = input;
  const scale = chooseScale(region);
  const unit = 1 / scale;
  const s = (pageMm: number): number => pageMm * scale;
  const flagged = new Set(report.issues.flatMap((issue) => issue.placements.map(placementId)));
  const inside = new Set(check.inside.map(placementId));
  const parts: string[] = [];
  parts.push(
    rect(
      { x: 0, z: 0, width: region.footprint.roomWidthMm, depth: region.footprint.roomDepthMm },
      `fill="none" stroke="#222" stroke-width="${num(s(0.5))}"`,
    ),
  );
  for (const obstacle of check.obstacles) {
    parts.push(
      rect(
        toMm(region, obstacle),
        `fill="url(#hatch)" stroke="#666" stroke-width="${num(s(0.25))}"`,
      ),
    );
  }
  check.tables.forEach((table) => {
    const mm = toMm(region, table.surface);
    parts.push(rect(mm, `fill="#ead9bd" stroke="#8a6d3b" stroke-width="${num(s(0.35))}"`));
    parts.push(
      dimension(
        mm.x,
        mm.z - s(5),
        mm.x + mm.width,
        mm.z - s(5),
        `${num(mm.width)} mm`,
        s(SMALL_TEXT_MM),
        s(0.2),
      ),
      dimension(
        mm.x - s(5),
        mm.z,
        mm.x - s(5),
        mm.z + mm.depth,
        `${num(mm.depth)} mm`,
        s(SMALL_TEXT_MM),
        s(0.2),
      ),
      text(
        mm.x + s(1.5),
        mm.z + mm.depth - s(1.5),
        s(SMALL_TEXT_MM),
        `${table.name}: ${num(mm.width)} × ${num(mm.depth)} mm, ${table.heightMm} mm high, at ${num(mm.x)}, ${num(mm.z)} mm`,
        `fill="#5c4520"`,
      ),
    );
  });
  for (const placement of placements) {
    if (!inside.has(placementId(placement.key))) continue;
    const spec = catalog.specs.get(placement.ref);
    const number = numbers.get(placementId(placement.key)) ?? 0;
    const stroke = flagged.has(placementId(placement.key)) ? "#d1242f" : "#1b2a34";
    const footprint = toMm(region, placement.box);
    parts.push(
      rect(
        footprint,
        `fill="none" stroke="${stroke}" stroke-width="${num(s(0.25))}" stroke-dasharray="${num(s(1.2))} ${num(s(0.8))}"`,
      ),
    );
    for (const ground of spec?.ground ?? []) {
      const fill = (spec?.roadways.length ?? 0) > 0 ? "#9aa3a8" : "#9fd39f";
      parts.push(
        rect(
          toMm(region, placedRect(ground, placement.x, placement.z, placement.rot)),
          `fill="${fill}" fill-opacity="0.7" stroke="${stroke}" stroke-width="${num(s(0.3))}"`,
        ),
      );
    }
    const cx = footprint.x + footprint.width / 2;
    const cz = footprint.z + footprint.depth / 2;
    parts.push(
      `<circle cx="${num(cx)}" cy="${num(cz)}" r="${num(s(3))}" fill="#fff" stroke="${stroke}" stroke-width="${num(s(0.3))}"/>`,
      text(cx, cz + s(1.1), s(TEXT_MM), `M${number}`, `text-anchor="middle" font-weight="bold"`),
      `<line x1="${num(cx + rot90Sin(placement.rot) * s(3))}" y1="${num(cz + rot90Cos(placement.rot) * s(3))}" x2="${num(cx + rot90Sin(placement.rot) * s(5))}" y2="${num(cz + rot90Cos(placement.rot) * s(5))}" stroke="${stroke}" stroke-width="${num(s(0.4))}"/>`,
    );
  }
  const drawing = `<g transform="translate(${MARGIN_MM} ${MARGIN_MM + HEADER_MM}) scale(${num(unit)})">${parts.join("")}</g>`;
  const barY = PAGE_HEIGHT_MM - MARGIN_MM - 4;
  const header = [
    text(MARGIN_MM, MARGIN_MM + 6, 6, region.name, `font-weight="bold"`),
    text(
      MARGIN_MM,
      MARGIN_MM + 13,
      TEXT_MM,
      `${verdictText(report)} · ${report.bom.totalParts} parts in ${report.bom.lines.length} lines · module standard: ${report.profile}`,
    ),
    text(
      MARGIN_MM,
      MARGIN_MM + 18,
      SMALL_TEXT_MM,
      `Room ${region.footprint.roomWidthMm} × ${region.footprint.roomDepthMm} mm, drawn at 1:${scale}. Dashed outlines are model footprints, filled areas are baseplates and road plates, red marks placements with issues. The tick on each number points to the placement's +z side.`,
    ),
  ];
  const footer = [
    `<line x1="${MARGIN_MM}" y1="${barY}" x2="${num(MARGIN_MM + SCALE_BAR_MM * unit)}" y2="${barY}" stroke="#222" stroke-width="0.8"/>`,
    text(MARGIN_MM, barY - 1.5, SMALL_TEXT_MM, `${SCALE_BAR_MM} mm`),
    text(
      PAGE_WIDTH_MM - MARGIN_MM,
      barY,
      SMALL_TEXT_MM,
      input.disclaimer,
      `text-anchor="end" fill="#555"`,
    ),
  ];
  return [...header, drawing, ...footer].join("");
}

interface SheetRow {
  readonly part: string;
  readonly color: string;
  readonly bricklink: string;
  readonly quantity: number;
}

function sheetRows(input: PlanSvgInput, placement: BuildablePlacement): SheetRow[] {
  const spec = input.catalog.specs.get(placement.ref);
  return (spec?.bom ?? [])
    .map((line) => ({
      part: line.part.replace("ldraw:", ""),
      color:
        line.ldrawColor === null
          ? "any colour"
          : (input.colorNames[line.ldrawColor] ?? `colour ${line.ldrawColor}`),
      bricklink: input.catalog.crosswalk.parts.get(line.part)?.bricklink ?? "no BrickLink id",
      quantity: line.quantity,
    }))
    .toSorted(
      (a, b) =>
        a.part.localeCompare(b.part, "en", { numeric: true }) || a.color.localeCompare(b.color),
    );
}

function moduleSheets(input: PlanSvgInput, numbers: ReadonlyMap<string, number>): string[] {
  const rowsPerColumn = Math.floor((PAGE_HEIGHT_MM - 2 * MARGIN_MM - HEADER_MM) / ROW_MM);
  const perPage = rowsPerColumn * SHEET_COLUMNS;
  const columnWidth = (PAGE_WIDTH_MM - 2 * MARGIN_MM) / SHEET_COLUMNS;
  const inside = new Set(input.check.inside.map(placementId));
  const pages: string[] = [];
  for (const placement of input.placements) {
    if (!inside.has(placementId(placement.key))) continue;
    const rows = sheetRows(input, placement);
    const total = rows.reduce((sum, row) => sum + row.quantity, 0);
    const sheetCount = Math.max(1, Math.ceil(rows.length / perPage));
    const x = Math.round(mmFromLdu(placement.box.minX - regionOriginX(input.region)));
    const z = Math.round(mmFromLdu(placement.box.minZ - regionOriginZ(input.region)));
    for (let sheet = 0; sheet < sheetCount; sheet++) {
      const body: string[] = [
        text(
          MARGIN_MM,
          MARGIN_MM + 6,
          6,
          `M${numbers.get(placementId(placement.key)) ?? 0} · ${placement.label}`,
          `font-weight="bold"`,
        ),
        text(
          MARGIN_MM,
          MARGIN_MM + 13,
          TEXT_MM,
          `Footprint from ${x}, ${z} mm, turned ${placement.rot * DEGREES_PER_QUARTER}° · ${total} parts in ${rows.length} lines · sheet ${sheet + 1} of ${sheetCount}`,
        ),
      ];
      rows.slice(sheet * perPage, (sheet + 1) * perPage).forEach((row, i) => {
        const column = Math.floor(i / rowsPerColumn);
        const y = MARGIN_MM + HEADER_MM + (i % rowsPerColumn) * ROW_MM;
        body.push(
          text(
            MARGIN_MM + column * columnWidth,
            y,
            SMALL_TEXT_MM,
            `${row.quantity} × ${row.part} ${row.color} (BrickLink ${row.bricklink})`,
          ),
        );
      });
      pages.push(body.join(""));
    }
  }
  return pages;
}

export function planSvg(input: PlanSvgInput): string {
  const numbers = new Map<string, number>();
  const inside = new Set(input.check.inside.map(placementId));
  let next = 1;
  for (const placement of input.placements) {
    const id = placementId(placement.key);
    if (inside.has(id)) numbers.set(id, next++);
  }
  const pages = [planPage(input, numbers), ...moduleSheets(input, numbers)];
  const height = PAGE_HEIGHT_MM * pages.length;
  const framed = pages.map(
    (page, i) =>
      `<g transform="translate(0 ${i * PAGE_HEIGHT_MM})"><rect width="${PAGE_WIDTH_MM}" height="${PAGE_HEIGHT_MM}" fill="#fff" stroke="#bbb" stroke-width="0.3"/>${page}</g>`,
  );
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH_MM}mm" height="${height}mm" viewBox="0 0 ${PAGE_WIDTH_MM} ${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<defs><marker id="tick" viewBox="-1 -5 2 10" markerWidth="2" markerHeight="10" orient="auto"><line x1="0" y1="-5" x2="0" y2="5" stroke="#444" stroke-width="1"/></marker><pattern id="hatch" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="40" stroke="#999" stroke-width="8"/></pattern></defs>`,
    ...framed,
    `</svg>`,
    "",
  ].join("\n");
}
