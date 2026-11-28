import { lduFromMm } from "@brr/math";
import {
  ExactFrame,
  exactArea,
  exactCoveredWithin,
  exactGrown,
  exactNearest,
  exactOverlap,
  exactReach,
  exactUncovered,
} from "./exact-rect.ts";
import {
  mmRectInWorld,
  rectContains,
  rectsOverlap,
  roomRect,
  studsInside,
  type LduRect,
  type MmRect,
  type PlanRegion,
  type StudRect,
} from "./plan-region.ts";
import {
  FACT_OVERLAP_SEGMENT,
  FACT_ROAD_MISMATCHED,
  FACT_STRIDE,
  type PlacementFacts,
} from "./plan-facts.ts";
import { ReachScratch, reachContext, reachFails, type ReachContext } from "./plan-reach.ts";
import { HELD, type PlanRows } from "./plan-rows.ts";
import { RECT_FLOATS, type PlanShape } from "./plan-shape.ts";
import {
  ALONG_X,
  EDGE_AXIS,
  EDGE_FROM,
  EDGE_LINE,
  EDGE_TO,
  SEAM_FLOATS,
  SEAM_PAIR,
  freeTableEdges,
  tableSeams,
  type TableSeams,
} from "./plan-table-edges.ts";
import { PIECES_PER_CUT, RECT_STRIDE, growTo, subtractCut } from "./rect-cut.ts";
import type { TrackOutline } from "./track-outline.ts";

export type PlanRuleId =
  | "footprint"
  | "fit"
  | "crossesRegion"
  | "unsupported"
  | "clearance"
  | "seam"
  | "reach"
  | "overlap"
  | "roadJoin"
  | "bomMapping"
  | "unchecked"
  | "trackOpenEnd"
  | "trackJoin"
  | "trackUnverified"
  | "trackUnidentified"
  | "trackReversing"
  | "trackOffTable"
  | "trackSeam";
export type IssueSeverity = "error" | "warning";

export interface PlacementKey {
  readonly chunkKey: number;
  readonly slot: number;
}

export interface PlateClearance {
  readonly train: string;
  readonly needPlates: number;
  readonly hasPlates: number;
}

export interface PlanPlacement {
  readonly key: PlacementKey;
  readonly ref: string;
  readonly label: string;
  readonly box: LduRect;
  readonly unsupported?: boolean;
  readonly carriedTrackUnsupported?: boolean;
  readonly lowClearance?: PlateClearance;
  readonly shape?: PlanShape | null;
  readonly outline?: TrackOutline | null;
  readonly carried?: CarriedTrack | null;
  readonly anchor?: { readonly x: number; readonly z: number };
  readonly facts?: PlacementFacts;
}

export interface CarriedTrack {
  readonly outlines: ReadonlyArray<TrackOutline>;
  readonly bodyBox: Float64Array | null;
}

export interface PlanIssue {
  readonly rule: PlanRuleId;
  readonly severity: IssueSeverity;
  readonly placements: ReadonlyArray<PlacementKey>;
  readonly message: string;
  readonly overhangMm: number;
  readonly nearestTableMm: number;
  readonly entirelyOffTables: boolean;
  readonly offTableMm2: number;
}

export interface TableTop {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly heightMm: number;
  readonly typeId?: number;
  readonly surface: LduRect;
  readonly studs: StudRect;
}

export interface PlanCheck {
  readonly regionId: string;
  readonly room: LduRect;
  readonly tables: ReadonlyArray<TableTop>;
  readonly obstacles: ReadonlyArray<LduRect>;
  readonly inside: ReadonlyArray<PlacementKey>;
  readonly issues: ReadonlyArray<PlanIssue>;
}

interface OffTable {
  readonly overhangMm: number;
  readonly nearestTableMm: number;
  readonly entirelyOffTables: boolean;
  readonly offTableMm2: number;
}

interface ShownOffTable {
  readonly overhangTenthsUp: number;
  readonly offTableMm2Up: number;
  readonly nearestTenths: number;
}

const ON_TABLE: OffTable = {
  overhangMm: 0,
  nearestTableMm: 0,
  entirelyOffTables: false,
  offTableMm2: 0,
};

function issue(
  rule: PlanRuleId,
  placements: ReadonlyArray<PlacementKey>,
  message: string,
  offTable: OffTable = ON_TABLE,
): PlanIssue {
  return { rule, severity: "error", placements, message, ...offTable };
}

function isWholeMm(value: number): boolean {
  return Number.isInteger(value);
}

function reachLimitValid(region: PlanRegion): boolean {
  return isWholeMm(region.maxReachMm) && region.maxReachMm >= 0;
}

function rectProblem(rect: MmRect): string | null {
  if (![rect.x, rect.z, rect.width, rect.depth].every(isWholeMm)) {
    return "is not in whole millimetres";
  }
  if (rect.width <= 0 || rect.depth <= 0) return "has no area";
  return null;
}

