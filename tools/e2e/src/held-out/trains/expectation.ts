import { type Vec3 } from "../assembly.ts";
import { PIVOT_PART_SUFFIX } from "./placement.ts";
import type { TrainModel } from "./train-model.ts";
import type { EndPlan, PlannedWheelset, RollingSurfaceContact, TrainPlan } from "./train-plan.ts";
const FRAME =
  "y-up LDU in the generated file's model space (LDraw x, -y, -z); instance i is the file's i-th part line; axis lines run along +z; pivot parts are contracted out of the partition and credited to no asserted sub-assembly";
const LATERAL_DIRECTION: Vec3 = [0, 0, 1];

export interface AxisLineExpectation {
  readonly point: Vec3;
  readonly direction: Vec3;
}

export interface WheelsetExpectation {
  readonly axisLine: AxisLineExpectation;
  readonly rail: string;
  readonly instances: ReadonlyArray<number>;
  readonly rollingSurfaces: ReadonlyArray<RollingSurfaceContact>;
}

export type Guide =
  | { readonly kind: "bogiePivot"; readonly bogie: number; readonly x: number }
  | { readonly kind: "fixedAxle"; readonly wheelset: number; readonly x: number };

export interface EndExpectation {
  readonly candidates: ReadonlyArray<{ readonly instance: number; readonly tip: Vec3 }>;
  readonly nonCandidates: ReadonlyArray<{
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

function instancesOf(model: TrainModel, units: ReadonlyArray<string>): number[] {
  return model.placements.flatMap((placement, index) =>
    units.includes(placement.unit) ? [index] : [],
  );
}

function endExpectation(plan: EndPlan): EndExpectation | null {
  if (plan === "unasserted") return null;
  if (plan === "plain") return { candidates: [], nonCandidates: [] };
  return { candidates: plan.candidates, nonCandidates: plan.nonCandidates };
}

function axisLine(line: PlannedWheelset): AxisLineExpectation {
  return { point: [line.x, line.y, 0], direction: LATERAL_DIRECTION };
}

export function lineUnits(model: TrainModel, line: PlannedWheelset): ReadonlySet<string> {
  const instances =
    line.rollingSurfaces.length > 0
      ? line.rollingSurfaces.map((contact) => contact.instance)
      : line.instances;
  return new Set(instances.map((index) => model.placements[index]?.unit ?? ""));
}

export function expectationOf(model: TrainModel, plan: TrainPlan): TrainExpectation | null {
  const positives = plan.wheelsets.filter(
    (line) => line.negative === null && line.rail !== null && line.rollingSurfaces.length > 0,
  );
  const wheelsets = positives.map((line) => ({
    axisLine: axisLine(line),
    rail: line.rail ?? "",
    instances: [...new Set(line.rollingSurfaces.map((contact) => contact.instance))],
    rollingSurfaces: line.rollingSurfaces,
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
    notWheelsets: plan.wheelsets.flatMap((line) =>
      line.negative === null
        ? []
        : [{ axisLine: axisLine(line), instances: line.instances, reason: line.negative }],
    ),
    vehicles: vehicles.flatMap((vehicle) => (vehicle ? [vehicle] : [])),
    attachments: plan.attachments.map((unit) => ({ instances: instancesOf(model, [unit]) })),
    couplingsInModel: plan.couplingsInModel.map((coupling) => ({
      vehicles: coupling.vehicles,
      via: instancesOf(model, coupling.via),
      pivots: coupling.pivots.map(([x, z]) => ({ x, z })),
    })),
    pivotParts: [...new Set(model.placements.map((placement) => placement.unit))]
      .filter((unit) => unit.endsWith(PIVOT_PART_SUFFIX))
      .map((unit) => ({ instances: instancesOf(model, [unit]) })),
    unresolvedRunningGear: plan.unresolvedRunningGear.map((group) => ({
      instances: instancesOf(model, group.units),
      wheelsets: unitOfWheelset.flatMap((unit, index) =>
        group.units.includes(unit) ? [index] : [],
      ),
      reason: group.reason,
    })),
  };
}
