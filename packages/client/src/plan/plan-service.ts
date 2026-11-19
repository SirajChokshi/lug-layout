import {
  BOX_MAX_X,
  BOX_MAX_Y,
  BOX_MAX_Z,
  BOX_MIN_X,
  BOX_MIN_Y,
  BOX_MIN_Z,
  BOX_READ,
  BOX_STRIDE,
  NO_ROW,
  PlanEvaluation,
  uncheckedPlan,
  WRITE_UPDATE,
  type LduRect,
  type PlacementKey,
  type PlanCheck,
  type PlanDelta,
  type PlanIssue,
  type PlanObstacle,
  type PlanRegion,
  type PlanTable,
  type TableTop,
} from "@brr/domain";
import { lduFromMm } from "@brr/math";
import { SCENE_BACKEND, type ISceneBackend, type PlanOverlay, type WorldBox } from "@brr/render";
import { inject, injectable } from "inversify";

export const PLAN_GRID_MM = 100;
export const DEFAULT_MAX_OVERHANG_MM = 0;

export interface PlacedForPlan {
  readonly key: PlacementKey;
  readonly ref: string;
  readonly label: string;
  readonly box: WorldBox;
}

export interface PlanStateDump {
  readonly plans: ReadonlyArray<PlanRegion>;
  readonly checks: ReadonlyArray<PlanCheck>;
  readonly placements: ReadonlyArray<PlacedForPlan>;
  readonly sandboxPlacements: ReadonlyArray<PlacementKey>;
  readonly tableTopY: number;
}

export interface PlanView {
  readonly room: LduRect;
  readonly tables: ReadonlyArray<TableTop>;
  readonly obstacles: ReadonlyArray<LduRect>;
}

export interface PlanPlacementsView {
  first(): number;
  next(row: number): number;
  refOf(row: number): string;
  labelOf(row: number): string;
  keyOf(row: number): PlacementKey;
  minX(row: number): number;
  minY(row: number): number;
  minZ(row: number): number;
  maxX(row: number): number;
  maxY(row: number): number;
  maxZ(row: number): number;
}

export interface NewPlan {
  readonly name: string;
  readonly roomWidthMm: number;
  readonly roomDepthMm: number;
  readonly originChunkX: number;
  readonly originChunkZ: number;
}

export type PlanPatch = Partial<
  Pick<PlanRegion, "name" | "originChunkX" | "originChunkZ" | "maxOverhangMm">
> &
  Partial<Pick<PlanRegion["footprint"], "roomWidthMm" | "roomDepthMm">>;

export type TableInput = Omit<PlanTable, "id">;
export type ObstacleInput = Omit<PlanObstacle, "id">;

export interface IPlanService {
  subscribe(listener: () => void): () => void;
  version(): number;
  plans(): ReadonlyArray<PlanRegion>;
  activePlanId(): string | null;
  tableTopY(): number;
  regionView(planId: string): PlanView;
  insideCount(planId: string): number;
  issueCount(planId: string): number;
  issueVersion(planId: string): number;
  issues(planId: string): ReadonlyArray<PlanIssue>;
  sandboxCount(): number;
  placementCount(): number;
  placements(): PlanPlacementsView;
  materialize(): PlanStateDump;
  apply(delta: PlanDelta): void;
  createPlan(plan: NewPlan): string;
  updatePlan(planId: string, patch: PlanPatch): void;
  removePlan(planId: string): void;
  activatePlan(planId: string | null): void;
  addTable(planId: string, table: TableInput): string;
  updateTable(planId: string, tableId: string, patch: Partial<TableInput>): void;
  removeTable(planId: string, tableId: string): void;
  addObstacle(planId: string, obstacle: ObstacleInput): string;
  updateObstacle(planId: string, obstacleId: string, patch: Partial<ObstacleInput>): void;
  removeObstacle(planId: string, obstacleId: string): void;
  setTableTopY(y: number): void;
}

interface UnreadableBox {
  readonly box: WorldBox;
  readonly caught: unknown;
}

interface UncheckedIssues {
  readonly at: number;
  readonly issues: ReadonlyArray<PlanIssue>;
}

