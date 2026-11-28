import type { IPlanService, PlanRegion } from "@brr/client";
import { useSyncExternalStore } from "react";

const NO_UNSUBSCRIBE = (): void => undefined;

export function usePlanVersion(plans: IPlanService | null): number {
  return useSyncExternalStore(
    (listener) => plans?.subscribe(listener) ?? NO_UNSUBSCRIBE,
    () => plans?.version() ?? 0,
  );
}

export function useActivePlan(plans: IPlanService | null): PlanRegion | null {
  usePlanVersion(plans);
  if (!plans) return null;
  const id = plans.activePlanId();
  return plans.plans().find((plan) => plan.id === id) ?? null;
}
