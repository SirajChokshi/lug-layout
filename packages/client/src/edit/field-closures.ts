import {
  CLOSURE_BUDGET,
  solveClosure,
  type ClosureResult,
  type DrawingKit,
  type KitOutlines,
} from "@brr/domain";
import type { Pose16 } from "@brr/math";
import type { DragField, WholeClosureOf } from "./track-drag.ts";

function poseKey(pose: Pose16): string {
  return `${pose.heading}:${pose.position.join(",")}`;
}

export class FieldClosures {
  private readonly byField = new WeakMap<DragField, Map<string, ClosureResult>>();

  constructor(
    private readonly kit: DrawingKit,
    private readonly outlines: KitOutlines,
  ) {}

  readonly closeWhole: WholeClosureOf = (start, goal, field, startOwner, goalOwner) => {
    const key = `${poseKey(start)}>${poseKey(goal)}>${startOwner}>${goalOwner}`;
    const solved = this.byField.get(field);
    const known = solved?.get(key);
    if (known) return known;
    const result = this.solve(start, goal, field, startOwner, goalOwner);
    if (solved) solved.set(key, result);
    else this.byField.set(field, new Map([[key, result]]));
    return result;
  };

  private solve(
    start: Pose16,
    goal: Pose16,
    field: DragField,
    startOwner: number,
    goalOwner: number,
  ): ClosureResult {
    return solveClosure(this.kit, start, goal, CLOSURE_BUDGET, {
      clearance: field.clearance,
      support: field.support,
      outlines: this.outlines,
      startOwner,
      goalOwner,
    });
  }
}