function footprintIssues(region: PlanRegion, room: LduRect): PlanIssue[] {
  const { footprint } = region;
  const issues: PlanIssue[] = [];
  if (
    !isWholeMm(footprint.roomWidthMm) ||
    !isWholeMm(footprint.roomDepthMm) ||
    footprint.roomWidthMm <= 0 ||
    footprint.roomDepthMm <= 0
  ) {
    issues.push(issue("footprint", [], "The room needs a positive width and depth in whole mm."));
  }
  if (!isWholeMm(region.maxOverhangMm) || region.maxOverhangMm < 0) {
    issues.push(issue("footprint", [], "The overhang limit must be zero or more whole mm."));
  }
  if (!reachLimitValid(region)) {
    issues.push(issue("footprint", [], "The reach limit must be zero or more whole mm."));
  }
  const datum = footprint.tables[0];
  footprint.tables.forEach((table, i) => {
    const problem = rectProblem(table.rect);
    if (problem) issues.push(issue("footprint", [], `Table "${table.name}" ${problem}.`));
    if (!isWholeMm(table.heightMm) || table.heightMm <= 0) {
      issues.push(issue("footprint", [], `Table "${table.name}" needs a height in whole mm.`));
    }
    const surface = mmRectInWorld(region, table.rect);
    if (!rectContains(room, surface)) {
      issues.push(issue("footprint", [], `Table "${table.name}" is not inside the room.`));
    }
    if (datum && table.heightMm !== datum.heightMm) {
      issues.push(
        issue(
          "footprint",
          [],
          `Table "${table.name}" is ${table.heightMm} mm high, but "${datum.name}" sets the layout at ${datum.heightMm} mm; layouts are flat.`,
        ),
      );
    }
    footprint.tables.slice(i + 1).forEach((other) => {
      if (rectsOverlap(surface, mmRectInWorld(region, other.rect))) {
        issues.push(issue("footprint", [], `Tables "${table.name}" and "${other.name}" overlap.`));
      }
    });
    footprint.obstacles.forEach((obstacle) => {
      if (rectsOverlap(surface, mmRectInWorld(region, obstacle.rect))) {
        issues.push(
          issue("footprint", [], `Table "${table.name}" overlaps obstacle "${obstacle.name}".`),
        );
      }
    });
  });
  footprint.obstacles.forEach((obstacle) => {
    const problem = rectProblem(obstacle.rect);
    if (problem) issues.push(issue("footprint", [], `Obstacle "${obstacle.name}" ${problem}.`));
  });
  return issues;
}

function frameFor(box: LduRect, tables: ReadonlyArray<LduRect>, extra: number): ExactFrame {
  const values = [box, ...tables].flatMap((r) => [r.minX, r.minZ, r.maxX, r.maxZ]);
  return new ExactFrame([...values, extra]);
}

function isFiniteRect(rect: LduRect): boolean {
  return [rect.minX, rect.minZ, rect.maxX, rect.maxZ].every(Number.isFinite);
}

function nearestTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function offTableMessage(
  label: string,
  shown: ShownOffTable,
  entirelyOff: boolean,
  limitMm: number,
): string {
  const reach = `${label} overhangs the tables: it reaches ${shown.overhangTenthsUp} mm past the nearest table edge along x or z (limit ${limitMm} mm), with ${shown.offTableMm2Up} mm² of its footprint box off the table tops.`;
  if (!entirelyOff) return reach;
  return shown.nearestTenths === 0
    ? `${reach} It is entirely off the tables, touching the edge of the nearest one.`
    : `${reach} It is entirely off the tables, ${shown.nearestTenths} mm from the nearest one along x or z (the larger of the two axis gaps).`;
}

function offTableIssue(
  placement: PlanPlacement,
  surfaces: ReadonlyArray<LduRect>,
  limitMm: number,
): PlanIssue | null {
  const limitLdu = lduFromMm(limitMm);
  const frame = frameFor(placement.box, surfaces, limitLdu);
  const box = frame.rect(placement.box);
  const tables = surfaces.map((t) => frame.rect(t));
  if (exactCoveredWithin(box, tables, frame.of(limitLdu))) return null;
  const reach = exactReach(box, tables);
  const nearest = exactNearest(box, tables);
  const offArea = exactArea(exactUncovered(box, tables));
  const entirelyOffTables = !tables.some((t) => exactOverlap(t, box));
  const offTable: OffTable = {
    overhangMm: (frame.toLdu(reach) * 2) / 5,
    nearestTableMm: (frame.toLdu(nearest) * 2) / 5,
    entirelyOffTables,
    offTableMm2: frame.toMm2(offArea),
  };
  const shown: ShownOffTable = {
    overhangTenthsUp: frame.ceilTenthsOfMm(reach),
    offTableMm2Up: frame.ceilMm2(offArea),
    nearestTenths: nearestTenth(offTable.nearestTableMm),
  };
  return issue(
    "fit",
    [placement.key],
    offTableMessage(placement.label, shown, entirelyOffTables, limitMm),
    offTable,
  );
}

