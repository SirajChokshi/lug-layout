import { lineUnits } from "./expectation.ts";
import { clearOfHeadBands, meetsHeadBand } from "./head-band-contact.ts";
import { VERTICAL } from "./part-geometry.ts";
import type { RailHeadBands } from "./placement.ts";
import type { TrainModel } from "./train-model.ts";
import type { TrainPlan } from "./train-plan.ts";
const LOWEST_TOLERANCE_LDU = 0.5;

function bandsOf(rail: RailHeadBands): ReadonlyArray<readonly [number, number]> {
  return [
    [rail.inner, rail.outer],
    [-rail.outer, -rail.inner],
  ];
}

export function soundness(
  model: TrainModel,
  plan: TrainPlan,
  rails: ReadonlyArray<RailHeadBands>,
): string[] {
  const problems: string[] = [];
  for (const [a, b] of model.collisions()) {
    problems.push(
      `instances ${a} (${model.placements[a]?.reading.reference}) and ${b} (${model.placements[b]?.reading.reference}) overlap`,
    );
  }
  for (const line of plan.wheelsets) {
    const label = `axis line at x ${line.x}, y ${line.y}`;
    if (line.negative === null) {
      if (line.rollingSurfaces.some((contact) => !meetsHeadBand(model, contact, line))) {
        problems.push(`${label}: a surface misses its head band`);
      }
      continue;
    }
    if (line.negative === "gauge miss") {
      const touches = rails.some((rail) =>
        bandsOf(rail).some(([from, to]) =>
          line.instances.some((instance) => !clearOfHeadBands(model, instance, line, from, to)),
        ),
      );
      if (touches) problems.push(`${label}: a gauge-miss wheel reaches a head band`);
    }
    if (line.negative === "one head band") {
      const reached = rails.filter((rail) =>
        bandsOf(rail).every(([from, to]) =>
          line.instances.some((instance) => !clearOfHeadBands(model, instance, line, from, to)),
        ),
      );
      if (reached.length > 0) problems.push(`${label}: a one-sided axle reaches both head bands`);
    }
    if (line.negative === "split across pivot" && lineUnits(model, line).size < 2) {
      problems.push(`${label}: a split axle sits in one sub-assembly`);
    }
  }
  const wheelInstances = new Set(plan.wheelsets.flatMap((line) => line.instances));
  if (wheelInstances.size > 0) {
    const lowest = Math.min(...model.placements.map((_, index) => model.box(index).min[VERTICAL]));
    const lowestWheel = Math.min(
      ...[...wheelInstances].map((index) => model.box(index).min[VERTICAL]),
    );
    if (lowestWheel - lowest > LOWEST_TOLERANCE_LDU)
      problems.push("a non-wheel part hangs below the wheels");
  }
  return problems;
}
