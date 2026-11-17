import { mmRectInWorld, roomRect, type LduRect } from "@brr/domain";
import type { PlanSnapshot } from "../plan/plan-service.ts";

export interface OverviewItem {
  readonly ref: string;
  readonly rect: LduRect;
}

export interface OverviewView {
  readonly items: ReadonlyArray<OverviewItem>;
  readonly rooms: ReadonlyArray<LduRect>;
  readonly tables: ReadonlyArray<LduRect>;
  readonly obstacles: ReadonlyArray<LduRect>;
  readonly bounds: LduRect | null;
}

function unionOf(rects: ReadonlyArray<LduRect>): LduRect | null {
  const first = rects[0];
  if (!first) return null;
  let { minX, minZ, maxX, maxZ } = first;
  for (const rect of rects) {
    minX = Math.min(minX, rect.minX);
    minZ = Math.min(minZ, rect.minZ);
    maxX = Math.max(maxX, rect.maxX);
    maxZ = Math.max(maxZ, rect.maxZ);
  }
  return { minX, minZ, maxX, maxZ };
}

export function overviewOf(snapshot: PlanSnapshot): OverviewView {
  const items = snapshot.placements.map((placement) => ({
    ref: placement.ref,
    rect: {
      minX: placement.box.minX,
      minZ: placement.box.minZ,
      maxX: placement.box.maxX,
      maxZ: placement.box.maxZ,
    },
  }));
  const rooms = snapshot.plans.map(roomRect);
  const tables = snapshot.plans.flatMap((plan) =>
    plan.footprint.tables.map((table) => mmRectInWorld(plan, table.rect)),
  );
  const obstacles = snapshot.plans.flatMap((plan) =>
    plan.footprint.obstacles.map((obstacle) => mmRectInWorld(plan, obstacle.rect)),
  );
  return {
    items,
    rooms,
    tables,
    obstacles,
    bounds: unionOf([...items.map((item) => item.rect), ...rooms]),
  };
}
