import type { SimTrack } from "../track-path/sim-track.ts";
import { advanceAlong, clearAhead, clearBehind, type TrainPath } from "./train-path.ts";

export type TrainFit =
  | { readonly kind: "fits"; readonly edge: number; readonly offsetLdu: number }
  | { readonly kind: "short"; readonly clearLdu: number };

const HEAD_FLOATS = 2;

export function fitTrain(
  track: SimTrack,
  path: TrainPath,
  edge: number,
  offset: number,
  length: number,
): TrainFit {
  const ahead = clearAhead(track, edge, offset, length);
  const behind = clearBehind(track, edge, offset, length);
  if (ahead + behind < length) return { kind: "short", clearLdu: ahead + behind };
  const lead = Math.min(Math.max(length / 2, length - behind), ahead);
  const head = new Float64Array(HEAD_FLOATS);
  advanceAlong(track, edge, offset, lead, head);
  const headEdge = head[0] ?? 0;
  const at = head[1] ?? 0;
  const headLength = track.edgeLength[headEdge] ?? 0;
  for (const candidate of [Math.floor(at), Math.ceil(at)]) {
    if (candidate > headLength) continue;
    if (path.stand(headEdge, candidate, length)) {
      return { kind: "fits", edge: headEdge, offsetLdu: candidate };
    }
  }
  return { kind: "short", clearLdu: ahead + behind };
}

interface Span {
  readonly route: number;
  readonly from: number;
  readonly to: number;
}

function spansOf(path: TrainPath, length: number): Span[] {
  const spans: Span[] = [];
  path.span(length, (route, from, to) => spans.push({ route, from, to }));
  return spans;
}

export function trainsOverlap(
  a: TrainPath,
  aLength: number,
  b: TrainPath,
  bLength: number,
  routePlacement: Int32Array,
): boolean {
  const theirs = spansOf(b, bLength);
  for (const mine of spansOf(a, aLength)) {
    for (const other of theirs) {
      if (mine.route === other.route) {
        if (mine.from < other.to && other.from < mine.to) return true;
      } else if (routePlacement[mine.route] === routePlacement[other.route]) {
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
  path.span(length, (route) => placements.add(routePlacement[route] ?? -1));
  return placements;
}
