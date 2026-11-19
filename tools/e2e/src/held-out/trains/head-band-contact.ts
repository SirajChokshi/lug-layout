import { type Vec3 } from "../assembly.ts";
import {
  type AxisLine,
  type Sign,
  VERTICAL,
  across,
  rollingContact,
  roundProfile,
} from "./part-geometry.ts";
import { CONTACT_FRACTION, transpose } from "./placement.ts";
import { type TrainModel, apply, subtract } from "./train-model.ts";
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
    const rim = roundProfile(band.triangles, band.line, band.from, band.to);
    if (!rim.smooth || rim.radius === 0) continue;
    const last = runs.at(-1);
    if (last && last.to === slab) runs[runs.length - 1] = { from: last.from, to: slab + 1 };
    else runs.push({ from: slab, to: slab + 1 });
  }
  return runs;
}
