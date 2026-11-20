import type { TrackPiece } from "@brr/schema/bundle";
import type {
  SimPathSegment,
  TrackGraph,
  TrackGraphTopology,
  TrackLayout,
} from "@brr/domain";

export function simTopology(graph: TrackGraph): TrackGraphTopology {
  return {
    edgeCount: graph.edgeCount,
    switchCount: graph.switchCount,
    endXLdu: graph.endXLdu,
    endZLdu: graph.endZLdu,
    endHeading: graph.endHeading,
    edgeFromEnd: graph.edgeFromEnd,
    edgeToEnd: graph.edgeToEnd,
    successorStart: graph.successorStart,
    successors: graph.successors,
    edgeSwitch: graph.edgeSwitch,
    placementCount: graph.placementCount,
    edgePlacement: graph.edgePlacement,
    edgeRoute: graph.edgeRoute,
    endPlacement: graph.endPlacement,
    endPartner: graph.endPartner,
    switchEnd: graph.switchEnd,
  };
}

export function routeSegments(
  graph: TrackGraph,
  layout: TrackLayout,
  pieces: ReadonlyArray<TrackPiece>,
): SimPathSegment[][] {
  const segments: SimPathSegment[][] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 2) {
    const placement = graph.edgePlacement[edge] ?? 0;
    const piece = pieces[layout.piece(placement)];
    const route = piece?.routes[graph.edgeRoute[edge] ?? 0];
    if (!route) throw new Error(`edge ${edge} has no catalog route`);
    segments.push([...route.segments]);
  }
  return segments;
}
