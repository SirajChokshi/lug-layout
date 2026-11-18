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
import type { HeadBandContact } from "./train-plan.ts";
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
  surface: HeadBandContact,
  line: { readonly x: number; readonly y: number },
): boolean {
  const band = localBand(model, surface.instance, line, surface.from, surface.to);
  if (!band) return false;
  const bottom = line.y - worldBottom(model, surface.instance);
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
