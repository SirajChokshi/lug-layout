import { type Vec3 } from "../assembly.ts";
import {
  type AxisLine,
  type Sign,
  VERTICAL,
  across,
  rollingContact,
  roundProfile,
} from "./part-geometry.ts";
import {
  CONTACT_FRACTION,
  LATERAL,
  LATERAL_SEARCH_LDU,
  type RailHeadBands,
  TRAVEL,
  headBandSpan,
  pointOnLine,
  transpose,
} from "./placement.ts";
import { type TrainModel, add, apply, subtract } from "./train-model.ts";
import type { HeadBandSpan } from "./placement.ts";
import type { RollingSurfaceContact } from "./train-plan.ts";
function worldBottom(model: TrainModel, instance: number): number {
  return model.box(instance).min[VERTICAL];
}

interface LocalBand {
  readonly triangles: Float32Array;
  readonly line: AxisLine;
  readonly from: number;
  readonly to: number;
  readonly outward: Sign;
  readonly down: Vec3;
}

function localBand(
  model: TrainModel,
  instance: number,
  line: { readonly x: number; readonly y: number },
  from: number,
  to: number,
): LocalBand | null {
  const placement = model.placements[instance];
  if (!placement) return null;
  const inverse = transpose(placement.rotation);
  const localPoint = apply(inverse, subtract([line.x, line.y, 0], placement.position));
  const localDirection = apply(inverse, [0, 0, 1]);
  const axis = ([0, 1, 2] as const).find((candidate) => Math.abs(localDirection[candidate]) === 1);
  if (axis === undefined) return null;
  const sign = localDirection[axis] > 0 ? 1 : -1;
  const [p, q] = across(axis);
  const a = localPoint[axis] + sign * from;
  const b = localPoint[axis] + sign * to;
  const outwardWorld: Sign = from + to > 0 ? 1 : -1;
  return {
    triangles: placement.reading.triangles,
    line: { axis, at: [localPoint[p], localPoint[q]] },
    from: Math.min(a, b),
    to: Math.max(a, b),
    outward: (outwardWorld * sign) as Sign,
    down: apply(inverse, [0, -1, 0]),
  };
}

export function meetsHeadBand(
  model: TrainModel,
  contact: RollingSurfaceContact,
  line: { readonly x: number; readonly y: number },
): boolean {
  const band = localBand(model, contact.instance, line, contact.headBand.from, contact.headBand.to);
  if (!band) return false;
  const bottom = line.y - worldBottom(model, contact.instance);
  return (
    rollingContact(
      band.triangles,
      band.line,
      band.from,
      band.to,
      band.outward,
      band.down,
      CONTACT_FRACTION * bottom,
    ) !== null
  );
}

export function clearOfHeadBands(
  model: TrainModel,
  instance: number,
  line: { readonly x: number; readonly y: number },
  from: number,
  to: number,
): boolean {
  const band = localBand(model, instance, line, from, to);
  return band === null || roundProfile(band.triangles, band.line, band.from, band.to).radius === 0;
}

export function smoothRuns(
  model: TrainModel,
  instance: number,
  line: { readonly x: number; readonly y: number },
  from: number,
  to: number,
): ReadonlyArray<HeadBandSpan> {
  const runs: HeadBandSpan[] = [];
  for (let slab = Math.floor(from); slab < Math.ceil(to); slab++) {
    const band = localBand(model, instance, line, slab, slab + 1);
    if (!band) continue;
    const rim = roundProfile(band.triangles, band.line, band.from, band.to, band.down);
    if (!rim.smooth || rim.radius === 0) continue;
    const last = runs.at(-1);
    if (last && last.to === slab) runs[runs.length - 1] = { from: last.from, to: slab + 1 };
    else runs.push({ from: slab, to: slab + 1 });
  }
  return runs;
}

const ON_LINE_LDU = 1e-6;

interface LateralSurface {
  readonly instance: number;
  readonly low: number;
  readonly high: number;
  readonly lowRadius: number;
  readonly highRadius: number;
}

export interface HeadBandReading {
  readonly members: ReadonlyArray<number>;
  readonly centre: number;
  readonly contactRadii: readonly [number, number];
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
      const [radiusA, radiusB] = [surface.radii[0] / step, surface.radii[1] / step];
      return [
        a <= b
          ? { instance, low: a, high: b, lowRadius: radiusA, highRadius: radiusB }
          : { instance, low: b, high: a, lowRadius: radiusB, highRadius: radiusA },
      ];
    });
  });
}

function overlapsBand(surface: LateralSurface, band: HeadBandSpan, centre: number): boolean {
  return Math.max(surface.low, centre + band.from) < Math.min(surface.high, centre + band.to);
}

function radiusAt(surface: LateralSurface, at: number): number {
  if (surface.high === surface.low) return surface.lowRadius;
  const t = (at - surface.low) / (surface.high - surface.low);
  return surface.lowRadius + t * (surface.highRadius - surface.lowRadius);
}

function bandRadius(
  surfaces: ReadonlyArray<LateralSurface>,
  band: HeadBandSpan,
  centre: number,
): number {
  return Math.max(
    ...surfaces.map((surface) => {
      const low = Math.max(surface.low, centre + band.from);
      const high = Math.min(surface.high, centre + band.to);
      return Math.max(radiusAt(surface, low), radiusAt(surface, high));
    }),
  );
}

function nearestToMiddle(feasible: ReadonlyArray<number>): number | null {
  const first = feasible[0];
  const last = feasible.at(-1);
  if (first === undefined || last === undefined) return null;
  const twiceMiddle = first + last;
  return feasible.reduce((best, centre) =>
    Math.abs(2 * centre - twiceMiddle) < Math.abs(2 * best - twiceMiddle) ? centre : best,
  );
}

export function headBandReading(
  model: TrainModel,
  line: { readonly x: number; readonly y: number },
  rail: RailHeadBands,
): HeadBandReading | null {
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
  const centre = nearestToMiddle(feasible);
  if (centre === null) return null;
  const members = surfaces.filter((surface) =>
    feasible.some((each) => nearOnly(surface, each) || farOnly(surface, each)),
  );
  return {
    members: [...new Set(members.map((surface) => surface.instance))].toSorted((a, b) => a - b),
    centre,
    contactRadii: [
      bandRadius(
        members.filter((surface) => nearOnly(surface, centre)),
        near,
        centre,
      ),
      bandRadius(
        members.filter((surface) => farOnly(surface, centre)),
        far,
        centre,
      ),
    ],
  };
}
