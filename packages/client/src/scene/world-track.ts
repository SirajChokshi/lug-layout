import { NO_EDGE, TrackLayout, type TrackGraph } from "@brr/domain";
import { pose16 } from "@brr/math";
import type { TrackCatalog } from "@brr/schema/bundle";
import { decodeTrackPosition, type TrackRecordV1 } from "@brr/schema/world";
import { pieceSpec, type TrackPlanLayout } from "./track-plan.ts";

export function buildWorldTrack(
  records: ReadonlyArray<TrackRecordV1>,
  catalog: TrackCatalog,
): TrackPlanLayout {
  const catalogPieces = catalog.pieces;
  const pieceIndex = new Map(catalogPieces.map((piece, index) => [piece.id, index]));
  const layout = new TrackLayout(catalogPieces.map(pieceSpec));
  for (const record of records.toSorted((a, b) => a.index - b.index)) {
    const piece = pieceIndex.get(record.ref);
    if (piece === undefined) throw new Error(`track piece "${record.ref}" isn't in the catalog`);
    if (layout.count !== record.index) {
      throw new Error(`track record ${record.index} is out of order at ${layout.count}`);
    }
    layout.place(
      piece,
      pose16(decodeTrackPosition(record.position), record.heading),
      record.yPlates,
    );
  }
  return { layout, catalogPieces };
}

export function routeEdge(
  graph: TrackGraph,
  placement: number,
  route: number,
  forward: boolean,
): number {
  for (let edge = forward ? 0 : 1; edge < graph.edgeCount; edge += 2) {
    if (graph.edgePlacement[edge] === placement && graph.edgeRoute[edge] === route) return edge;
  }
  return NO_EDGE;
}
