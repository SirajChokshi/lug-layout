import { NO_ROW } from "@brr/domain";
import type { WorldBox } from "@brr/render";
import type { PlanPlacementsView } from "./plan-service.ts";

export function placementsBox(view: PlanPlacementsView): WorldBox | null {
  const first = view.first();
  if (first === NO_ROW) return null;
  let minX = view.minX(first);
  let minY = view.minY(first);
  let minZ = view.minZ(first);
  let maxX = view.maxX(first);
  let maxY = view.maxY(first);
  let maxZ = view.maxZ(first);
  for (let row = first; row !== NO_ROW; row = view.next(row)) {
    minX = Math.min(minX, view.minX(row));
    minY = Math.min(minY, view.minY(row));
    minZ = Math.min(minZ, view.minZ(row));
    maxX = Math.max(maxX, view.maxX(row));
    maxY = Math.max(maxY, view.maxY(row));
    maxZ = Math.max(maxZ, view.maxZ(row));
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
