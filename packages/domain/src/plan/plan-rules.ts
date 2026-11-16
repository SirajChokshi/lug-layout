import { lduFromMm, mmFromLdu } from "@brr/math";
import {
  mmRectInWorld,
  rectContains,
  rectsOverlap,
  roomRect,
  studsInside,
  uncoveredBy,
  type LduRect,
  type MmRect,
  type PlanRegion,
  type StudRect,
} from "./plan-region.ts";

export type PlanRuleId = "footprint" | "fit" | "crossesRegion";
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
  readonly offTableMm2: number;
}

const ON_TABLE: OffTable = { overhangMm: 0, nearestTableMm: 0, offTableMm2: 0 };

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

function grown(rect: LduRect, by: number): LduRect {
  return {
    minX: rect.minX - by,
    minZ: rect.minZ - by,
    maxX: rect.maxX + by,
    maxZ: rect.maxZ + by,
  };
}

function areaMm2(rects: ReadonlyArray<LduRect>): number {
  return rects.reduce((sum, r) => sum + mmFromLdu(r.maxX - r.minX) * mmFromLdu(r.maxZ - r.minZ), 0);
}

function coveredWithin(box: LduRect, tables: ReadonlyArray<LduRect>, reach: number): boolean {
  return (
    uncoveredBy(
      box,
      tables.map((table) => grown(table, reach)),
    ).length === 0
  );
}

function reachCandidates(box: LduRect, tables: ReadonlyArray<LduRect>): number[] {
  const candidates = new Set<number>([0]);
  const add = (value: number): void => {
    if (value > 0) candidates.add(value);
  };
  tables.forEach((table, i) => {
    for (const [boxMin, boxMax, tableMin, tableMax] of [
      [box.minX, box.maxX, table.minX, table.maxX],
      [box.minZ, box.maxZ, table.minZ, table.maxZ],
    ] as const) {
      add(tableMin - boxMin);
      add(boxMax - tableMax);
      add(tableMin - boxMax);
      add(boxMin - tableMax);
    }
    for (const other of tables.slice(i + 1)) {
      add((other.minX - table.maxX) / 2);
      add((table.minX - other.maxX) / 2);
      add((other.minZ - table.maxZ) / 2);
      add((table.minZ - other.maxZ) / 2);
    }
  });
  return [...candidates];
}

export function overhangLdu(box: LduRect, tables: ReadonlyArray<LduRect>): number {
  if (tables.length === 0) return Number.POSITIVE_INFINITY;
  const covering = reachCandidates(box, tables).filter((r) => coveredWithin(box, tables, r));
  const reach = Math.min(...covering);
  if (covering.length === 0)
    throw new Error("no candidate reach covers the box; candidates are incomplete");
  return reach;
}

export function nearestTableLdu(box: LduRect, tables: ReadonlyArray<LduRect>): number {
  return tables.reduce((nearest, table) => {
    const gapX = Math.max(table.minX - box.maxX, box.minX - table.maxX, 0);
    const gapZ = Math.max(table.minZ - box.maxZ, box.minZ - table.maxZ, 0);
    return Math.min(nearest, Math.max(gapX, gapZ));
  }, Number.POSITIVE_INFINITY);
}

function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function offTableMessage(label: string, offTable: OffTable, limitMm: number): string {
  const away =
    offTable.nearestTableMm > 0
      ? ` It is entirely off the tables, ${tenths(offTable.nearestTableMm)} mm from the nearest one.`
      : "";
  return `${label} overhangs the tables: it reaches ${tenths(offTable.overhangMm)} mm past the nearest table edge along x or z (limit ${limitMm} mm), with ${Math.round(offTable.offTableMm2)} mm² of its footprint off the table tops.${away}`;
}

export function placementInRegion(region: PlanRegion, box: LduRect): boolean {
  return rectsOverlap(roomRect(region), box);
}

export function checkPlan(region: PlanRegion, placements: ReadonlyArray<PlanPlacement>): PlanCheck {
  const room = roomRect(region);
  const tables: TableTop[] = region.footprint.tables.map((table) => ({
    id: table.id,
    name: table.name,
    heightMm: table.heightMm,
    surface: mmRectInWorld(region, table.rect),
    studs: studsInside(region, table.rect),
  }));
  const obstacles = region.footprint.obstacles.map((o) => mmRectInWorld(region, o.rect));
  const surfaces = tables.map((table) => table.surface);
  const limitLdu = lduFromMm(region.maxOverhangMm);
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
    const blocked = region.footprint.obstacles.filter((_, i) => {
      const obstacle = obstacles[i];
      return obstacle !== undefined && rectsOverlap(obstacle, placement.box);
    });
    for (const obstacle of blocked) {
      issues.push(
        issue(
          "fit",
          [placement.key],
          `${placement.label} stands over obstacle "${obstacle.name}".`,
        ),
      );
    }
    if (surfaces.length === 0) {
      issues.push(issue("fit", [placement.key], `${placement.label} is in a plan with no tables.`));
      continue;
    }
    const reach = overhangLdu(placement.box, surfaces);
    if (reach > limitLdu) {
      const offTable: OffTable = {
        overhangMm: mmFromLdu(reach),
        nearestTableMm: mmFromLdu(nearestTableLdu(placement.box, surfaces)),
        offTableMm2: areaMm2(uncoveredBy(placement.box, surfaces)),
      };
      issues.push(
        issue(
          "fit",
          [placement.key],
          offTableMessage(placement.label, offTable, region.maxOverhangMm),
          offTable,
        ),
      );
    }
  }
  return { regionId: region.id, room, tables, obstacles, inside, issues };
}

export function regionOf(regions: ReadonlyArray<PlanRegion>, box: LduRect): PlanRegion | null {
  return regions.find((region) => placementInRegion(region, box)) ?? null;
}
