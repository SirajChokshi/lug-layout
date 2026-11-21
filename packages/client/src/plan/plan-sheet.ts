import type { LduRect, OutlineRing, TableTop } from "@brr/domain";
import { STUD_LDU, lduFromMm, mmFromLdu } from "@brr/math";
import { areaText, cmText, lengthText } from "../edit/size-labels.ts";
import type { PlanRowSegment } from "./plan-service.ts";

export interface SheetPlacement {
  readonly number: number;
  readonly label: string;
  readonly parts: number;
  readonly segment: PlanRowSegment;
  readonly rings: ReadonlyArray<OutlineRing>;
  readonly flagged: boolean;
}

export interface SheetObstacle {
  readonly name: string;
  readonly rect: LduRect;
}

export interface SheetPartsList {
  readonly placements: number;
  readonly parts: number;
  readonly lines: number;
  readonly uncounted: number;
}

export interface SheetVerdict {
  readonly buildable: boolean;
  readonly issues: number;
  readonly unmeasured: number;
  readonly notChecked: ReadonlyArray<string>;
  readonly unchecked: string | null;
}

export interface PlanSheet {
  readonly name: string;
  readonly originX: number;
  readonly originZ: number;
  readonly room: LduRect;
  readonly tables: ReadonlyArray<TableTop>;
  readonly obstacles: ReadonlyArray<SheetObstacle>;
  readonly roadway: ReadonlyArray<LduRect>;
  readonly ramps: ReadonlyArray<ReadonlyArray<OutlineRing>>;
  readonly placements: ReadonlyArray<SheetPlacement>;
  readonly partsList: SheetPartsList | null;
  readonly verdict: SheetVerdict;
  readonly disclaimer: string;
}

const CHECK_BAR_STUDS = 8;

const MM_PER_LDU = mmFromLdu(1);
const MARGIN_MM = 15;
const TITLE_MM = 42;
const DIMENSION_BAND_MM = 18;
const DIMENSION_OFFSET_MM = 7;
const KEY_GAP_MM = 15;
const KEY_WIDTH_MM = 120;
const KEY_PARTS_MM = 30;
const KEY_LABEL_MM = 36;
const CHARACTER_WIDTH_EM = 0.6;
const KEY_HEAD_ROWS = 2;
const KEY_TAIL_ROWS = 7;
const ROW_MM = 6;
const FOOTER_MM = 12;
const TITLE_TEXT_MM = 8;
const TEXT_MM = 4;
const SMALL_TEXT_MM = 3;
const NUMBER_RADIUS_MM = 3.5;
const NUMBER_BASELINE_MM = 1.2;
const TICK_MM = 2;
const DECIMALS = 1000;

const STYLE = [
  "text{fill:#1b1f23}",
  `.title{font-size:${TITLE_TEXT_MM}px}`,
  ".small{font-size:3px}",
  ".bold{font-weight:bold}",
  ".end{text-anchor:end}",
  ".middle{text-anchor:middle}",
  ".halo{paint-order:stroke;stroke:#fff;stroke-width:0.8px;stroke-linejoin:round}",
  ".room{fill:none;stroke:#444;stroke-width:1.25}",
  ".table{fill:#ead9bd;stroke:#8a6d3b;stroke-width:1.25}",
  ".obstacle{fill:url(#hatch);stroke:#666;stroke-width:1}",
  ".roadway{fill:#9aa3a8}",
  ".model{fill:none;stroke:#1b4f72;stroke-width:1.25}",
  ".track{fill:#4a4a4a;fill-opacity:0.85;stroke:#111;stroke-width:0.5}",
  ".ramp{fill:none;stroke:#6b4f1d;stroke-width:1;stroke-dasharray:4 3}",
  ".flagged{stroke:#c62828;stroke-width:2}",
  ".dimension{stroke:#444;stroke-width:0.25;fill:none}",
  ".number{fill:#fff;stroke:#1b4f72;stroke-width:0.4}",
  ".number.flagged{stroke:#c62828;stroke-width:0.6}",
].join("");

function num(value: number): string {
  const rounded = Math.round(value * DECIMALS) / DECIMALS;
  return String(rounded === 0 ? 0 : rounded);
}

