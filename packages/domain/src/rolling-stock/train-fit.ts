import type { SimTrack } from "../track-path/sim-track.ts";
import { advanceAlong, clearAhead, clearBehind, type TrainPath } from "./train-path.ts";

export const TRAIN_FIT_FLOATS = 3;
const FIT_EDGE = 0;
const FIT_OFFSET = 1;
const FIT_CLEAR = 2;

function standsAt(
  track: SimTrack,
  path: TrainPath,
  edge: number,
  offset: number,
  length: number,
  out: Float64Array,
): boolean {
  if (offset > (track.edgeLength[edge] ?? 0) || !path.stand(edge, offset, length)) return false;
  out[FIT_EDGE] = edge;
  out[FIT_OFFSET] = offset;
  return true;
}

export function fitTrain(
  track: SimTrack,
  path: TrainPath,
  edge: number,
  offset: number,
  length: number,
  out: Float64Array,
): boolean {
  const ahead = clearAhead(track, edge, offset, length);
  const behind = clearBehind(track, edge, offset, length);
  out[FIT_CLEAR] = ahead + behind;
  if (ahead + behind < length) return false;
  const lead = Math.min(Math.max(length / 2, length - behind), ahead);
  advanceAlong(track, edge, offset, lead, out);
  const headEdge = out[FIT_EDGE] ?? 0;
  const at = out[FIT_OFFSET] ?? 0;
  return (
    standsAt(track, path, headEdge, Math.floor(at), length, out) ||
    standsAt(track, path, headEdge, Math.ceil(at), length, out)
  );
}

export function fitEdge(out: Float64Array): number {
  return out[FIT_EDGE] ?? 0;
}

export function fitOffset(out: Float64Array): number {
  return out[FIT_OFFSET] ?? 0;
}

export function fitClear(out: Float64Array): number {
  return out[FIT_CLEAR] ?? 0;
}

export function trainsOverlap(
  a: TrainPath,
  aLength: number,
  b: TrainPath,
  bLength: number,
  routePlacement: Int32Array,
): boolean {
  const mine = a.measure(aLength);
  const theirs = b.measure(bLength);
  for (let i = 0; i < mine; i++) {
    const route = a.spanRoute(i);
    for (let j = 0; j < theirs; j++) {
      const other = b.spanRoute(j);
      if (route === other) {
        if (a.spanFrom(i) < b.spanTo(j) && b.spanFrom(j) < a.spanTo(i)) return true;
      } else if (routePlacement[route] === routePlacement[other]) {
        return true;
      }
    }
  }
  return false;
}

export function placementsUnder(
  path: TrainPath,
  length: number,
  routePlacement: Int32Array,
): ReadonlySet<number> {
  const placements = new Set<number>();
  const spans = path.measure(length);
  for (let i = 0; i < spans; i++) placements.add(routePlacement[path.spanRoute(i)] ?? -1);
  return placements;
}