function fitsExactly(box: LduRect, surfaces: ReadonlyArray<LduRect>, reachLdu: number): boolean {
  const frame = frameFor(box, surfaces, reachLdu);
  return exactCoveredWithin(
    frame.rect(box),
    surfaces.map((t) => frame.rect(t)),
    frame.of(reachLdu),
  );
}

export function placementInRegion(region: PlanRegion, box: LduRect): boolean {
  return rectsOverlap(roomRect(region), box);
}

function tableTops(region: PlanRegion): TableTop[] {
  return region.footprint.tables.map((table) => ({
    id: table.id,
    number: table.number,
    name: table.name,
    heightMm: table.heightMm,
    ...(table.typeId === undefined ? {} : { typeId: table.typeId }),
    surface: mmRectInWorld(region, table.rect),
    studs: studsInside(region, table.rect),
  }));
}

export const UNDECIDED = -1;
export const BOX_STRIDE = 6;
export const BOX_MIN_X = 0;
export const BOX_MIN_Y = 1;
export const BOX_MIN_Z = 2;
export const BOX_MAX_X = 3;
export const BOX_MAX_Y = 4;
export const BOX_MAX_Z = 5;

const CERTIFIED_MAGNITUDE = 2 ** 1021;
const INITIAL_PIECE_FLOATS = 64;

export interface CoverageContext {
  readonly surfaceEdges: Float64Array;
  readonly surfaces: ReadonlyArray<LduRect>;
  readonly surfacesFinite: boolean;
  readonly reachLdu: number;
}

export interface PlanRegionContext {
  readonly region: PlanRegion;
  readonly room: LduRect;
  readonly tables: ReadonlyArray<TableTop>;
  readonly obstacles: ReadonlyArray<LduRect>;
  readonly obstacleEdges: Float64Array;
  readonly footprintIssues: ReadonlyArray<PlanIssue>;
  readonly coverage: CoverageContext;
  readonly seams: TableSeams;
  readonly reach: ReachContext | null;
}

export class CoverageScratch {
  grown = new Float64Array(INITIAL_PIECE_FLOATS);
  pieces = new Float64Array(INITIAL_PIECE_FLOATS);
  spare = new Float64Array(INITIAL_PIECE_FLOATS);
  occupancy = new Float64Array(INITIAL_PIECE_FLOATS);
  footing = new Float64Array(INITIAL_PIECE_FLOATS);
  readonly reach = new ReachScratch();
}

function rectEdges(rects: ReadonlyArray<LduRect>): Float64Array {
  return Float64Array.from(rects.flatMap((r) => [r.minX, r.minZ, r.maxX, r.maxZ]));
}

export function coverageContext(
  surfaces: ReadonlyArray<LduRect>,
  reachLdu: number,
): CoverageContext {
  return {
    surfaceEdges: rectEdges(surfaces),
    surfaces,
    surfacesFinite: surfaces.every(isFiniteRect),
    reachLdu,
  };
}

const NO_SEAMS: TableSeams = { edges: new Float64Array(0), pairs: [] };

export function regionContext(region: PlanRegion): PlanRegionContext {
  const room = roomRect(region);
  const tables = tableTops(region);
  const obstacles = region.footprint.obstacles.map((o) => mmRectInWorld(region, o.rect));
  const surfaces = tables.map((table) => table.surface);
  const coverage = coverageContext(surfaces, lduFromMm(region.maxOverhangMm));
  const measurable = coverage.surfacesFinite && surfaces.length > 0;
  return {
    region,
    room,
    tables,
    obstacles,
    obstacleEdges: rectEdges(obstacles),
    footprintIssues: footprintIssues(region, room),
    coverage,
    seams: coverage.surfacesFinite ? tableSeams(tables) : NO_SEAMS,
    reach:
      measurable && reachLimitValid(region)
        ? reachContext(freeTableEdges(surfaces, obstacles), lduFromMm(region.maxReachMm))
        : null,
  };
}

const INWARD = -1;
const OUTWARD = 1;

function certifiedEdge(
  edges: Float64Array,
  grown: Float64Array,
  at: number,
  coverage: CoverageContext,
  direction: number,
): boolean {
  const t = edges[at] ?? Number.NaN;
  const q = direction * coverage.reachLdu;
  const s = t + q;
  if (!(Math.abs(t) <= CERTIFIED_MAGNITUDE) || !(Math.abs(q) <= CERTIFIED_MAGNITUDE)) return false;
  if (!Number.isFinite(s)) return false;
  const bb = s - t;
  if (t - (s - bb) + (q - bb) !== 0) return false;
  grown[at] = s;
  return true;
}

function certifyGrownEdges(coverage: CoverageContext, scratch: CoverageScratch): boolean {
  const edges = coverage.surfaceEdges;
  scratch.grown = growTo(scratch.grown, edges.length);
  const grown = scratch.grown;
  for (let i = 0; i < edges.length; i += RECT_STRIDE) {
    if (
      !certifiedEdge(edges, grown, i, coverage, INWARD) ||
      !certifiedEdge(edges, grown, i + 1, coverage, INWARD) ||
      !certifiedEdge(edges, grown, i + 2, coverage, OUTWARD) ||
      !certifiedEdge(edges, grown, i + 3, coverage, OUTWARD)
    ) {
      return false;
    }
  }
  return true;
}

