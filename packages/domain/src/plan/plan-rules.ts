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

export function overhangLdu(box: LduRect, tables: ReadonlyArray<LduRect>): number {
  if (tables.length === 0) return Number.POSITIVE_INFINITY;
  const frame = frameFor(box, tables, 0);
  return frame.toLdu(
    exactReach(
      frame.rect(box),
      tables.map((t) => frame.rect(t)),
    ),
  );
}

export function nearestTableLdu(box: LduRect, tables: ReadonlyArray<LduRect>): number {
  if (tables.length === 0) return Number.POSITIVE_INFINITY;
  const frame = frameFor(box, tables, 0);
  return frame.toLdu(
    exactNearest(
      frame.rect(box),
      tables.map((t) => frame.rect(t)),
    ),
  );
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

export function checkPlan(region: PlanRegion, placements: ReadonlyArray<PlanPlacement>): PlanCheck {
  const room = roomRect(region);
  const tables = tableTops(region);
  const obstacles = region.footprint.obstacles.map((o) => mmRectInWorld(region, o.rect));
  const surfaces = tables.map((table) => table.surface);
  const issues = footprintIssues(region, room);
  const inside: PlacementKey[] = [];
  for (const placement of placements) {
    if (!placementInRegion(region, placement.box)) continue;
    inside.push(placement.key);
    if (!rectContains(room, placement.box)) {
      issues.push(
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
        issues.push(
          issue(
            "fit",
            [placement.key],
            `${placement.label} stands over obstacle "${obstacle.name}".`,
          ),
        );
      }
    });
    if (surfaces.length === 0) {
      issues.push(issue("fit", [placement.key], `${placement.label} is in a plan with no tables.`));
      continue;
    }
    if (!isFiniteRect(placement.box) || !surfaces.every(isFiniteRect)) {
      issues.push(
        issue("fit", [placement.key], `${placement.label} has no finite footprint to measure.`),
      );
      continue;
    }
    const offTable = offTableIssue(placement, surfaces, region.maxOverhangMm);
    if (offTable) issues.push(offTable);
  }
  return { regionId: region.id, room, tables, obstacles, inside, issues };
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
