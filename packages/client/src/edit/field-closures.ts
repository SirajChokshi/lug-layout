import { solveClosure, type ClosureResult, type DrawingKit, type KitOutlines } from "@brr/domain";
import type { Pose16 } from "@brr/math";
import type { DragField } from "./track-drag.ts";

export const CLOSURE_BUDGET_MS = 30;

class BudgetClock {
  private started = Number.NaN;
  overran = false;

  constructor(private readonly clock: () => number) {}

  readonly now = (): number => {
    const at = this.clock();
    if (Number.isNaN(this.started)) this.started = at;
    else if (at - this.started > CLOSURE_BUDGET_MS) this.overran = true;
    return at;
  };
}

function poseKey(pose: Pose16): string {
  return `${pose.heading}:${pose.position.join(",")}`;
}

export class FieldClosures {
  private readonly byField = new WeakMap<DragField, Map<string, ClosureResult>>();

  constructor(
    private readonly kit: DrawingKit,
    private readonly outlines: KitOutlines,
    private readonly now: () => number,
  ) {}

  closeWhole(
    start: Pose16,
    goal: Pose16,
    field: DragField,
    startOwner: number,
    goalOwner: number,
  ): ClosureResult {
    const key = `${poseKey(start)}>${poseKey(goal)}>${startOwner}>${goalOwner}`;
    const known = this.byField.get(field);
    const cached = known?.get(key);
    if (cached) return cached;
    const clock = new BudgetClock(this.now);
    const result = solveClosure(
      this.kit,
      start,
      goal,
      { now: clock.now, limitMs: CLOSURE_BUDGET_MS },
      {
        clearance: field.clearance,
        support: field.support,
        outlines: this.outlines,
        startOwner,
        goalOwner,
      },
    );
    if (clock.overran) return result;
    if (known) known.set(key, result);
    else this.byField.set(field, new Map([[key, result]]));
    return result;
  }
}
