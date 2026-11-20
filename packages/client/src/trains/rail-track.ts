import {
  RailNetwork,
  TrackGraph,
  WORLD_TRACK_FRAME,
  simTrackFromGraph,
  type ConsistAnchor,
  type TrackPieceKey,
} from "@brr/domain";
import { pose16 } from "@brr/math";
import type { TrackPiece } from "@brr/schema/bundle";
import { decodeTrackPosition, encodeTrackPosition, type TrackPieceKeyV1 } from "@brr/schema/world";
import type { PlayTrack } from "../edit/track-drawing.ts";
import { routeSegments } from "../sim/sim-track-input.ts";

const DIVERGING = 1;
const STRAIGHT = 0;
const DIVERGING_PIECE = /-f2$/u;

export interface RailHead {
  readonly edge: number;
  readonly offsetLdu: number;
}

export interface SwitchSite {
  readonly label: string;
  readonly x: number;
  readonly z: number;
}

function keyText(key: TrackPieceKey): string {
  return [
    key.piece,
    key.placement.heading,
    key.yPlates,
    ...encodeTrackPosition(key.placement.position),
  ].join(" ");
}

export class RailTrack {
  readonly graph: TrackGraph;
  readonly network: RailNetwork;
  readonly switchStates: Uint8Array;
  readonly sites: ReadonlyArray<SwitchSite>;
  private readonly placements = new Map<string, number>();
  private readonly firstEdge: Int32Array;

  constructor(readonly play: PlayTrack) {
    const { layout, pieces } = play;
    this.graph = new TrackGraph(layout);
    const graph = this.graph;
    this.firstEdge = new Int32Array(layout.count).fill(-1);
    for (let edge = graph.edgeCount - 1; edge >= 0; edge--) {
      this.firstEdge[graph.edgePlacement[edge] ?? 0] = edge;
    }
    for (let p = 0; p < layout.count; p++) {
      if (layout.frame(p).id !== WORLD_TRACK_FRAME.id) continue;
      const text = keyText({
        piece: layout.piece(p),
        placement: layout.pose(p),
        yPlates: layout.yPlates(p),
      });
      if (!this.placements.has(text)) this.placements.set(text, p);
    }
    const sites: SwitchSite[] = [];
    this.switchStates = new Uint8Array(graph.switchCount);
    for (let s = 0; s < graph.switchCount; s++) {
      const placement = graph.endPlacement[graph.switchEnd[s] ?? 0] ?? 0;
      const piece = pieces[layout.piece(placement)];
      let x = 0;
      let z = 0;
      let ends = 0;
      for (let end = 0; end < graph.endCount; end++) {
        if (graph.endPlacement[end] !== placement) continue;
        x += graph.endXLdu[end] ?? 0;
        z += graph.endZLdu[end] ?? 0;
        ends++;
      }
      this.switchStates[s] = DIVERGING_PIECE.test(piece?.id ?? "") ? DIVERGING : STRAIGHT;
      sites.push({
        label: `Switch ${s + 1} (${piece?.title ?? "switch"})`,
        x: ends === 0 ? 0 : x / ends,
        z: ends === 0 ? 0 : z / ends,
      });
    }
    this.sites = sites;
    const { track } = simTrackFromGraph(graph, routeSegments(graph, layout, pieces));
    this.network = new RailNetwork(track, this.switchStates);
  }

  get railTopY(): number {
    return this.play.railTopY;
  }

  get railPart(): string {
    return this.play.railPart;
  }

  placementOf(edge: number): number {
    return this.graph.edgePlacement[edge] ?? -1;
  }

  anchorOf(head: RailHead): ConsistAnchor | null {
    const { layout } = this.play;
    const placement = this.placementOf(head.edge);
    if (placement < 0 || layout.frame(placement).id !== WORLD_TRACK_FRAME.id) return null;
    return {
      track: {
        piece: layout.piece(placement),
        placement: layout.pose(placement),
        yPlates: layout.yPlates(placement),
      },
      route: this.graph.edgeRoute[head.edge] ?? 0,
      reversed: head.edge % 2 === 1,
      offsetLdu: head.offsetLdu,
    };
  }

  headOf(anchor: ConsistAnchor): RailHead | null {
    const placement = this.placements.get(keyText(anchor.track));
    if (placement === undefined) return null;
    const routes = this.play.pieces[anchor.track.piece]?.routes.length ?? 0;
    if (anchor.route >= routes) return null;
    const edge = (this.firstEdge[placement] ?? 0) + 2 * anchor.route + (anchor.reversed ? 1 : 0);
    if (anchor.offsetLdu > this.network.edgeLength(edge)) return null;
    return { edge, offsetLdu: anchor.offsetLdu };
  }
}

export function pieceRecord(
  pieces: ReadonlyArray<TrackPiece>,
  key: TrackPieceKey,
): TrackPieceKeyV1 {
  const piece = pieces[key.piece];
  if (!piece) throw new Error(`track catalog has no piece ${key.piece}`);
  return {
    ref: piece.id,
    heading: key.placement.heading,
    position: encodeTrackPosition(key.placement.position),
    yPlates: key.yPlates,
  };
}

export function pieceKey(
  pieces: ReadonlyArray<TrackPiece>,
  record: TrackPieceKeyV1,
): TrackPieceKey | null {
  const piece = pieces.findIndex((candidate) => candidate.id === record.ref);
  if (piece < 0) return null;
  return {
    piece,
    placement: pose16(decodeTrackPosition(record.position), record.heading),
    yPlates: record.yPlates,
  };
}