export function uncoveredPieces(
  coverage: CoverageContext,
  box: Float64Array,
  offset: number,
  scratch: CoverageScratch,
): number {
  if (!certifyGrownEdges(coverage, scratch)) return UNDECIDED;
  const grown = scratch.grown;
  const cuts = coverage.surfaceEdges.length;
  let current = growTo(scratch.pieces, RECT_STRIDE);
  let next = scratch.spare;
  current[0] = box[offset + BOX_MIN_X] ?? Number.NaN;
  current[1] = box[offset + BOX_MIN_Z] ?? Number.NaN;
  current[2] = box[offset + BOX_MAX_X] ?? Number.NaN;
  current[3] = box[offset + BOX_MAX_Z] ?? Number.NaN;
  let count = 1;
  for (let i = 0; i < cuts && count > 0; i += RECT_STRIDE) {
    next = growTo(next, count * PIECES_PER_CUT * RECT_STRIDE);
    count = subtractCut(current, count, next, grown, i);
    const swap = current;
    current = next;
    next = swap;
  }
  scratch.pieces = current;
  scratch.spare = next;
  return count;
}

export function placementInside(
  ctx: PlanRegionContext,
  box: Float64Array,
  offset: number,
): boolean {
  const room = ctx.room;
  const minX = box[offset + BOX_MIN_X] ?? Number.NaN;
  const minZ = box[offset + BOX_MIN_Z] ?? Number.NaN;
  const maxX = box[offset + BOX_MAX_X] ?? Number.NaN;
  const maxZ = box[offset + BOX_MAX_Z] ?? Number.NaN;
  return room.minX < maxX && minX < room.maxX && room.minZ < maxZ && minZ < room.maxZ;
}

const FIT_MEASURED = 0;
const FIT_NO_TABLES = 1;
const FIT_NOT_FINITE = 2;
const NO_ANCHOR = { x: 0, z: 0 } as const;
const BOM_CATALOGS = ["Rebrickable", "BrickLink"] as const;

function fitArm(coverage: CoverageContext, box: Float64Array, offset: number): number {
  if (coverage.surfaces.length === 0) return FIT_NO_TABLES;
  const finite =
    Number.isFinite(box[offset + BOX_MIN_X] ?? Number.NaN) &&
    Number.isFinite(box[offset + BOX_MIN_Z] ?? Number.NaN) &&
    Number.isFinite(box[offset + BOX_MAX_X] ?? Number.NaN) &&
    Number.isFinite(box[offset + BOX_MAX_Z] ?? Number.NaN) &&
    coverage.surfacesFinite;
  return finite ? FIT_MEASURED : FIT_NOT_FINITE;
}

function measuredFitIssueCount(
  coverage: CoverageContext,
  box: Float64Array,
  offset: number,
  scratch: CoverageScratch,
): number {
  const pieces = uncoveredPieces(coverage, box, offset, scratch);
  if (pieces !== UNDECIDED) return pieces === 0 ? 0 : 1;
  const minX = box[offset + BOX_MIN_X] ?? Number.NaN;
  const minZ = box[offset + BOX_MIN_Z] ?? Number.NaN;
  const maxX = box[offset + BOX_MAX_X] ?? Number.NaN;
  const maxZ = box[offset + BOX_MAX_Z] ?? Number.NaN;
  return fitsExactly({ minX, minZ, maxX, maxZ }, coverage.surfaces, coverage.reachLdu) ? 0 : 1;
}

function placedRects(
  rects: Float64Array,
  anchorsX: Float64Array,
  anchorsZ: Float64Array,
  at: number,
  into: Float64Array<ArrayBuffer>,
): Float64Array<ArrayBuffer> {
  const out = growTo(into, rects.length);
  for (let i = 0; i < rects.length; i += RECT_FLOATS) {
    out[i] = (rects[i] ?? Number.NaN) + (anchorsX[at] ?? Number.NaN);
    out[i + 1] = (rects[i + 1] ?? Number.NaN) + (anchorsZ[at] ?? Number.NaN);
    out[i + 2] = (rects[i + 2] ?? Number.NaN) + (anchorsX[at] ?? Number.NaN);
    out[i + 3] = (rects[i + 3] ?? Number.NaN) + (anchorsZ[at] ?? Number.NaN);
  }
  return out;
}

function boxRect(
  box: Float64Array,
  offset: number,
  into: Float64Array<ArrayBuffer>,
): Float64Array<ArrayBuffer> {
  const out = growTo(into, RECT_FLOATS);
  out[0] = box[offset + BOX_MIN_X] ?? Number.NaN;
  out[1] = box[offset + BOX_MIN_Z] ?? Number.NaN;
  out[2] = box[offset + BOX_MAX_X] ?? Number.NaN;
  out[3] = box[offset + BOX_MAX_Z] ?? Number.NaN;
  return out;
}

