import { type Vec3 } from "../assembly.ts";
import { smoothRuns } from "./head-band-contact.ts";
import { VERTICAL } from "./part-geometry.ts";
import {
  LATERAL,
  LATERAL_SEARCH_LDU,
  PIVOT_PART_SUFFIX,
  TRAVEL,
  headBandSpan,
  type HeadBandSpan,
  type RailHeadBands,
  pointOnLine,
} from "./placement.ts";
import { type TrainModel, add, apply } from "./train-model.ts";
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

const SIXTEENTHS_PER_LDU = 16;
const ON_LINE_LDU = 1e-6;
const SPANS_PIVOT = "a wheelset spanning a vertical pivot";

interface LateralSurface {
  readonly instance: number;
  readonly low: number;
  readonly high: number;
}

function surfacesOnLine(
  model: TrainModel,
  line: { readonly x: number; readonly y: number },
): ReadonlyArray<LateralSurface> {
  return model.placements.flatMap((placement, instance) => {
    const rolling = placement.reading.rolling;
    if (!rolling) return [];
    const step = rolling.stepsPerLdu;
    return rolling.surfaces.flatMap((surface) => {
      const direction = apply(placement.rotation, pointOnLine(surface.axis, [0, 0], 1));
      const sign = direction[LATERAL];
      if (Math.abs(sign) !== 1) return [];
      const at = add(
        placement.position,
        apply(
          placement.rotation,
          pointOnLine(surface.axis, [surface.at[0] / step, surface.at[1] / step], 0),
        ),
      );
      if (
        Math.abs(at[TRAVEL] - line.x) > ON_LINE_LDU ||
        Math.abs(at[VERTICAL] - line.y) > ON_LINE_LDU
      ) {
        return [];
      }
      const a = at[LATERAL] + (sign * surface.from) / step;
      const b = at[LATERAL] + (sign * surface.to) / step;
      return [{ instance, low: Math.min(a, b), high: Math.max(a, b) }];
    });
  });
}

function overlapsBand(surface: LateralSurface, band: HeadBandSpan, centre: number): boolean {
  return Math.max(surface.low, centre + band.from) < Math.min(surface.high, centre + band.to);
}

function headBandMembers(
  model: TrainModel,
  line: { readonly x: number; readonly y: number },
  rail: RailHeadBands,
): ReadonlyArray<number> {
  const surfaces = surfacesOnLine(model, line);
  const near = headBandSpan(rail, 1);
  const far = headBandSpan(rail, -1);
  const nearOnly = (surface: LateralSurface, centre: number): boolean =>
    overlapsBand(surface, near, centre) && !overlapsBand(surface, far, centre);
  const farOnly = (surface: LateralSurface, centre: number): boolean =>
    overlapsBand(surface, far, centre) && !overlapsBand(surface, near, centre);
  const feasible: number[] = [];
  for (let centre = -LATERAL_SEARCH_LDU; centre <= LATERAL_SEARCH_LDU; centre++) {
    if (
      surfaces.some((surface) => nearOnly(surface, centre)) &&
      surfaces.some((surface) => farOnly(surface, centre))
    ) {
      feasible.push(centre);
    }
  }
  const members = surfaces.filter((surface) =>
    feasible.some((centre) => nearOnly(surface, centre) || farOnly(surface, centre)),
  );
  return [...new Set(members.map((surface) => surface.instance))].toSorted((a, b) => a - b);
}
const RUN_SEARCH_LDU = 80;

function overlapsAt(run: HeadBandSpan, band: HeadBandSpan, centre: number): boolean {
  return run.from < centre + band.to && run.to > centre + band.from;
}

function firstRailMet(
  model: TrainModel,
  rails: ReadonlyArray<RailHeadBands>,
  line: PlannedWheelset,
): string | null {
  const runs = [...new Set(line.rollingSurfaces.map((contact) => contact.instance))].flatMap(
    (instance) => smoothRuns(model, instance, line, -RUN_SEARCH_LDU, RUN_SEARCH_LDU),
  );
  for (const rail of rails) {
    const near = headBandSpan(rail, -1);
    const far = headBandSpan(rail, 1);
    for (
      let k = -RUN_SEARCH_LDU * SIXTEENTHS_PER_LDU;
      k <= RUN_SEARCH_LDU * SIXTEENTHS_PER_LDU;
      k++
    ) {
      const centre = k / SIXTEENTHS_PER_LDU;
      if (
        runs.some((run) => overlapsAt(run, near, centre)) &&
        runs.some((run) => overlapsAt(run, far, centre))
      ) {
        return rail.part;
      }
    }
  }
  return null;
}

export function expectationOf(
  model: TrainModel,
  plan: TrainPlan,
  rails: ReadonlyArray<RailHeadBands>,
): TrainExpectation | null {
  const positives = plan.wheelsets.filter(
    (line) => line.negative === null && line.rail !== null && line.rollingSurfaces.length > 0,
  );
  const railsMet = positives.map((line) => firstRailMet(model, rails, line));
  if (railsMet.some((rail) => rail === null)) return null;
  const wheelsets = positives.map((line, index) => {
    const rail = rails.find((candidate) => candidate.part === railsMet[index]);
    const members = rail ? headBandMembers(model, line, rail) : [];
    return {
      axisLine: axisLine(line),
      rail: railsMet[index] ?? "",
      instances:
        members.length > 0
          ? members
          : [...new Set(line.rollingSurfaces.map((contact) => contact.instance))],
      rollingSurfaces: line.rollingSurfaces,
    };
  });
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
    unresolvedRunningGear: [
      ...plan.unresolvedRunningGear.map((group) => ({
        instances: instancesOf(model, group.units),
        wheelsets: unitOfWheelset.flatMap((unit, index) =>
          group.units.includes(unit) ? [index] : [],
        ),
        reason: group.reason,
      })),
      ...plan.wheelsets
        .filter((line) => line.negative === "split across pivot")
        .map((line) => ({
          instances: instancesOf(model, [...lineUnits(model, line)]),
          wheelsets: [],
          reason: SPANS_PIVOT,
        })),
    ],
  };
}
