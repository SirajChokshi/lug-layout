import type { IPlanService } from "@brr/client";
import { useSyncExternalStore } from "react";

export function usePlanVersion(plans: IPlanService): number {
  return useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.version(),
  );
}
