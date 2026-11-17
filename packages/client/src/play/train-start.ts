import type { TrackPiece } from "@brr/catalog";
import { NO_EDGE, NO_SWITCH, type TrackGraph, type TrackLayout } from "@brr/domain";

export interface TrainStart {
  readonly edge: number;
  readonly offsetLdu: number;
  readonly aheadLdu: number;
}

export function edgeLengths(
  graph: TrackGraph,
  layout: TrackLayout,
  pieces: ReadonlyArray<TrackPiece>,
): Float64Array {
  const lengths = new Float64Array(graph.edgeCount);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const piece = pieces[layout.piece(graph.edgePlacement[edge] ?? 0)];
    const route = piece?.routes[graph.edgeRoute[edge] ?? 0];
    if (!route) throw new Error(`edge ${edge} has no catalog route`);
    lengths[edge] = route.lengthLdu;
  }
  return lengths;
}

export function nextEdge(graph: TrackGraph, edge: number, switchStates: Uint8Array): number {
  const start = graph.successorStart[edge] ?? 0;
  const count = (graph.successorStart[edge + 1] ?? start) - start;
  if (count === 0) return NO_EDGE;
  const control = graph.edgeSwitch[edge] ?? NO_SWITCH;
  const choice = control === NO_SWITCH ? 0 : (switchStates[control] ?? 0);
  return graph.successors[start + (choice < count ? choice : 0)] ?? NO_EDGE;
}

function reachLdu(
  graph: TrackGraph,
  lengths: Float64Array,
  switchStates: Uint8Array,
  from: number,
  limit: number,
): number {
  let reached = 0;
  let edge = nextEdge(graph, from, switchStates);
  while (edge !== NO_EDGE && reached < limit) {
    reached += lengths[edge] ?? 0;
    edge = nextEdge(graph, edge, switchStates);
  }
  return reached;
}

export function trainStart(
  graph: TrackGraph,
  lengths: Float64Array,
  switchStates: Uint8Array,
  trainLengthLdu: number,
): TrainStart | null {
  let best: TrainStart | null = null;
  let aheadLimit = 0;
  for (let edge = 0; edge < graph.edgeCount; edge++) aheadLimit += lengths[edge] ?? 0;
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const offsetLdu = lengths[edge] ?? 0;
    const behind =
      offsetLdu +
      reachLdu(graph, lengths, switchStates, edge ^ 1, Math.max(trainLengthLdu - offsetLdu, 0));
    if (behind < trainLengthLdu) continue;
    const aheadLdu = reachLdu(graph, lengths, switchStates, edge, aheadLimit);
    if (!best || aheadLdu > best.aheadLdu) best = { edge, offsetLdu, aheadLdu };
  }
  return best;
}
