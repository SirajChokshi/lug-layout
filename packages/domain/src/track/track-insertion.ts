import {
  HALF_TURN_16,
  STUD_LDU,
  attachPose16,
  composePose16,
  planeHypot,
  pose16,
  pose16Equals,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import type { TrackArrangement } from "./track-arrangement.ts";
import { NO_END, type TrackGraph } from "./track-graph.ts";
import type { TrackLayout } from "./track-layout.ts";

export interface TrackInsertion {
  readonly placement: Pose16;
  readonly yPlates: number;
  readonly replaces: ReadonlySet<number>;
  readonly joins: number;
}

interface RunLink {
  readonly placement: number;
  readonly entry: number;
  readonly exit: number;
}

const RUN_REACH = 16;
const RUN_PIECE_ENDS = 2;
const SPAN_CHECK_LDU = 1;

export function trackInsertions(
  graph: TrackGraph,
  layout: TrackLayout,
  liftable: number,
  through: number,
  arrangement: TrackArrangement,
): ReadonlyArray<TrackInsertion> {
  const links = runThrough(graph, layout, liftable, through);
  const at = links.findIndex((link) => link.placement === through);
  if (at < 0) return [];
  const connectors = arrangement.ends;
  const spans = endSpans(connectors);
  const [only, second] = arrangement.pieces;
  const yPlates = layout.yPlates(through);
  const found: TrackInsertion[] = [];
  for (let first = 0; first <= at; first++) {
    const entry = links[first]?.entry ?? NO_END;
    const outward = endPose(graph, layout, entry);
    const mate = pose16(outward.position, outward.heading + HALF_TURN_16);
    for (let held = 0; held < connectors.length; held++) {
      const local = connectors[held];
      if (!local) continue;
      const placement = attachPose16(local, mate);
      for (let last = at; last < links.length; last++) {
        const exit = links[last]?.exit ?? NO_END;
        const span = planeHypot(
          (graph.endXLdu[exit] ?? 0) - (graph.endXLdu[entry] ?? 0),
          (graph.endZLdu[exit] ?? 0) - (graph.endZLdu[entry] ?? 0),
        );
        const target = endPose(graph, layout, exit);
        for (let other = 0; other < connectors.length; other++) {
          const far = connectors[other];
          if (other === held || !far) continue;
          if (Math.abs((spans[held * connectors.length + other] ?? 0) - span) > SPAN_CHECK_LDU) {
            continue;
          }
          if (!pose16Equals(composePose16(placement, far), target)) continue;
          const replaces = replacedBy(links, first, last);
          if (replaces.size === 1 && !second && layout.piece(through) === only?.piece) continue;
          found.push({
            placement,
            yPlates,
            replaces,
            joins: joined(graph, entry) + joined(graph, exit),
          });
        }
      }
    }
  }
  return found;
}

function runThrough(
  graph: TrackGraph,
  layout: TrackLayout,
  liftable: number,
  through: number,
): ReadonlyArray<RunLink> {
  const yPlates = layout.yPlates(through);
  if (!inRun(graph, layout, liftable, through, yPlates)) return [];
  const start = graph.endStart[through] ?? 0;
  const seen = new Set([through]);
  const ahead = walk(graph, layout, liftable, start + 1, yPlates, seen);
  const behind = walk(graph, layout, liftable, start, yPlates, seen);
  return [
    ...behind
      .toReversed()
      .map(({ placement, entry, exit }) => ({ placement, entry: exit, exit: entry })),
    { placement: through, entry: start, exit: start + 1 },
    ...ahead,
  ];
}

function walk(
  graph: TrackGraph,
  layout: TrackLayout,
  liftable: number,
  from: number,
  yPlates: number,
  seen: Set<number>,
): RunLink[] {
  const links: RunLink[] = [];
  let end = from;
  while (links.length < RUN_REACH) {
    const entry = graph.endPartner[end] ?? NO_END;
    if (entry === NO_END) break;
    const placement = graph.endPlacement[entry] ?? 0;
    if (seen.has(placement) || !inRun(graph, layout, liftable, placement, yPlates)) break;
    const start = graph.endStart[placement] ?? 0;
    const exit = entry === start ? start + 1 : start;
    links.push({ placement, entry, exit });
    seen.add(placement);
    end = exit;
  }
  return links;
}

function inRun(
  graph: TrackGraph,
  layout: TrackLayout,
  liftable: number,
  placement: number,
  yPlates: number,
): boolean {
  const ends = (graph.endStart[placement + 1] ?? 0) - (graph.endStart[placement] ?? 0);
  return (
    placement < liftable &&
    ends === RUN_PIECE_ENDS &&
    layout.rise(placement) === 0 &&
    layout.yPlates(placement) === yPlates
  );
}

function endSpans(ends: ReadonlyArray<Pose16>): Float64Array {
  const studs = ends.map((end) => zeta16ToStuds(end.position));
  const spans = new Float64Array(ends.length * ends.length);
  studs.forEach((a, i) =>
    studs.forEach((b, j) => {
      spans[i * ends.length + j] = planeHypot(b.x - a.x, b.z - a.z) * STUD_LDU;
    }),
  );
  return spans;
}

function endPose(graph: TrackGraph, layout: TrackLayout, end: number): Pose16 {
  return layout.connectorPose(graph.endPlacement[end] ?? 0, graph.endConnector[end] ?? 0);
}

function joined(graph: TrackGraph, end: number): number {
  return (graph.endPartner[end] ?? NO_END) === NO_END ? 0 : 1;
}

function replacedBy(
  links: ReadonlyArray<RunLink>,
  first: number,
  last: number,
): ReadonlySet<number> {
  return new Set(
    links
      .slice(first, last + 1)
      .map((link) => link.placement)
      .toSorted((a, b) => a - b),
  );
}
