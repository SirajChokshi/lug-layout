import type { Vec3 } from "../assembly.ts";
import { SeededRandom } from "../generator.ts";
import { VERTICAL } from "./part-geometry.ts";
import {
  PIVOT_PART_SUFFIX,
  surfaceAbsent,
  surfaceContact,
  type RailBands,
  type Surface,
  type WheelLine,
} from "./train-builder.ts";
import { TrainModel } from "./train-model.ts";
import type { TrainPools } from "./train-pools.ts";
import { LINK_RECIPES } from "./train-links.ts";
import { CAR_RECIPES, type EndPlan, type TrainPlan } from "./train-recipes.ts";

export interface AxisLineExpectation {
  readonly point: Vec3;
  readonly direction: Vec3;
}

export interface WheelsetExpectation {
  readonly axisLine: AxisLineExpectation;
  readonly rail: string;
  readonly instances: ReadonlyArray<number>;
  readonly surfaces: ReadonlyArray<Surface>;
}

export type Guide =
  | { readonly kind: "bogiePivot"; readonly bogie: number; readonly x: number }
  | { readonly kind: "fixedAxle"; readonly wheelset: number; readonly x: number };

export interface EndExpectation {
  readonly candidates: ReadonlyArray<{ readonly instance: number; readonly tip: Vec3 }>;
  readonly notCandidates: ReadonlyArray<{
    readonly instance: number;
    readonly at: Vec3;
    readonly reason: string;
  }>;
}

export interface VehicleExpectation {
  readonly body: ReadonlyArray<number>;
  readonly bogies: ReadonlyArray<{
    readonly instances: ReadonlyArray<number>;
    readonly pivot: { readonly x: number; readonly z: number };
    readonly wheelsets: ReadonlyArray<number>;
  }>;
  readonly fixedAxles: ReadonlyArray<number>;
  readonly guides: readonly [Guide, Guide];
  readonly ends: { readonly front: EndExpectation | null; readonly rear: EndExpectation | null };
}

export interface TrainExpectation {
  readonly frame: string;
  readonly instances: ReadonlyArray<{ readonly reference: string; readonly unit: string }>;
  readonly wheelsets: ReadonlyArray<WheelsetExpectation>;
  readonly notWheelsets: ReadonlyArray<{
    readonly axisLine: AxisLineExpectation;
    readonly instances: ReadonlyArray<number>;
    readonly reason: string;
  }>;
  readonly vehicles: ReadonlyArray<VehicleExpectation>;
  readonly attachments: ReadonlyArray<{ readonly instances: ReadonlyArray<number> }>;
  readonly couplingsInModel: ReadonlyArray<{
    readonly vehicles: readonly [number, number];
    readonly via: ReadonlyArray<number>;
    readonly pivots: ReadonlyArray<{ readonly x: number; readonly z: number }>;
  }>;
  readonly unresolvedRunningGear: ReadonlyArray<{
    readonly instances: ReadonlyArray<number>;
    readonly wheelsets: ReadonlyArray<number>;
    readonly reason: string;
  }>;
  readonly pivotParts: ReadonlyArray<{ readonly instances: ReadonlyArray<number> }>;
}

export interface GeneratedTrain {
  readonly name: string;
  readonly kind: string;
  readonly text: string;
  readonly model: TrainModel;
  readonly expected: TrainExpectation;
  readonly problems: ReadonlyArray<string>;
}

export interface TrainGeneration {
  readonly trains: ReadonlyArray<GeneratedTrain>;
  readonly notBuilt: ReadonlyArray<string>;
}

const ATTEMPTS = 30;
const FRAME =
  "y-up LDU in the generated file's model space (LDraw x, -y, -z); instance i is the file's i-th part line; axis lines run along +z; pivot parts are contracted out of the partition and credited to no asserted sub-assembly";
const LATERAL_DIRECTION: Vec3 = [0, 0, 1];
const LOWEST_TOLERANCE_LDU = 0.5;

function instancesOf(model: TrainModel, units: ReadonlyArray<string>): number[] {
  return model.placements.flatMap((placement, index) =>
    units.includes(placement.unit) ? [index] : [],
  );
}

function endExpectation(plan: EndPlan): EndExpectation | null {
  if (plan === "unasserted") return null;
  if (plan === "plain") return { candidates: [], notCandidates: [] };
  return { candidates: plan.candidates, notCandidates: plan.notCandidates };
}

function axisLine(line: WheelLine): AxisLineExpectation {
  return { point: [line.x, line.y, 0], direction: LATERAL_DIRECTION };
}

function lineUnits(model: TrainModel, line: WheelLine): ReadonlySet<string> {
  const instances =
    line.surfaces.length > 0 ? line.surfaces.map((surface) => surface.instance) : line.instances;
  return new Set(instances.map((index) => model.placements[index]?.unit ?? ""));
}