function crossesSeam(
  seams: Float64Array,
  seam: number,
  rects: Float64Array,
  count: number,
): boolean {
  const alongX = seams[seam + EDGE_AXIS] === ALONG_X;
  const line = seams[seam + EDGE_LINE] ?? Number.NaN;
  const from = seams[seam + EDGE_FROM] ?? Number.NaN;
  const to = seams[seam + EDGE_TO] ?? Number.NaN;
  let below = false;
  let above = false;
  for (let r = 0; r < count; r++) {
    const at = r * RECT_FLOATS;
    const alongMin = (alongX ? rects[at] : rects[at + 1]) ?? Number.NaN;
    const alongMax = (alongX ? rects[at + 2] : rects[at + 3]) ?? Number.NaN;
    const acrossMin = (alongX ? rects[at + 1] : rects[at]) ?? Number.NaN;
    const acrossMax = (alongX ? rects[at + 3] : rects[at + 2]) ?? Number.NaN;
    if (!(alongMin < alongMax && acrossMin < acrossMax)) continue;
    if (!(Math.max(alongMin, from) < Math.min(alongMax, to))) continue;
    if (acrossMin < line) below = true;
    if (acrossMax > line) above = true;
  }
  return below && above;
}

const outlineBox = new Float64Array(BOX_STRIDE);
const seamSides = new Float64Array(2 * RECT_STRIDE);

function outlineOffTableExactly(coverage: CoverageContext, outline: TrackOutline): boolean {
  const box = { minX: outline.minX, minZ: outline.minZ, maxX: outline.maxX, maxZ: outline.maxZ };
  const frame = frameFor(box, coverage.surfaces, coverage.reachLdu);
  const grow = frame.of(coverage.reachLdu);
  const pieces = exactUncovered(
    frame.rect(box),
    coverage.surfaces.map((table) => exactGrown(frame.rect(table), grow)),
  );
  return pieces.some((piece) => outline.meetsExactRect(piece, frame.shift));
}

function outlineOffTable(
  coverage: CoverageContext,
  outline: TrackOutline,
  scratch: CoverageScratch,
): boolean {
  outlineBox[BOX_MIN_X] = outline.minX;
  outlineBox[BOX_MIN_Z] = outline.minZ;
  outlineBox[BOX_MAX_X] = outline.maxX;
  outlineBox[BOX_MAX_Z] = outline.maxZ;
  const pieces = uncoveredPieces(coverage, outlineBox, 0, scratch);
  if (pieces === UNDECIDED) return outlineOffTableExactly(coverage, outline);
  const rects = scratch.pieces;
  for (let p = 0; p < pieces; p++) {
    const at = p * RECT_STRIDE;
    if (outline.meetsOpenRect(rects, at)) return true;
  }
  return false;
}

function anyOutlineOffTable(
  coverage: CoverageContext,
  outlines: ReadonlyArray<TrackOutline>,
  scratch: CoverageScratch,
): boolean {
  for (let k = 0; k < outlines.length; k++) {
    const outline = outlines[k];
    if (outline !== undefined && outlineOffTable(coverage, outline, scratch)) return true;
  }
  return false;
}

function outlineCrossesSeam(seams: Float64Array, seam: number, outline: TrackOutline): boolean {
  const alongX = seams[seam + EDGE_AXIS] === ALONG_X;
  const line = seams[seam + EDGE_LINE] ?? Number.NaN;
  const from = Math.max(
    seams[seam + EDGE_FROM] ?? Number.NaN,
    alongX ? outline.minX : outline.minZ,
  );
  const to = Math.min(seams[seam + EDGE_TO] ?? Number.NaN, alongX ? outline.maxX : outline.maxZ);
  const acrossMin = alongX ? outline.minZ : outline.minX;
  const acrossMax = alongX ? outline.maxZ : outline.maxX;
  if (!(from < to && acrossMin < line && line < acrossMax)) return false;
  if (outline.jointOnSeam(seams, seam)) return false;
  const near = alongX ? 1 : 0;
  const far = 1 - near;
  seamSides[far] = from;
  seamSides[near] = acrossMin;
  seamSides[far + 2] = to;
  seamSides[near + 2] = line;
  seamSides[RECT_STRIDE + far] = from;
  seamSides[RECT_STRIDE + near] = line;
  seamSides[RECT_STRIDE + far + 2] = to;
  seamSides[RECT_STRIDE + near + 2] = acrossMax;
  return outline.meetsOpenRect(seamSides, 0) && outline.meetsOpenRect(seamSides, RECT_STRIDE);
}

function outlineCrossesAnySeam(seams: TableSeams, outline: TrackOutline): boolean {
  const edges = seams.edges;
  for (let seam = 0; seam < edges.length; seam += SEAM_FLOATS) {
    if (outlineCrossesSeam(edges, seam, outline)) return true;
  }
  return false;
}

function anyOutlineCrossesAnySeam(
  seams: TableSeams,
  outlines: ReadonlyArray<TrackOutline>,
): boolean {
  for (let k = 0; k < outlines.length; k++) {
    const outline = outlines[k];
    if (outline !== undefined && outlineCrossesAnySeam(seams, outline)) return true;
  }
  return false;
}