function planOverlays(
  plans: ReadonlyArray<PlanRegion>,
  views: ReadonlyArray<PlanView>,
  tableTopY: number,
  activePlanId: string | null,
): PlanOverlay[] {
  return plans.map((plan, i) => {
    const view = views[i];
    const heightMm = plan.footprint.tables[0]?.heightMm ?? 0;
    const floorY = tableTopY - lduFromMm(heightMm);
    const tables = (view?.tables ?? []).map((top) => ({
      minX: top.surface.minX,
      minY: tableTopY - lduFromMm(top.heightMm),
      minZ: top.surface.minZ,
      maxX: top.surface.maxX,
      maxY: tableTopY,
      maxZ: top.surface.maxZ,
    }));
    const obstacles = (view?.obstacles ?? []).map((rect) => ({
      ...rect,
      minY: floorY,
      maxY: tableTopY,
    }));
    const room = view?.room;
    return {
      room: {
        minX: room?.minX ?? 0,
        minY: floorY,
        minZ: room?.minZ ?? 0,
        maxX: room?.maxX ?? 0,
        maxY: floorY,
        maxZ: room?.maxZ ?? 0,
      },
      tables,
      obstacles,
      gridStepLdu: lduFromMm(PLAN_GRID_MM),
      active: plan.id === activePlanId,
    };
  });
}

function onlyName(patch: object): boolean {
  for (const key of Object.keys(patch)) {
    if (key !== "name" && (patch as Record<string, unknown>)[key] !== undefined) return false;
  }
  return true;
}

@injectable()
export class PlanService implements IPlanService {
  private readonly listeners = new Set<() => void>();
  private readonly deliver = (listener: () => void): void => listener();
  private readonly evaluation = new PlanEvaluation();
  private readonly unreadable = new Map<number, UnreadableBox>();
  private readonly uncheckedIssues = new Map<string, UncheckedIssues>();
  private nextId = 1;
  private regions: ReadonlyArray<PlanRegion> = [];
  private active: string | null = null;
  private topY = 0;
  private changes = 0;
  private readonly view: PlanPlacementsView;

  constructor(@inject(SCENE_BACKEND) private readonly backend: ISceneBackend) {
    const rows = this.evaluation.rows;
    this.view = {
      first: () => rows.first(),
      next: (row) => rows.after(row),
      refOf: (row) => rows.refOf(row),
      labelOf: (row) => rows.labelOf(row),
      keyOf: (row) => rows.keyOf(row),
      minX: (row) => this.edge(row, BOX_MIN_X, "minX"),
      minY: (row) => this.edge(row, BOX_MIN_Y, "minY"),
      minZ: (row) => this.edge(row, BOX_MIN_Z, "minZ"),
      maxX: (row) => this.edge(row, BOX_MAX_X, "maxX"),
      maxY: (row) => this.edge(row, BOX_MAX_Y, "maxY"),
      maxZ: (row) => this.edge(row, BOX_MAX_Z, "maxZ"),
    };
  }

