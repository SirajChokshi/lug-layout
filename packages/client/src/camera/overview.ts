import { mmRectInWorld, NO_ROW, roomRect, type LduRect } from "@brr/domain";
import type { IPlanService, PlanPlacementsView } from "../plan/plan-service.ts";

export interface OverviewView {
  readonly rooms: ReadonlyArray<LduRect>;
  readonly tables: ReadonlyArray<LduRect>;
  readonly obstacles: ReadonlyArray<LduRect>;
  readonly bounds: LduRect | null;
}

function boundsOf(view: PlanPlacementsView, rooms: ReadonlyArray<LduRect>): LduRect | null {
  let minX = Number.NaN;
  let minZ = Number.NaN;
  let maxX = Number.NaN;
  let maxZ = Number.NaN;
  let seen = false;
  const fold = (rectMinX: number, rectMinZ: number, rectMaxX: number, rectMaxZ: number): void => {
    if (!seen) {
      seen = true;
      minX = rectMinX;
      minZ = rectMinZ;
      maxX = rectMaxX;
      maxZ = rectMaxZ;
    }
    minX = Math.min(minX, rectMinX);
    minZ = Math.min(minZ, rectMinZ);
    maxX = Math.max(maxX, rectMaxX);
    maxZ = Math.max(maxZ, rectMaxZ);
  };
  for (let row = view.first(); row !== NO_ROW; row = view.next(row)) {
    fold(view.minX(row), view.minZ(row), view.maxX(row), view.maxZ(row));
  }
  for (const room of rooms) fold(room.minX, room.minZ, room.maxX, room.maxZ);
  return seen ? { minX, minZ, maxX, maxZ } : null;
}

export function overviewOf(plans: IPlanService): OverviewView {
  const regions = plans.plans();
  const view = plans.placements();
  const rooms = regions.map(roomRect);
  const tables = regions.flatMap((plan) =>
    plan.footprint.tables.map((table) => mmRectInWorld(plan, table.rect)),
  );
  const obstacles = regions.flatMap((plan) =>
    plan.footprint.obstacles.map((obstacle) => mmRectInWorld(plan, obstacle.rect)),
  );
  return { rooms, tables, obstacles, bounds: boundsOf(view, rooms) };
}