function crossesAnySeam(seams: TableSeams, rects: Float64Array, count: number): boolean {
  const edges = seams.edges;
  for (let seam = 0; seam < edges.length; seam += SEAM_FLOATS) {
    if (crossesSeam(edges, seam, rects, count)) return true;
  }
  return false;
}

function rowReachFails(
  ctx: PlanRegionContext,
  reach: ReachContext,
  rects: Float64Array,
  count: number,
  scratch: CoverageScratch,
): boolean {
  const { coverage } = ctx;
  return reachFails(reach, coverage.surfaceEdges, coverage.surfaces, rects, count, scratch.reach);
}

export function placementIssueCount(
  ctx: PlanRegionContext,
  rows: PlanRows,
  row: number,
  scratch: CoverageScratch,
): number {
  const box = rows.box;
  const offset = row * BOX_STRIDE;
  if (!placementInside(ctx, box, offset)) return 0;
  const room = ctx.room;
  const minX = box[offset + BOX_MIN_X] ?? Number.NaN;
  const minZ = box[offset + BOX_MIN_Z] ?? Number.NaN;
  const maxX = box[offset + BOX_MAX_X] ?? Number.NaN;
  const maxZ = box[offset + BOX_MAX_Z] ?? Number.NaN;
  let count = rows.unsupported[row] === HELD ? 0 : 1;
  if ((rows.clearanceNeed[row] ?? 0) > 0) count++;
  if (!(minX >= room.minX && maxX <= room.maxX && minZ >= room.minZ && maxZ <= room.maxZ)) count++;
  const obstacles = ctx.obstacleEdges;
  for (let i = 0; i < obstacles.length; i += RECT_STRIDE) {
    const oMinX = obstacles[i] ?? Number.NaN;
    const oMinZ = obstacles[i + 1] ?? Number.NaN;
    const oMaxX = obstacles[i + 2] ?? Number.NaN;
    const oMaxZ = obstacles[i + 3] ?? Number.NaN;
    if (oMinX < maxX && minX < oMaxX && oMinZ < maxZ && minZ < oMaxZ) count++;
  }
  const arm = fitArm(ctx.coverage, box, offset);
  const outline = rows.outline[row] ?? null;
  const carried = rows.carried[row] ?? null;
  if (arm !== FIT_MEASURED) count++;
  else if (outline !== null) {
    if (outlineOffTable(ctx.coverage, outline, scratch)) count++;
  } else if (carried === null) {
    count += measuredFitIssueCount(ctx.coverage, box, offset, scratch);
  } else {
    if (carried.bodyBox !== null) {
      count += measuredFitIssueCount(ctx.coverage, carried.bodyBox, 0, scratch);
    }
    if (anyOutlineOffTable(ctx.coverage, carried.outlines, scratch)) count++;
  }
  const shape = rows.shapeOf(row);
  const seamed = ctx.seams.edges.length > 0;
  if (outline !== null) {
    if (seamed && outlineCrossesAnySeam(ctx.seams, outline)) count++;
  } else {
    if (shape !== null && seamed) {
      scratch.footing = placedRects(shape.footing, rows.labelA, rows.labelB, row, scratch.footing);
      if (crossesAnySeam(ctx.seams, scratch.footing, shape.footing.length / RECT_FLOATS)) count++;
    }
    if (carried !== null && seamed && anyOutlineCrossesAnySeam(ctx.seams, carried.outlines)) {
      count++;
    }
  }
  const reach = ctx.reach;
  if (arm === FIT_MEASURED && reach !== null) {
    scratch.occupancy =
      shape === null
        ? boxRect(box, offset, scratch.occupancy)
        : placedRects(shape.occupancy, rows.labelA, rows.labelB, row, scratch.occupancy);
    const rects = shape === null ? 1 : shape.occupancy.length / RECT_FLOATS;
    if (rowReachFails(ctx, reach, scratch.occupancy, rects, scratch)) count++;
  }
  const facts = rows.facts;
  const at = row * FACT_STRIDE;
  if ((facts[at + FACT_OVERLAP_SEGMENT] ?? -1) >= 0) count++;
  if ((facts[at + FACT_ROAD_MISMATCHED] ?? 0) > 0) count++;
  return count;
}

const listScratch = new CoverageScratch();

function cellsText(count: number): string {
  return `${count} edge ${count === 1 ? "cell" : "cells"}`;
}

function seamPairs(ctx: PlanRegionContext, rects: Float64Array, count: number): string[] {
  const pairs: string[] = [];
  const edges = ctx.seams.edges;
  for (let seam = 0; seam < edges.length; seam += SEAM_FLOATS) {
    if (!crossesSeam(edges, seam, rects, count)) continue;
    const pair = ctx.seams.pairs[edges[seam + SEAM_PAIR] ?? -1];
    if (pair !== undefined && !pairs.includes(pair)) pairs.push(pair);
  }
  return pairs;
}

