import { lduFromMm } from "@brr/math";
import {
  ExactFrame,
  exactArea,
  exactCoveredWithin,
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

export type PlanRuleId = "footprint" | "fit" | "crossesRegion" | "unchecked";
export type IssueSeverity = "error" | "warning";

export interface PlacementKey {
  readonly chunkKey: number;
  readonly slot: number;
}

export interface PlanPlacement {
  readonly key: PlacementKey;
  readonly ref: string;
  readonly label: string;
  readonly box: LduRect;
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
  readonly name: string;
  readonly heightMm: number;
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
  const reach = `${label} overhangs the tables: it reaches ${shown.overhangTenthsUp} mm past the nearest table edge along x or z (limit ${limitMm} mm), with ${shown.offTableMm2Up} mm² of its footprint off the table tops.`;
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
    name: table.name,
    heightMm: table.heightMm,
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

const RECT_STRIDE = 4;
const PIECES_PER_CUT = 4;
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
}

export class CoverageScratch {
  grown = new Float64Array(INITIAL_PIECE_FLOATS);
  pieces = new Float64Array(INITIAL_PIECE_FLOATS);
  spare = new Float64Array(INITIAL_PIECE_FLOATS);
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

export function regionContext(region: PlanRegion): PlanRegionContext {
  const room = roomRect(region);
  const tables = tableTops(region);
  const obstacles = region.footprint.obstacles.map((o) => mmRectInWorld(region, o.rect));
  return {
    region,
    room,
    tables,
    obstacles,
    obstacleEdges: rectEdges(obstacles),
    footprintIssues: footprintIssues(region, room),
    coverage: coverageContext(
      tables.map((table) => table.surface),
      lduFromMm(region.maxOverhangMm),
    ),
  };
}

function certifiedSum(t: number, q: number, s: number): boolean {
  if (!(Math.abs(t) <= CERTIFIED_MAGNITUDE) || !(Math.abs(q) <= CERTIFIED_MAGNITUDE)) return false;
  if (!Number.isFinite(s)) return false;
  const bb = s - t;
  return t - (s - bb) + (q - bb) === 0;
}

function growTo(buffer: Float64Array<ArrayBuffer>, floats: number): Float64Array<ArrayBuffer> {
  if (buffer.length >= floats) return buffer;
  return new Float64Array(Math.max(floats, buffer.length * 2));
}

function certifyGrownEdges(coverage: CoverageContext, scratch: CoverageScratch): boolean {
  const edges = coverage.surfaceEdges;
  const reach = coverage.reachLdu;
  const back = -reach;
  scratch.grown = growTo(scratch.grown, edges.length);
  const grown = scratch.grown;
  for (let i = 0; i < edges.length; i += RECT_STRIDE) {
    const minX = edges[i] ?? Number.NaN;
    const minZ = edges[i + 1] ?? Number.NaN;
    const maxX = edges[i + 2] ?? Number.NaN;
    const maxZ = edges[i + 3] ?? Number.NaN;
    const grownMinX = minX + back;
    const grownMinZ = minZ + back;
    const grownMaxX = maxX + reach;
    const grownMaxZ = maxZ + reach;
    if (
      !certifiedSum(minX, back, grownMinX) ||
      !certifiedSum(minZ, back, grownMinZ) ||
      !certifiedSum(maxX, reach, grownMaxX) ||
      !certifiedSum(maxZ, reach, grownMaxZ)
    ) {
      return false;
    }
    grown[i] = grownMinX;
    grown[i + 1] = grownMinZ;
    grown[i + 2] = grownMaxX;
    grown[i + 3] = grownMaxZ;
  }
  return true;
}

function pushPiece(
  into: Float64Array,
  count: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): number {
  const at = count * RECT_STRIDE;
  into[at] = minX;
  into[at + 1] = minZ;
  into[at + 2] = maxX;
  into[at + 3] = maxZ;
  return count + 1;
}

function subtractCut(
  from: Float64Array,
  fromCount: number,
  into: Float64Array,
  cMinX: number,
  cMinZ: number,
  cMaxX: number,
  cMaxZ: number,
): number {
  let count = 0;
  for (let p = 0; p < fromCount; p++) {
    const at = p * RECT_STRIDE;
    const pMinX = from[at] ?? Number.NaN;
    const pMinZ = from[at + 1] ?? Number.NaN;
    const pMaxX = from[at + 2] ?? Number.NaN;
    const pMaxZ = from[at + 3] ?? Number.NaN;
    if (!(pMinX < cMaxX && cMinX < pMaxX && pMinZ < cMaxZ && cMinZ < pMaxZ)) {
      count = pushPiece(into, count, pMinX, pMinZ, pMaxX, pMaxZ);
      continue;
    }
    if (pMinX < cMinX) count = pushPiece(into, count, pMinX, pMinZ, cMinX, pMaxZ);
    if (cMaxX < pMaxX) count = pushPiece(into, count, cMaxX, pMinZ, pMaxX, pMaxZ);
    const minX = pMinX > cMinX ? pMinX : cMinX;
    const maxX = pMaxX < cMaxX ? pMaxX : cMaxX;
    if (pMinZ < cMinZ) count = pushPiece(into, count, minX, pMinZ, maxX, cMinZ);
    if (cMaxZ < pMaxZ) count = pushPiece(into, count, minX, cMaxZ, maxX, pMaxZ);
  }
  return count;
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
  let count = pushPiece(
    current,
    0,
    box[offset + BOX_MIN_X] ?? Number.NaN,
    box[offset + BOX_MIN_Z] ?? Number.NaN,
    box[offset + BOX_MAX_X] ?? Number.NaN,
    box[offset + BOX_MAX_Z] ?? Number.NaN,
  );
  for (let i = 0; i < cuts && count > 0; i += RECT_STRIDE) {
    next = growTo(next, count * PIECES_PER_CUT * RECT_STRIDE);
    count = subtractCut(
      current,
      count,
      next,
      grown[i] ?? Number.NaN,
      grown[i + 1] ?? Number.NaN,
      grown[i + 2] ?? Number.NaN,
      grown[i + 3] ?? Number.NaN,
    );
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

function fitIssueCount(
  coverage: CoverageContext,
  box: Float64Array,
  offset: number,
  scratch: CoverageScratch,
): number {
  const minX = box[offset + BOX_MIN_X] ?? Number.NaN;
  const minZ = box[offset + BOX_MIN_Z] ?? Number.NaN;
  const maxX = box[offset + BOX_MAX_X] ?? Number.NaN;
  const maxZ = box[offset + BOX_MAX_Z] ?? Number.NaN;
  if (coverage.surfaces.length === 0) return 1;
  const finite =
    Number.isFinite(minX) &&
    Number.isFinite(minZ) &&
    Number.isFinite(maxX) &&
    Number.isFinite(maxZ) &&
    coverage.surfacesFinite;
  if (!finite) return 1;
  const pieces = uncoveredPieces(coverage, box, offset, scratch);
  if (pieces !== UNDECIDED) return pieces === 0 ? 0 : 1;
  return fitsExactly({ minX, minZ, maxX, maxZ }, coverage.surfaces, coverage.reachLdu) ? 0 : 1;
}

export function placementIssueCount(
  ctx: PlanRegionContext,
  box: Float64Array,
  offset: number,
  scratch: CoverageScratch,
): number {
  if (!placementInside(ctx, box, offset)) return 0;
  const room = ctx.room;
  const minX = box[offset + BOX_MIN_X] ?? Number.NaN;
  const minZ = box[offset + BOX_MIN_Z] ?? Number.NaN;
  const maxX = box[offset + BOX_MAX_X] ?? Number.NaN;
  const maxZ = box[offset + BOX_MAX_Z] ?? Number.NaN;
  let count = 0;
  if (!(minX >= room.minX && maxX <= room.maxX && minZ >= room.minZ && maxZ <= room.maxZ)) count++;
  const obstacles = ctx.obstacleEdges;
  for (let i = 0; i < obstacles.length; i += RECT_STRIDE) {
    const oMinX = obstacles[i] ?? Number.NaN;
    const oMinZ = obstacles[i + 1] ?? Number.NaN;
    const oMaxX = obstacles[i + 2] ?? Number.NaN;
    const oMaxZ = obstacles[i + 3] ?? Number.NaN;
    if (oMinX < maxX && minX < oMaxX && oMinZ < maxZ && minZ < oMaxZ) count++;
  }
  return count + fitIssueCount(ctx.coverage, box, offset, scratch);
}

export function placementIssues(
  ctx: PlanRegionContext,
  placement: PlanPlacement,
  out: PlanIssue[],
): void {
  const { region, room, obstacles, coverage } = ctx;
  if (!rectsOverlap(room, placement.box)) return;
  if (!rectContains(room, placement.box)) {
    out.push(
      issue(
        "crossesRegion",
        [placement.key],
        `${placement.label} crosses the edge of plan "${region.name}".`,
      ),
    );
  }
  region.footprint.obstacles.forEach((obstacle, i) => {
    const rect = obstacles[i];
    if (rect && rectsOverlap(rect, placement.box)) {
      out.push(
        issue(
          "fit",
          [placement.key],
          `${placement.label} stands over obstacle "${obstacle.name}".`,
        ),
      );
    }
  });
  if (coverage.surfaces.length === 0) {
    out.push(issue("fit", [placement.key], `${placement.label} is in a plan with no tables.`));
    return;
  }
  if (!isFiniteRect(placement.box) || !coverage.surfacesFinite) {
    out.push(
      issue("fit", [placement.key], `${placement.label} has no finite footprint to measure.`),
    );
    return;
  }
  const offTable = offTableIssue(placement, coverage.surfaces, region.maxOverhangMm);
  if (offTable) out.push(offTable);
}

export function checkPlan(region: PlanRegion, placements: ReadonlyArray<PlanPlacement>): PlanCheck {
  const ctx = regionContext(region);
  const issues = [...ctx.footprintIssues];
  const inside: PlacementKey[] = [];
  for (const placement of placements) {
    if (!placementInRegion(region, placement.box)) continue;
    inside.push(placement.key);
    placementIssues(ctx, placement, issues);
  }
  return {
    regionId: region.id,
    room: ctx.room,
    tables: ctx.tables,
    obstacles: ctx.obstacles,
    inside,
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
