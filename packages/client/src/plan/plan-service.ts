import {
  checkPlan,
  mmRectFromWorld,
  mmRectInWorld,
  regionAround,
  regionOf,
  uncheckedPlan,
  type LduRect,
  type PlacementKey,
  type PlanCheck,
  type PlanObstacle,
  type PlanPlacement,
  type PlanRegion,
  type PlanTable,
} from "@brr/domain";
import { CHUNK_LDU, chunkOf, lduFromMm, mmFromLdu } from "@brr/math";
import { SCENE_BACKEND, type ISceneBackend, type PlanOverlay, type WorldBox } from "@brr/render";
import { inject, injectable } from "inversify";

export const DEFAULT_MAX_OVERHANG_MM = 0;
export const DEFAULT_TABLE_HEIGHT_MM = 750;

export interface DrawnTable {
  readonly planId: string;
  readonly tableId: string;
}

export interface PlacedForPlan {
  readonly key: PlacementKey;
  readonly ref: string;
  readonly label: string;
  readonly box: WorldBox;
}

export interface PlanSnapshot {
  readonly plans: ReadonlyArray<PlanRegion>;
  readonly activePlanId: string | null;
  readonly checks: ReadonlyArray<PlanCheck>;
  readonly placements: ReadonlyArray<PlacedForPlan>;
  readonly sandboxPlacements: ReadonlyArray<PlacementKey>;
  readonly tableTopY: number;
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
  snapshot(): PlanSnapshot;
  createPlan(plan: NewPlan): string;
  updatePlan(planId: string, patch: PlanPatch): void;
  removePlan(planId: string): void;
  activatePlan(planId: string | null): void;
  addTable(planId: string, table: TableInput): string;
  updateTable(planId: string, tableId: string, patch: Partial<TableInput>): void;
  removeTable(planId: string, tableId: string): void;
  drawTable(rect: LduRect): DrawnTable;
  placeTable(planId: string, tableId: string, rect: LduRect): void;
  addObstacle(planId: string, obstacle: ObstacleInput): string;
  updateObstacle(planId: string, obstacleId: string, patch: Partial<ObstacleInput>): void;
  removeObstacle(planId: string, obstacleId: string): void;
  setPlacements(placements: ReadonlyArray<PlacedForPlan>): void;
  setTableTopY(y: number): void;
  onEdit(listener: () => void): () => void;
  undo(): boolean;
  redo(): boolean;
  discardRedo(): void;
}

type PlanState = Pick<PlanSnapshot, "plans" | "activePlanId">;

type Evaluation = Pick<PlanSnapshot, "checks" | "sandboxPlacements">;

function evaluate(
  plans: ReadonlyArray<PlanRegion>,
  placed: ReadonlyArray<PlacedForPlan>,
): Evaluation {
  try {
    const domain = placed.map(toDomain);
    return {
      checks: plans.map((plan) => checkPlan(plan, domain)),
      sandboxPlacements: domain
        .filter((placement) => regionOf(plans, placement.box) === null)
        .map((placement) => placement.key),
    };
  } catch (error) {
    return {
      checks: plans.map((plan) => uncheckedPlan(plan, [], String(error))),
      sandboxPlacements: [],
    };
  }
}

function placementId(key: PlacementKey): string {
  return `${key.chunkKey}:${key.slot}`;
}

function toDomain(placement: PlacedForPlan): PlanPlacement {
  const { box } = placement;
  return {
    key: placement.key,
    ref: placement.ref,
    label: placement.label,
    box: { minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ },
  };
}

@injectable()
export class PlanService implements IPlanService {
  private readonly listeners = new Set<() => void>();
  private readonly editListeners = new Set<() => void>();
  private readonly undone: PlanState[] = [];
  private readonly done: PlanState[] = [];
  private grouped = 0;
  private nextId = 1;
  private state: PlanSnapshot = {
    plans: [],
    activePlanId: null,
    checks: [],
    placements: [],
    sandboxPlacements: [],
    tableTopY: 0,
  };

  constructor(@inject(SCENE_BACKEND) private readonly backend: ISceneBackend) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PlanSnapshot {
    return this.state;
  }