function outlineSeamPairs(ctx: PlanRegionContext, outlines: ReadonlyArray<TrackOutline>): string[] {
  const pairs: string[] = [];
  const edges = ctx.seams.edges;
  for (let seam = 0; seam < edges.length; seam += SEAM_FLOATS) {
    if (!outlines.some((outline) => outlineCrossesSeam(edges, seam, outline))) continue;
    const pair = ctx.seams.pairs[edges[seam + SEAM_PAIR] ?? -1];
    if (pair !== undefined && !pairs.includes(pair)) pairs.push(pair);
  }
  return pairs;
}

function outlineSeamIssue(
  ctx: PlanRegionContext,
  key: PlacementKey,
  subject: string,
  outlines: ReadonlyArray<TrackOutline>,
): PlanIssue | null {
  const pairs = ctx.seams.edges.length > 0 ? outlineSeamPairs(ctx, outlines) : [];
  if (pairs.length === 0) return null;
  return issue(
    "trackSeam",
    [key],
    `${subject} stands across the seam between tables ${pairs.join("; ")}; a seam must fall between placements.`,
  );
}

function outlineOffTableIssue(
  ctx: PlanRegionContext,
  key: PlacementKey,
  subject: string,
  outlines: ReadonlyArray<TrackOutline>,
): PlanIssue | null {
  const { coverage, region } = ctx;
  if (!anyOutlineOffTable(coverage, outlines, listScratch)) return null;
  const entirelyOffTables = !coverage.surfaces.some((table) =>
    outlines.some((outline) =>
      outline.meetsOpenRect(Float64Array.of(table.minX, table.minZ, table.maxX, table.maxZ), 0),
    ),
  );
  const limit = `${region.maxOverhangMm} mm`;
  const reach = `${subject} overhangs the tables: part of its outline is more than ${limit} past the edge of every table.`;
  return issue(
    "trackOffTable",
    [key],
    entirelyOffTables ? `${reach} It is entirely off the tables.` : reach,
    { ...ON_TABLE, entirelyOffTables },
  );
}

function carriedTrackSubject(label: string): string {
  return `Track carried by ${label}`;
}

function bodyRect(bodyBox: Float64Array): LduRect {
  return {
    minX: bodyBox[BOX_MIN_X] ?? Number.NaN,
    minZ: bodyBox[BOX_MIN_Z] ?? Number.NaN,
    maxX: bodyBox[BOX_MAX_X] ?? Number.NaN,
    maxZ: bodyBox[BOX_MAX_Z] ?? Number.NaN,
  };
}

function placedShapeRects(
  rects: Float64Array,
  anchor: { readonly x: number; readonly z: number },
  into: Float64Array<ArrayBuffer>,
): Float64Array<ArrayBuffer> {
  return placedRects(rects, Float64Array.of(anchor.x), Float64Array.of(anchor.z), 0, into);
}