export function expectationOf(model: TrainModel, plan: TrainPlan): TrainExpectation | null {
  const positives = plan.lines.filter(
    (line) => line.negative === null && line.rail !== null && line.surfaces.length > 0,
  );
  const wheelsets = positives.map((line) => ({
    axisLine: axisLine(line),
    rail: line.rail ?? "",
    instances: [...new Set(line.surfaces.map((surface) => surface.instance))],
    surfaces: line.surfaces,
  }));
  const unitOfWheelset = positives.map((line) => [...lineUnits(model, line)][0] ?? "");
  const vehicles = plan.vehicles.map((vehicle): VehicleExpectation | null => {
    const fixedAxles = unitOfWheelset.flatMap((unit, index) =>
      vehicle.body.includes(unit) ? [index] : [],
    );
    const bogies = vehicle.bogies.map((bogie) => ({
      instances: instancesOf(model, [bogie.unit]),
      pivot: { x: bogie.pivot[0], z: bogie.pivot[1] },
      wheelsets: unitOfWheelset.flatMap((unit, index) => (unit === bogie.unit ? [index] : [])),
    }));
    const guides: Guide[] = [
      ...bogies.map((bogie, index): Guide => ({
        kind: "bogiePivot",
        bogie: index,
        x: bogie.pivot.x,
      })),
      ...fixedAxles.map((wheelset): Guide => ({
        kind: "fixedAxle",
        wheelset,
        x: positives[wheelset]?.x ?? 0,
      })),
    ].toSorted((a, b) => b.x - a.x);
    const front = guides[0];
    const rear = guides.at(-1);
    if (!front || !rear || front === rear) return null;
    return {
      body: instancesOf(model, vehicle.body),
      bogies,
      fixedAxles,
      guides: [front, rear],
      ends: { front: endExpectation(vehicle.front), rear: endExpectation(vehicle.rear) },
    };
  });
  if (vehicles.some((vehicle) => vehicle === null)) return null;
  return {
    frame: FRAME,
    instances: model.placements.map((placement) => ({
      reference: placement.reading.reference,
      unit: placement.unit,
    })),
    wheelsets,
    notWheelsets: plan.lines.flatMap((line) =>
      line.negative === null
        ? []
        : [{ axisLine: axisLine(line), instances: line.instances, reason: line.negative }],
    ),
    vehicles: vehicles.flatMap((vehicle) => (vehicle ? [vehicle] : [])),
    attachments: plan.attachments.map((unit) => ({ instances: instancesOf(model, [unit]) })),
    couplingsInModel: plan.couplings.map((coupling) => ({
      vehicles: coupling.vehicles,
      via: instancesOf(model, coupling.via),
      pivots: coupling.pivots.map(([x, z]) => ({ x, z })),
    })),
    pivotParts: [...new Set(model.placements.map((placement) => placement.unit))]
      .filter((unit) => unit.endsWith(PIVOT_PART_SUFFIX))
      .map((unit) => ({ instances: instancesOf(model, [unit]) })),
    unresolvedRunningGear: plan.unresolved.map((group) => ({
      instances: instancesOf(model, group.units),
      wheelsets: unitOfWheelset.flatMap((unit, index) =>
        group.units.includes(unit) ? [index] : [],
      ),
      reason: group.reason,
    })),
  };
}

function bandsOf(rail: RailBands): ReadonlyArray<readonly [number, number]> {
  return [
    [rail.inner, rail.outer],
    [-rail.outer, -rail.inner],
  ];
}

export function soundness(
  model: TrainModel,
  plan: TrainPlan,
  rails: ReadonlyArray<RailBands>,
): string[] {
  const problems: string[] = [];
  for (const [a, b] of model.collisions()) {
    problems.push(
      `instances ${a} (${model.placements[a]?.reading.reference}) and ${b} (${model.placements[b]?.reading.reference}) overlap`,
    );
  }
  for (const line of plan.lines) {
    const label = `axis line at x ${line.x}, y ${line.y}`;
    if (line.negative === null) {
      if (line.surfaces.some((surface) => !surfaceContact(model, surface, line))) {
        problems.push(`${label}: a surface misses its head band`);
      }
      continue;
    }
    if (line.negative === "gauge miss") {
      const touches = rails.some((rail) =>
        bandsOf(rail).some(([from, to]) =>
          line.instances.some((instance) => !surfaceAbsent(model, instance, line, from, to)),
        ),
      );
      if (touches) problems.push(`${label}: a gauge-miss wheel reaches a head band`);
    }
    if (line.negative === "one head band") {
      const reached = rails.filter((rail) =>
        bandsOf(rail).every(([from, to]) =>
          line.instances.some((instance) => !surfaceAbsent(model, instance, line, from, to)),
        ),
      );
      if (reached.length > 0) problems.push(`${label}: a one-sided axle reaches both head bands`);
    }
    if (line.negative === "split across pivot" && lineUnits(model, line).size < 2) {
      problems.push(`${label}: a split axle sits in one sub-assembly`);
    }
  }
  const wheelInstances = new Set(plan.lines.flatMap((line) => line.instances));
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

export function generateTrains(
  pools: TrainPools,
  rails: ReadonlyArray<RailBands>,
  seed: number,
  perKind: number,
): TrainGeneration {
  const random = new SeededRandom(seed);
  const seats = new Map<string, number>();
  const trains: GeneratedTrain[] = [];
  const notBuilt: string[] = [];
  for (const [kind, recipe] of [...CAR_RECIPES, ...LINK_RECIPES]) {
    for (let k = 0; k < perKind; k++) {
      let built: GeneratedTrain | null = null;
      for (let attempt = 0; attempt < ATTEMPTS && !built; attempt++) {
        const model = new TrainModel();
        const rail = rails[random.int(rails.length)];
        if (!rail) break;
        const plan = recipe({ model, pools, random, rails, rail, seats });
        if (!plan) continue;
        const expected = expectationOf(model, plan);
        if (!expected) continue;
        const name = `held-out-train-${seed}-${trains.length + 1}.ldr`;
        built = {
          name,
          kind,
          text: model.ldraw(name, `Held-out generated train: ${kind} (seed ${seed})`),
          model,
          expected,
          problems: soundness(model, plan, rails),
        };
      }
      if (built) trains.push(built);
      else notBuilt.push(kind);
    }
  }
  return { trains, notBuilt };
}