  private newId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private plan(planId: string): PlanRegion {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`no plan ${planId}`);
    return plan;
  }

  private replacePlan(planId: string, next: (plan: PlanRegion) => PlanRegion): void {
    this.commitEdit({
      plans: this.state.plans.map((plan) => (plan.id === planId ? next(plan) : plan)),
    });
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
    this.commitEdit({ plans: [...this.state.plans, region], activePlanId: id });
    return id;
  }

  updatePlan(planId: string, patch: PlanPatch): void {
    this.replacePlan(planId, (plan) => ({
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
    }));
  }

  removePlan(planId: string): void {
    this.plan(planId);
    const plans = this.state.plans.filter((p) => p.id !== planId);
    this.commitEdit({
      plans,
      activePlanId:
        this.state.activePlanId === planId ? (plans[0]?.id ?? null) : this.state.activePlanId,
    });
  }

  activatePlan(planId: string | null): void {
    if (planId !== null) this.plan(planId);
    this.commit({ activePlanId: planId });
  }

  addTable(planId: string, table: TableInput): string {
    const id = this.newId("table");
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: { ...plan.footprint, tables: [...plan.footprint.tables, { ...table, id }] },
    }));
    return id;
  }

  updateTable(planId: string, tableId: string, patch: Partial<TableInput>): void {
    this.replacePlan(planId, (plan) => {
      const updated = {
        ...plan,
        footprint: {
          ...plan.footprint,
          tables: plan.footprint.tables.map((t) => (t.id === tableId ? { ...t, ...patch } : t)),
        },
      };
      return patch.rect ? regionAround(updated, mmRectInWorld(updated, patch.rect), 0) : updated;
    });
  }

  drawTable(rect: LduRect): DrawnTable {
    const before = this.planState();
    this.grouped++;
    try {
      return this.addDrawnTable(rect);
    } finally {
      this.grouped--;
      this.recordEdit(before);
    }
  }

  private addDrawnTable(rect: LduRect): DrawnTable {
    const planId = this.state.activePlanId ?? this.createPlanAround(rect);
    const tableId = this.newId("table");
    this.replacePlan(planId, (plan) => {
      const grown = regionAround(plan, rect, 0);
      const { tables } = grown.footprint;
      const table = {
        id: tableId,
        name: `Table ${tables.length + 1}`,
        rect: mmRectFromWorld(grown, rect),
        heightMm: tables[0]?.heightMm ?? DEFAULT_TABLE_HEIGHT_MM,
      };
      return { ...grown, footprint: { ...grown.footprint, tables: [...tables, table] } };
    });
    return { planId, tableId };
  }

  placeTable(planId: string, tableId: string, rect: LduRect): void {
    this.replacePlan(planId, (plan) => {
      const grown = regionAround(plan, rect, 0);
      const placed = mmRectFromWorld(grown, rect);
      return {
        ...grown,
        footprint: {
          ...grown.footprint,
          tables: grown.footprint.tables.map((t) =>
            t.id === tableId ? { ...t, rect: placed } : t,
          ),
        },
      };
    });
  }

  private createPlanAround(rect: LduRect): string {
    const originChunkX = chunkOf(rect.minX);
    const originChunkZ = chunkOf(rect.minZ);
    return this.createPlan({
      name: `Plan ${this.state.plans.length + 1}`,
      roomWidthMm: mmFromLdu(rect.maxX - originChunkX * CHUNK_LDU),
      roomDepthMm: mmFromLdu(rect.maxZ - originChunkZ * CHUNK_LDU),
      originChunkX,
      originChunkZ,
    });
  }

  removeTable(planId: string, tableId: string): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        tables: plan.footprint.tables.filter((t) => t.id !== tableId),
      },
    }));
  }

  addObstacle(planId: string, obstacle: ObstacleInput): string {
    const id = this.newId("obstacle");
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: [...plan.footprint.obstacles, { ...obstacle, id }],
      },
    }));
    return id;
  }

  updateObstacle(planId: string, obstacleId: string, patch: Partial<ObstacleInput>): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: plan.footprint.obstacles.map((o) =>
          o.id === obstacleId ? { ...o, ...patch } : o,
        ),
      },
    }));
  }

  removeObstacle(planId: string, obstacleId: string): void {
    this.replacePlan(planId, (plan) => ({
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: plan.footprint.obstacles.filter((o) => o.id !== obstacleId),
      },
    }));
  }

  setPlacements(placements: ReadonlyArray<PlacedForPlan>): void {
    this.commit({ placements });
  }

  setTableTopY(y: number): void {
    this.commit({ tableTopY: y });
  }

  onEdit(listener: () => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  undo(): boolean {
    return this.restore(this.done, this.undone);
  }

  redo(): boolean {
    return this.restore(this.undone, this.done);
  }

  discardRedo(): void {
    this.undone.length = 0;
  }

  private restore(from: PlanState[], to: PlanState[]): boolean {
    const state = from.pop();
    if (!state) return false;
    to.push(this.planState());
    this.commit(state);
    return true;
  }

  private planState(): PlanState {
    return { plans: this.state.plans, activePlanId: this.state.activePlanId };
  }

  private commitEdit(patch: Partial<PlanSnapshot>): void {
    const before = this.planState();
    this.commit(patch);
    if (this.grouped === 0) this.recordEdit(before);
  }

  private recordEdit(before: PlanState): void {
    if (before.plans === this.state.plans && before.activePlanId === this.state.activePlanId) {
      return;
    }
    this.done.push(before);
    this.undone.length = 0;
    for (const listener of this.editListeners) listener();
  }

  private commit(patch: Partial<PlanSnapshot>): void {
    const next = { ...this.state, ...patch };
    this.state = { ...next, ...evaluate(next.plans, next.placements) };
    this.draw();
    for (const listener of this.listeners) listener();
  }

  private draw(): void {
    const { plans, checks, placements, tableTopY, activePlanId } = this.state;
    const overlays: PlanOverlay[] = plans.map((plan, i) => {
      const check = checks[i];
      const heightMm = plan.footprint.tables[0]?.heightMm ?? 0;
      const floorY = tableTopY - lduFromMm(heightMm);
      const tables = (check?.tables ?? []).map((top) => ({
        minX: top.surface.minX,
        minY: tableTopY - lduFromMm(top.heightMm),
        minZ: top.surface.minZ,
        maxX: top.surface.maxX,
        maxY: tableTopY,
        maxZ: top.surface.maxZ,
      }));
      const obstacles = (check?.obstacles ?? []).map((rect) => ({
        ...rect,
        minY: floorY,
        maxY: tableTopY,
      }));
      const room = check?.room;
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
        active: plan.id === activePlanId,
      };
    });
    this.backend.setPlanOverlays(overlays);
    const flagged = new Set(
      checks.flatMap((c) => c.issues.flatMap((issue) => issue.placements.map(placementId))),
    );
    this.backend.setIssueBoxes(
      placements.filter((p) => flagged.has(placementId(p.key))).map((p) => p.box),
    );
  }
}
