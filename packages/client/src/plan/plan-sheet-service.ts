import {
  mmRectInWorld,
  NO_ROW,
  regionOriginX,
  regionOriginZ,
  rectsOverlap,
  type LduRect,
  type OutlineRing,
  type PlacementKey,
  type PlanIssue,
} from "@brr/domain";
import { inject, injectable } from "inversify";
import type { IBomSource } from "../bom/bom-service.ts";
import { PLAN_SERVICE, TRADEMARK_DISCLAIMER } from "../tokens.ts";
import {
  planSheetSvg,
  ringsBounds,
  type SheetPartsList,
  type SheetPlacement,
  type SheetVerdict,
} from "./plan-sheet.ts";
import type { IPlanService, PlanPlacementsView, PlanRowSegment } from "./plan-service.ts";
import { buildableAsPlanned, UNCHECKED_PLAN_RULES } from "./plan-verdict.ts";

export interface PlanSheetShapes {
  partsOf(segment: PlanRowSegment, source: number): number;
  roadwayOf(model: number): ReadonlyArray<LduRect>;
  trackOutlineOf(piece: number): ReadonlyArray<OutlineRing>;
  readonly crossingRamps: ReadonlyArray<ReadonlyArray<OutlineRing>>;
}

export interface IPlanSheetSource extends IBomSource {
  planSheetShapes(): PlanSheetShapes;
}

export interface IPlanSheetService {
  printable(source: IPlanSheetSource, planId: string): string;
}

function keyText(key: PlacementKey): string {
  return `${key.chunkKey}:${key.slot}`;
}

function flaggedKeys(issues: ReadonlyArray<PlanIssue>): ReadonlySet<string> {
  const flagged = new Set<string>();
  for (const issue of issues) for (const key of issue.placements) flagged.add(keyText(key));
  return flagged;
}

function boxRings(rows: PlanPlacementsView, row: number): ReadonlyArray<OutlineRing> {
  const minX = rows.minX(row);
  const minZ = rows.minZ(row);
  const maxX = rows.maxX(row);
  const maxZ = rows.maxZ(row);
  return [
    [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
    ],
  ];
}

function partsListOf(source: IBomSource, planId: string): SheetPartsList {
  const bom = source.bomInput({ kind: "plan", planId });
  return {
    placements: bom.placements,
    parts: bom.counter.total(),
    lines: bom.counter.lines().length,
    uncounted: bom.uncounted.length,
  };
}

function ringsOf(
  shapes: PlanSheetShapes,
  rows: PlanPlacementsView,
  row: number,
): ReadonlyArray<OutlineRing> {
  const segment = rows.segmentOf(row);
  switch (segment) {
    case "model":
      return boxRings(rows, row);
    case "track":
      return shapes.trackOutlineOf(rows.sourceOf(row));
    default: {
      const unhandled: never = segment;
      throw new Error(`unhandled plan segment ${String(unhandled)}`);
    }
  }
}

@injectable()
export class PlanSheetService implements IPlanSheetService {
  constructor(
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(TRADEMARK_DISCLAIMER) private readonly disclaimer: string,
  ) {}

  printable(source: IPlanSheetSource, planId: string): string {
    const plans = this.plans;
    const region = plans.plans().find((plan) => plan.id === planId);
    if (!region) throw new Error(`no plan ${planId}`);
    const view = plans.regionView(planId);
    const shapes = source.planSheetShapes();
    const issues = plans.issues(planId);
    const unchecked = issues.find((issue) => issue.rule === "unchecked")?.message ?? null;
    const flagged = flaggedKeys(issues);
    const rows = plans.placements();
    const placements: SheetPlacement[] = [];
    const roadway: LduRect[] = [];
    for (let row = rows.first(); row !== NO_ROW; row = rows.next(row)) {
      if (!plans.contains(planId, row)) continue;
      const segment = rows.segmentOf(row);
      const id = rows.sourceOf(row);
      placements.push({
        number: placements.length + 1,
        label: rows.labelOf(row),
        parts: shapes.partsOf(segment, id),
        segment,
        rings: ringsOf(shapes, rows, row),
        flagged: flagged.has(keyText(rows.keyOf(row))),
      });
      if (segment === "model") roadway.push(...shapes.roadwayOf(id));
    }
    return planSheetSvg({
      name: region.name,
      originX: regionOriginX(region),
      originZ: regionOriginZ(region),
      room: view.room,
      tables: view.tables,
      obstacles: region.footprint.obstacles.map((obstacle) => ({
        name: obstacle.name,
        rect: mmRectInWorld(region, obstacle.rect),
      })),
      roadway,
      ramps: shapes.crossingRamps.filter((ramp) => rectsOverlap(ringsBounds(ramp), view.room)),
      placements,
      partsList: unchecked === null ? partsListOf(source, planId) : null,
      verdict: this.verdictOf(planId, unchecked),
      disclaimer: this.disclaimer,
    });
  }

  private verdictOf(planId: string, unchecked: string | null): SheetVerdict {
    const plans = this.plans;
    return {
      buildable: buildableAsPlanned(plans, planId),
      issues: plans.issueCount(planId),
      unmeasured: plans.unmeasuredCount(planId),
      notChecked: UNCHECKED_PLAN_RULES.map((rule) => `${rule.text} (${rule.owner})`),
      unchecked,
    };
  }
}
