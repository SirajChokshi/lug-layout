import type { IPlanService } from "@brr/client";
import { useSyncExternalStore } from "react";

const NO_UNSUBSCRIBE = (): void => undefined;

export function usePlanVersion(plans: IPlanService | null): number {
  return useSyncExternalStore(
    (listener) => plans?.subscribe(listener) ?? NO_UNSUBSCRIBE,
    () => plans?.version() ?? 0,
  );
}