export function placementIssues(
  ctx: PlanRegionContext,
  placement: PlanPlacement,
  out: PlanIssue[],
): void {
  const { region, room, obstacles, coverage } = ctx;
  if (!rectsOverlap(room, placement.box)) return;
  const { key, label } = placement;
  const outline = placement.outline ?? null;
  const carried = placement.carried ?? null;
  if (placement.unsupported) {
    out.push(
      issue(
        "unsupported",
        [key],
        `${label} isn't held: none of its anti-studs sits on a stud, and it doesn't stand on the bare table.`,
      ),
    );
  } else if (placement.carriedTrackUnsupported) {
    out.push(
      issue(
        "unsupported",
        [key],
        `${label} carries track that isn't held: none of that track's anti-studs sits on a stud, and it doesn't stand on the bare table.`,
      ),
    );
  }
  if (placement.lowClearance) {
    const { train, needPlates, hasPlates } = placement.lowClearance;
    out.push(
      issue(
        "clearance",
        [key],
        `${label} is too low for the tallest train: ${train} needs ${needPlates} plates, this bridge has ${hasPlates}.`,
      ),
    );
  }
  if (!rectContains(room, placement.box)) {
    out.push(issue("crossesRegion", [key], `${label} crosses the edge of plan "${region.name}".`));
  }
  region.footprint.obstacles.forEach((obstacle, i) => {
    const rect = obstacles[i];
    if (rect && rectsOverlap(rect, placement.box)) {
      out.push(issue("fit", [key], `${label} stands over obstacle "${obstacle.name}".`));
    }
  });
  let measured = false;
  if (coverage.surfaces.length === 0) {
    out.push(issue("fit", [key], `${label} is in a plan with no tables.`));
  } else if (!isFiniteRect(placement.box) || !coverage.surfacesFinite) {
    out.push(issue("fit", [key], `${label} has no finite footprint to measure.`));
  } else {
    measured = true;
    const offTables =
      outline !== null
        ? [outlineOffTableIssue(ctx, key, label, [outline])]
        : carried === null
          ? [offTableIssue(placement, coverage.surfaces, region.maxOverhangMm)]
          : [
              carried.bodyBox === null
                ? null
                : offTableIssue(
                    {
                      ...placement,
                      label: `${label}, apart from the track it carries,`,
                      box: bodyRect(carried.bodyBox),
                    },
                    coverage.surfaces,
                    region.maxOverhangMm,
                  ),
              outlineOffTableIssue(ctx, key, carriedTrackSubject(label), carried.outlines),
            ];
    for (const offTable of offTables) if (offTable) out.push(offTable);
  }
  const shape = placement.shape ?? null;
  const anchor = placement.anchor ?? NO_ANCHOR;
  const scratch = listScratch;
  if (outline !== null) {
    const crossing = outlineSeamIssue(ctx, key, label, [outline]);
    if (crossing) out.push(crossing);
  } else {
    if (shape !== null && ctx.seams.edges.length > 0) {
      scratch.footing = placedShapeRects(shape.footing, anchor, scratch.footing);
      const pairs = seamPairs(ctx, scratch.footing, shape.footing.length / RECT_FLOATS);
      if (pairs.length > 0) {
        out.push(
          issue(
            "seam",
            [key],
            `${label} stands across the seam between tables ${pairs.join("; ")}; a seam must fall between placements.`,
          ),
        );
      }
    }
    if (carried !== null) {
      const crossing = outlineSeamIssue(ctx, key, carriedTrackSubject(label), carried.outlines);
      if (crossing) out.push(crossing);
    }
  }
  const reach = ctx.reach;
  if (measured && reach !== null) {
    const { box } = placement;
    scratch.occupancy =
      shape === null
        ? boxRect(
            Float64Array.of(box.minX, 0, box.minZ, box.maxX, 0, box.maxZ),
            0,
            scratch.occupancy,
          )
        : placedShapeRects(shape.occupancy, anchor, scratch.occupancy);
    const rects = shape === null ? 1 : shape.occupancy.length / RECT_FLOATS;
    if (rowReachFails(ctx, reach, scratch.occupancy, rects, scratch)) {
      out.push(
        issue(
          "reach",
          [key],
          `${label} is out of reach: part of it is more than ${region.maxReachMm} mm from every table edge you can stand at.`,
        ),
      );
    }
  }
  const facts = placement.facts;
  if (facts?.overlapWith != null) {
    out.push(issue("overlap", [key], `${label} overlaps ${facts.overlapWith}.`));
  }
  const mismatched = facts?.roadMismatchedCells ?? 0;
  if (mismatched > 0) {
    out.push(
      issue(
        "roadJoin",
        [key],
        `${label}'s road doesn't continue into its neighbour on ${cellsText(mismatched)}: the lanes or curbs differ.`,
      ),
    );
  }
}

export function bomMappingIssueCount(rebrickable: number, brickLink: number): number {
  return (rebrickable > 0 ? 1 : 0) + (brickLink > 0 ? 1 : 0);
}

export function bomMappingIssues(rebrickable: number, brickLink: number, out: PlanIssue[]): void {
  [rebrickable, brickLink].forEach((parts, i) => {
    if (parts <= 0) return;
    const one = parts === 1;
    out.push({
      ...issue(
        "bomMapping",
        [],
        `${parts} ${one ? "part" : "parts"} in this plan ${one ? "has" : "have"} no ${BOM_CATALOGS[i] ?? ""} part or colour id; the parts list names them.`,
      ),
      severity: "warning",
    });
  });
}

export function checkPlan(region: PlanRegion, placements: ReadonlyArray<PlanPlacement>): PlanCheck {
  const ctx = regionContext(region);
  const issues = [...ctx.footprintIssues];
  const inside: PlanPlacement[] = [];
  let rebrickable = 0;
  let brickLink = 0;
  for (const placement of placements) {
    if (!placementInRegion(region, placement.box)) continue;
    inside.push(placement);
    rebrickable += placement.facts?.unmappedRebrickable ?? 0;
    brickLink += placement.facts?.unmappedBrickLink ?? 0;
  }
  bomMappingIssues(rebrickable, brickLink, issues);
  for (const placement of inside) placementIssues(ctx, placement, issues);
  return {
    regionId: region.id,
    room: ctx.room,
    tables: ctx.tables,
    obstacles: ctx.obstacles,
    inside: inside.map((placement) => placement.key),
    issues,
  };
}

export function uncheckedPlan(
  region: PlanRegion,
  placements: ReadonlyArray<PlanPlacement>,
  reason: string,
): PlanCheck {
  const inside = placements
    .filter((placement) => placementInRegion(region, placement.box))
    .map((placement) => placement.key);
  return {
    regionId: region.id,
    room: roomRect(region),
    tables: tableTops(region),
    obstacles: region.footprint.obstacles.map((o) => mmRectInWorld(region, o.rect)),
    inside,
    issues: [issue("unchecked", inside, `Plan "${region.name}" could not be checked: ${reason}`)],
  };
}

export function regionOf(regions: ReadonlyArray<PlanRegion>, box: LduRect): PlanRegion | null {
  return regions.find((region) => placementInRegion(region, box)) ?? null;
}