function escape(content: string): string {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function isFiniteRect(rect: LduRect): boolean {
  return (
    Number.isFinite(rect.minX) &&
    Number.isFinite(rect.minZ) &&
    Number.isFinite(rect.maxX) &&
    Number.isFinite(rect.maxZ)
  );
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
  return { minX, minZ, maxX, maxZ };
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

function drawable(rings: ReadonlyArray<OutlineRing>): boolean {
  return rings.length > 0 && isFiniteRect(ringsBounds(rings));
}

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

class SheetFrame {
  readonly drawLeft = MARGIN_MM + DIMENSION_BAND_MM;
  readonly drawTop = MARGIN_MM + TITLE_MM + DIMENSION_BAND_MM;

  constructor(
    private readonly sheet: PlanSheet,
    readonly bounds: LduRect,
  ) {}

  x(ldu: number): number {
    return this.drawLeft + mmFromLdu(ldu - this.bounds.minX);
  }

  z(ldu: number): number {
    return this.drawTop + mmFromLdu(ldu - this.bounds.minZ);
  }

  get widthMm(): number {
    return mmFromLdu(this.bounds.maxX - this.bounds.minX);
  }

  get depthMm(): number {
    return mmFromLdu(this.bounds.maxZ - this.bounds.minZ);
  }

  get lduTransform(): string {
    const dx = this.drawLeft - mmFromLdu(this.bounds.minX - this.sheet.originX);
    const dz = this.drawTop - mmFromLdu(this.bounds.minZ - this.sheet.originZ);
    return `translate(${num(dx)} ${num(dz)}) scale(${num(MM_PER_LDU)})`;
  }

  localX(ldu: number): string {
    return num(ldu - this.sheet.originX);
  }

  localZ(ldu: number): string {
    return num(ldu - this.sheet.originZ);
  }

  rect(rect: LduRect, className: string): string {
    if (!isFiniteRect(rect)) return "";
    return `<rect class="${className}" x="${this.localX(rect.minX)}" y="${this.localZ(rect.minZ)}" width="${num(rect.maxX - rect.minX)}" height="${num(rect.maxZ - rect.minZ)}"/>`;
  }

  path(rings: ReadonlyArray<OutlineRing>, className: string): string {
    if (!drawable(rings)) return "";
    const d = rings
      .map((ring) => `M${ring.map(([x, z]) => `${this.localX(x)} ${this.localZ(z)}`).join("L")}Z`)
      .join("");
    return `<path class="${className}" d="${d}"/>`;
  }
}

function text(x: number, y: number, content: string, className = ""): string {
  const classes = className === "" ? "" : ` class="${className}"`;
  return `<text x="${num(x)}" y="${num(y)}"${classes}>${escape(content)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, className: string): string {
  return `<line class="${className}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"/>`;
}

function horizontalDimension(x1: number, x2: number, y: number, label: string): string {
  return [
    line(x1, y, x2, y, "dimension"),
    line(x1, y - TICK_MM, x1, y + TICK_MM, "dimension"),
    line(x2, y - TICK_MM, x2, y + TICK_MM, "dimension"),
    text((x1 + x2) / 2, y - 1, label, "small middle halo"),
  ].join("");
}

function verticalDimension(x: number, z1: number, z2: number, label: string): string {
  const middle = (z1 + z2) / 2;
  return [
    line(x, z1, x, z2, "dimension"),
    line(x - TICK_MM, z1, x + TICK_MM, z1, "dimension"),
    line(x - TICK_MM, z2, x + TICK_MM, z2, "dimension"),
    `<text x="${num(x - 1)}" y="${num(middle)}" class="small middle halo" transform="rotate(-90 ${num(x - 1)} ${num(middle)})">${escape(label)}</text>`,
  ].join("");
}

function sheetBounds(sheet: PlanSheet): LduRect {
  return unionOf([
    sheet.room,
    ...sheet.tables.map((table) => table.surface),
    ...sheet.obstacles.map((obstacle) => obstacle.rect),
    ...sheet.roadway,
    ...sheet.ramps.map(ringsBounds),
    ...sheet.placements.map((placement) => ringsBounds(placement.rings)),
  ]);
}

function geometry(sheet: PlanSheet, frame: SheetFrame): string {
  const parts: string[] = [frame.rect(sheet.room, "room")];
  for (const table of sheet.tables) parts.push(frame.rect(table.surface, "table"));
  for (const obstacle of sheet.obstacles) parts.push(frame.rect(obstacle.rect, "obstacle"));
  for (const run of mergedCells(sheet.roadway)) parts.push(frame.rect(run, "roadway"));
  for (const placement of sheet.placements) {
    const className = placement.flagged ? `${placement.segment} flagged` : placement.segment;
    parts.push(frame.path(placement.rings, className));
  }
  for (const ramp of sheet.ramps) parts.push(frame.path(ramp, "ramp"));
  return `<g transform="${frame.lduTransform}">${parts.join("")}</g>`;
}

function tableNotes(sheet: PlanSheet, frame: SheetFrame): string {
  const parts: string[] = [];
  for (const table of sheet.tables) {
    const { surface, studs } = table;
    const left = frame.x(surface.minX);
    const right = frame.x(surface.maxX);
    const top = frame.z(surface.minZ);
    const bottom = frame.z(surface.maxZ);
    parts.push(
      horizontalDimension(
        left,
        right,
        top - DIMENSION_OFFSET_MM,
        lengthText(surface.maxX - surface.minX),
      ),
      verticalDimension(
        left - DIMENSION_OFFSET_MM,
        top,
        bottom,
        lengthText(surface.maxZ - surface.minZ),
      ),
      text(
        left + 2,
        bottom - 2 - SMALL_TEXT_MM - 1,
        `${table.name} · ${cmText(lduFromMm(table.heightMm))} cm high · ${studs.studsWide} × ${studs.studsDeep} studs on the lattice`,
        "small halo",
      ),
      text(
        left + 2,
        bottom - 2,
        `from the left wall ${lengthText(surface.minX - sheet.room.minX)}, from the back wall ${lengthText(surface.minZ - sheet.room.minZ)}`,
        "small halo",
      ),
    );
  }
  const { room } = sheet;
  parts.push(
    horizontalDimension(
      frame.x(room.minX),
      frame.x(room.maxX),
      frame.z(room.maxZ) + DIMENSION_OFFSET_MM + SMALL_TEXT_MM,
      `room ${lengthText(room.maxX - room.minX)}`,
    ),
    verticalDimension(
      frame.x(room.maxX) + DIMENSION_OFFSET_MM + SMALL_TEXT_MM,
      frame.z(room.minZ),
      frame.z(room.maxZ),
      `room ${lengthText(room.maxZ - room.minZ)}`,
    ),
  );
  for (const obstacle of sheet.obstacles) {
    parts.push(
      text(
        frame.x(obstacle.rect.minX) + 1,
        frame.z(obstacle.rect.minZ) + SMALL_TEXT_MM + 1,
        obstacle.name,
        "small halo",
      ),
    );
  }
  return parts.join("");
}

function numbers(sheet: PlanSheet, frame: SheetFrame): string {
  return sheet.placements
    .filter((placement) => drawable(placement.rings))
    .map((placement) => {
      const bounds = ringsBounds(placement.rings);
      const cx = frame.x((bounds.minX + bounds.maxX) / 2);
      const cz = frame.z((bounds.minZ + bounds.maxZ) / 2);
      const circle = placement.flagged ? "number flagged" : "number";
      return [
        `<circle class="${circle}" cx="${num(cx)}" cy="${num(cz)}" r="${num(NUMBER_RADIUS_MM)}"/>`,
        text(cx, cz + NUMBER_BASELINE_MM, String(placement.number), "small middle bold"),
      ].join("");
    })
    .join("");
}

function totalParts(sheet: PlanSheet): number {
  return sheet.placements.reduce((sum, placement) => sum + placement.parts, 0);
}

const KEY_LEGEND = [
  "Outlines: blue, a placed model's footprint; dark, a track piece's exact outline;",
  "gray, roadway (road surface without studs); red, a placement with a plan issue;",
  "dashed brown, a suggested crossing ramp, not in the parts list.",
];

function placementLine(placement: SheetPlacement): string {
  const notes = [placement.label];
  if (placement.flagged) notes.push("plan issue");
  if (!drawable(placement.rings)) notes.push("not drawn: no finite footprint");
  return notes.join(" · ");
}

function notCheckedLines(sheet: PlanSheet): ReadonlyArray<string> {
  const { notChecked } = sheet.verdict;
  return notChecked.length === 0
    ? []
    : ["Not checked yet:", ...notChecked.map((rule) => `· ${rule}`)];
}

function keyWidth(sheet: PlanSheet): number {
  let longest = 0;
  for (const placement of sheet.placements) {
    longest = Math.max(longest, placementLine(placement).length);
  }
  for (const legend of [...KEY_LEGEND, ...notCheckedLines(sheet)]) {
    longest = Math.max(longest, legend.length);
  }
  return Math.max(KEY_WIDTH_MM, KEY_LABEL_MM + longest * SMALL_TEXT_MM * CHARACTER_WIDTH_EM);
}

function key(sheet: PlanSheet, left: number, top: number): string {
  const parts = left + KEY_PARTS_MM;
  const label = left + KEY_LABEL_MM;
  const rows: string[] = [
    text(left, top, "Key: numbers on the plan", "bold"),
    text(left, top + ROW_MM, "No.", "small bold"),
    text(parts, top + ROW_MM, "Parts", "small bold end"),
    text(label, top + ROW_MM, "Placement", "small bold"),
  ];
  sheet.placements.forEach((placement, i) => {
    const y = top + (KEY_HEAD_ROWS + i) * ROW_MM;
    rows.push(
      text(left, y, String(placement.number), "small bold"),
      text(parts, y, placement.parts.toLocaleString("en-US"), "small end"),
      text(label, y, placementLine(placement), "small"),
    );
  });
  const totalY = top + (KEY_HEAD_ROWS + sheet.placements.length) * ROW_MM;
  rows.push(
    line(left, totalY - ROW_MM + 1.5, left + keyWidth(sheet), totalY - ROW_MM + 1.5, "dimension"),
    text(parts, totalY, totalParts(sheet).toLocaleString("en-US"), "small bold end"),
    text(
      label,
      totalY,
      `Total: ${plural(sheet.placements.length, "placement", "placements")}`,
      "small bold",
    ),
  );
  [...KEY_LEGEND, "", ...notCheckedLines(sheet)].forEach((legend, i) => {
    if (legend !== "") rows.push(text(left, totalY + (2 + i) * ROW_MM, legend, "small"));
  });
  return rows.join("");
}

function keyRows(sheet: PlanSheet): number {
  return (
    KEY_HEAD_ROWS + sheet.placements.length + KEY_TAIL_ROWS + notCheckedLines(sheet).length + 1
  );
}

function verdictText({ verdict }: PlanSheet): string {
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

function partsListText({ partsList }: PlanSheet): string {
  if (partsList === null) return "Parts list: not counted while the plan rules can't be checked";
  const uncounted =
    partsList.uncounted > 0
      ? `, and ${plural(partsList.uncounted, "item", "items")} it can't count`
      : "";
  return `Parts list: ${partsList.parts.toLocaleString("en-US")} parts in ${plural(partsList.lines, "part and colour line", "part and colour lines")}, from ${plural(partsList.placements, "placement", "placements")}${uncounted}`;
}

function title(sheet: PlanSheet): string {
  const { room } = sheet;
  const checkLength = mmFromLdu(CHECK_BAR_STUDS * STUD_LDU);
  const barY = MARGIN_MM + TITLE_MM - 4;
  return [
    text(MARGIN_MM, MARGIN_MM + TITLE_TEXT_MM, sheet.name, "title bold"),
    text(
      MARGIN_MM,
      MARGIN_MM + TITLE_TEXT_MM + 2 * TEXT_MM - 1,
      `Room ${areaText(room.maxX - room.minX, room.maxZ - room.minZ)} · ${plural(sheet.tables.length, "table", "tables")} · drawn at 1:1, print at 100% (actual size)`,
    ),
    text(MARGIN_MM, MARGIN_MM + TITLE_TEXT_MM + 3.5 * TEXT_MM - 1, verdictText(sheet), "bold"),
    text(MARGIN_MM, MARGIN_MM + TITLE_TEXT_MM + 5 * TEXT_MM - 1, partsListText(sheet)),
    `<g class="check-bar">`,
    line(MARGIN_MM, barY, MARGIN_MM + checkLength, barY, "dimension"),
    line(MARGIN_MM, barY - TICK_MM, MARGIN_MM, barY + TICK_MM, "dimension"),
    line(
      MARGIN_MM + checkLength,
      barY - TICK_MM,
      MARGIN_MM + checkLength,
      barY + TICK_MM,
      "dimension",
    ),
    "</g>",
    text(
      MARGIN_MM + checkLength + 4,
      barY + 1,
      `${lengthText(CHECK_BAR_STUDS * STUD_LDU)}: this bar measures ${num(checkLength)} mm when printed at 100%`,
      "small",
    ),
  ].join("");
}

export function planSheetSvg(sheet: PlanSheet): string {
  const frame = new SheetFrame(sheet, sheetBounds(sheet));
  const keyLeft = frame.drawLeft + frame.widthMm + DIMENSION_BAND_MM + KEY_GAP_MM;
  const keyTop = MARGIN_MM + TITLE_MM + TEXT_MM;
  const width = keyLeft + keyWidth(sheet) + MARGIN_MM;
  const body = Math.max(
    frame.drawTop + frame.depthMm + DIMENSION_BAND_MM,
    keyTop + keyRows(sheet) * ROW_MM,
  );
  const height = body + FOOTER_MM + MARGIN_MM;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}mm" height="${num(height)}mm" viewBox="0 0 ${num(width)} ${num(height)}" font-family="Helvetica, Arial, sans-serif" font-size="${TEXT_MM}">`,
    `<title>${escape(sheet.name)}</title>`,
    `<defs><style>${STYLE}</style><pattern id="hatch" width="25" height="25" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="25" stroke="#999" stroke-width="5"/></pattern></defs>`,
    `<rect width="${num(width)}" height="${num(height)}" fill="#fff"/>`,
    title(sheet),
    geometry(sheet, frame),
    tableNotes(sheet, frame),
    numbers(sheet, frame),
    key(sheet, keyLeft, keyTop),
    text(MARGIN_MM, height - MARGIN_MM, sheet.disclaimer, "small"),
    `</svg>`,
    "",
  ].join("\n");
}