  private edge(row: number, offset: number, field: keyof WorldBox): number {
    const rows = this.evaluation.rows;
    if (rows.boxState[row] === BOX_READ) return rows.box[row * BOX_STRIDE + offset] ?? Number.NaN;
    const original = this.unreadable.get(row);
    return original ? original.box[field] : Number.NaN;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  version(): number {
    return this.changes;
  }

  plans(): ReadonlyArray<PlanRegion> {
    return this.regions;
  }

  activePlanId(): string | null {
    return this.active;
  }

  tableTopY(): number {
    return this.topY;
  }

  regionView(planId: string): PlanView {
    return this.evaluation.context(this.indexOf(planId));
  }

  insideCount(planId: string): number {
    const index = this.indexOf(planId);
    return this.evaluation.unchecked() ? 0 : this.evaluation.insideCount(index);
  }

  issueCount(planId: string): number {
    const index = this.indexOf(planId);
    return this.evaluation.unchecked() ? 1 : this.evaluation.issueCount(index);
  }

  issueVersion(planId: string): number {
    return this.evaluation.issueVersion(this.indexOf(planId));
  }

  issues(planId: string): ReadonlyArray<PlanIssue> {
    const index = this.indexOf(planId);
    if (!this.evaluation.unchecked()) return this.evaluation.issues(index);
    const at = this.evaluation.issueVersion(index);
    const cached = this.uncheckedIssues.get(planId);
    if (cached && cached.at === at) return cached.issues;
    const region = this.regions[index];
    if (!region) throw new Error(`no plan ${planId}`);
    const issues = uncheckedPlan(region, [], this.uncheckedReason()).issues;
    this.uncheckedIssues.set(planId, { at, issues });
    return issues;
  }

  sandboxCount(): number {
    return this.evaluation.unchecked() ? 0 : this.evaluation.sandboxCount;
  }

  placementCount(): number {
    return this.evaluation.rows.count;
  }

  placements(): PlanPlacementsView {
    return this.view;
  }

  materialize(): PlanStateDump {
    const evaluation = this.evaluation;
    const rows = evaluation.rows;
    const placements: PlacedForPlan[] = [];
    for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
      placements.push({
        key: rows.keyOf(row),
        ref: rows.refOf(row),
        label: rows.labelOf(row),
        box: this.boxOf(row),
      });
    }
    if (evaluation.unchecked()) {
      const reason = this.uncheckedReason();
      return {
        plans: this.regions,
        checks: this.regions.map((plan) => uncheckedPlan(plan, [], reason)),
        placements,
        sandboxPlacements: [],
        tableTopY: this.topY,
      };
    }
    const checks = this.regions.map((plan, index): PlanCheck => {
      const ctx = evaluation.context(index);
      const inside: PlacementKey[] = [];
      for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
        if (evaluation.isInside(index, row)) inside.push(rows.keyOf(row));
      }
      return {
        regionId: plan.id,
        room: ctx.room,
        tables: ctx.tables,
        obstacles: ctx.obstacles,
        inside,
        issues: evaluation.issues(index),
      };
    });
    const sandboxPlacements: PlacementKey[] = [];
    for (let row = rows.first(); row !== NO_ROW; row = rows.after(row)) {
      if (evaluation.regionsInOf(row) === 0) sandboxPlacements.push(rows.keyOf(row));
    }
    return { plans: this.regions, checks, placements, sandboxPlacements, tableTopY: this.topY };
  }

  apply(delta: PlanDelta): void {
    const evaluation = this.evaluation;
    const rows = evaluation.rows;
    evaluation.resetChanges();
    if (delta.cleared) this.unreadable.clear();
    if (this.unreadable.size > 0) {
      for (let k = 0; k < delta.removalCount; k++) {
        this.unreadable.delete(
          rows.find(delta.removalSegment[k] ?? 0, delta.removalSource[k] ?? 0),
        );
      }
      for (let e = 0; e < delta.writeCount; e++) {
        if (delta.writeKind[e] !== WRITE_UPDATE) continue;
        this.unreadable.delete(rows.find(delta.writeSegment[e] ?? 0, delta.writeSource[e] ?? 0));
      }
    }
    evaluation.apply(delta);
    for (let e = 0; e < delta.writeCount; e++) {
      if (delta.boxState[e] === BOX_READ) continue;
      const row = rows.find(delta.writeSegment[e] ?? 0, delta.writeSource[e] ?? 0);
      this.unreadable.set(row, {
        box: delta.original[e] as WorldBox,
        caught: delta.caught[e],
      });
    }
    this.afterChange(false);
  }

  private newId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private indexOf(planId: string): number {
    const regions = this.regions;
    for (let i = 0; i < regions.length; i++) {
      if (regions[i]?.id === planId) return i;
    }
    throw new Error(`no plan ${planId}`);
  }

  private boxOf(row: number): WorldBox {
    const rows = this.evaluation.rows;
    if (rows.boxState[row] !== BOX_READ) {
      const original = this.unreadable.get(row);
      if (original) return original.box;
    }
    const at = row * BOX_STRIDE;
    return {
      minX: rows.box[at + BOX_MIN_X] ?? Number.NaN,
      minY: rows.box[at + BOX_MIN_Y] ?? Number.NaN,
      minZ: rows.box[at + BOX_MIN_Z] ?? Number.NaN,
      maxX: rows.box[at + BOX_MAX_X] ?? Number.NaN,
      maxY: rows.box[at + BOX_MAX_Y] ?? Number.NaN,
      maxZ: rows.box[at + BOX_MAX_Z] ?? Number.NaN,
    };
  }

  private uncheckedReason(): string {
    return String(this.unreadable.get(this.evaluation.firstPlanUnreadable)?.caught);
  }

  private editRegion(
    planId: string,
    next: (plan: PlanRegion) => PlanRegion,
    geometry: boolean,
  ): void {
    this.evaluation.resetChanges();
    const index = this.regions.findIndex((plan) => plan.id === planId);
    const plan = this.regions[index];
    if (plan) {
      const replaced = next(plan);
      this.regions = this.regions.map((p, i) => (i === index ? replaced : p));
      if (geometry) this.evaluation.replaceRegion(index, replaced);
      else this.evaluation.renameRegion(index, replaced);
    }
    this.afterChange(true);
  }

  createPlan(plan: NewPlan): string {
    const id = this.newId("plan");
    const region: PlanRegion = {
      id,
      name: plan.name,
      originChunkX: plan.originChunkX,
      originChunkZ: plan.originChunkZ,
      footprint: {
        roomWidthMm: plan.roomWidthMm,
        roomDepthMm: plan.roomDepthMm,
        tables: [],
        obstacles: [],
      },
      maxOverhangMm: DEFAULT_MAX_OVERHANG_MM,
    };
    this.evaluation.resetChanges();
    this.regions = [...this.regions, region];
    this.active = id;
    this.evaluation.addRegion(region);
    this.afterChange(true);
    return id;
  }

  updatePlan(planId: string, patch: PlanPatch): void {
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        name: patch.name ?? plan.name,
        originChunkX: patch.originChunkX ?? plan.originChunkX,
        originChunkZ: patch.originChunkZ ?? plan.originChunkZ,
        maxOverhangMm: patch.maxOverhangMm ?? plan.maxOverhangMm,
        footprint: {
          ...plan.footprint,
          roomWidthMm: patch.roomWidthMm ?? plan.footprint.roomWidthMm,
          roomDepthMm: patch.roomDepthMm ?? plan.footprint.roomDepthMm,
        },
      }),
      !onlyName(patch),
    );
  }

  removePlan(planId: string): void {
    const index = this.indexOf(planId);
    this.evaluation.resetChanges();
    const plans = this.regions.filter((p) => p.id !== planId);
    this.regions = plans;
    if (this.active === planId) this.active = plans[0]?.id ?? null;
    this.evaluation.removeRegion(index);
    this.uncheckedIssues.delete(planId);
    this.afterChange(true);
  }

  activatePlan(planId: string | null): void {
    if (planId !== null) this.indexOf(planId);
    this.evaluation.resetChanges();
    this.active = planId;
    this.afterChange(true);
  }

  addTable(planId: string, table: TableInput): string {
    const id = this.newId("table");
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        footprint: { ...plan.footprint, tables: [...plan.footprint.tables, { ...table, id }] },
      }),
      true,
    );
    return id;
  }

  updateTable(planId: string, tableId: string, patch: Partial<TableInput>): void {
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        footprint: {
          ...plan.footprint,
          tables: plan.footprint.tables.map((t) => (t.id === tableId ? { ...t, ...patch } : t)),
        },
      }),
      !onlyName(patch),
    );
  }

  removeTable(planId: string, tableId: string): void {
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        footprint: {
          ...plan.footprint,
          tables: plan.footprint.tables.filter((t) => t.id !== tableId),
        },
      }),
      true,
    );
  }

  addObstacle(planId: string, obstacle: ObstacleInput): string {
    const id = this.newId("obstacle");
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        footprint: {
          ...plan.footprint,
          obstacles: [...plan.footprint.obstacles, { ...obstacle, id }],
        },
      }),
      true,
    );
    return id;
  }

  updateObstacle(planId: string, obstacleId: string, patch: Partial<ObstacleInput>): void {
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        footprint: {
          ...plan.footprint,
          obstacles: plan.footprint.obstacles.map((o) =>
            o.id === obstacleId ? { ...o, ...patch } : o,
          ),
        },
      }),
      !onlyName(patch),
    );
  }

  removeObstacle(planId: string, obstacleId: string): void {
    this.editRegion(
      planId,
      (plan) => ({
        ...plan,
        footprint: {
          ...plan.footprint,
          obstacles: plan.footprint.obstacles.filter((o) => o.id !== obstacleId),
        },
      }),
      true,
    );
  }

  setTableTopY(y: number): void {
    this.evaluation.resetChanges();
    this.topY = y;
    this.afterChange(true);
  }

  private afterChange(overlays: boolean): void {
    if (overlays) this.drawOverlays();
    this.drawIssueBoxes();
    this.changes++;
    this.listeners.forEach(this.deliver);
  }

  private drawOverlays(): void {
    const views: PlanView[] = [];
    for (let i = 0; i < this.regions.length; i++) views.push(this.evaluation.context(i));
    this.backend.setPlanOverlays(planOverlays(this.regions, views, this.topY, this.active));
  }

  private drawIssueBoxes(): void {
    const evaluation = this.evaluation;
    if (evaluation.unchecked()) {
      if (evaluation.uncheckedChanged) this.backend.setIssueBoxes([]);
      return;
    }
    const changed =
      evaluation.uncheckedChanged ||
      evaluation.flaggedMembershipChanged ||
      evaluation.flaggedBoxChanged;
    if (!changed) return;
    const boxes: WorldBox[] = [];
    for (let row = evaluation.firstFlagged(); row !== NO_ROW; row = evaluation.nextFlagged(row)) {
      boxes.push(this.boxOf(row));
    }
    this.backend.setIssueBoxes(boxes);
  }
}
