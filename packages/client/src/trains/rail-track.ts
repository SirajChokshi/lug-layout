import {
  RailNetwork,
  TrackGraph,
  WORLD_TRACK_FRAME,
  sameCarrier,
  simTrackFromGraph,
  type CarrierPose,
  type ConsistAnchor,
  type LaidPieceRef,
} from "@brr/domain";
import { pose16 } from "@brr/math";
import type { TrackPiece } from "@brr/schema/bundle";
import { decodeTrackPosition, encodeTrackPosition, type LaidPieceV1 } from "@brr/schema/world";
import type { PlayTrack } from "../edit/track-drawing.ts";
import { routeLifts, routeSegments } from "../sim/sim-track-input.ts";

const DIVERGING = 1;
const STRAIGHT = 0;
const DIVERGING_PIECE = /-f2$/u;

export interface RailHead {
  readonly edge: number;
  readonly offsetLdu: number;
}

export interface RailCarrier {
  readonly pose: CarrierPose;
  readonly first: number;
  readonly count: number;
}

export interface SwitchSite {
  readonly label: string;
  readonly x: number;
  readonly z: number;
}

type PieceKey = Omit<LaidPieceRef, "kind">;

function keyText(key: PieceKey): string {
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

  constructor(
    readonly play: PlayTrack,
    private readonly carriers: ReadonlyArray<RailCarrier>,
  ) {
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
    const { track } = simTrackFromGraph(
      graph,
      routeSegments(graph, layout, pieces),
      routeLifts(graph, layout),
    );
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
    if (placement < 0) return null;
    const route = this.graph.edgeRoute[head.edge] ?? 0;
    const reversed = head.edge % 2 === 1;
    const offsetLdu = head.offsetLdu;
    const carrier = this.carriers.find(
      ({ first, count }) => placement >= first && placement < first + count,
    );
    if (carrier) {
      const piece = placement - carrier.first;
      return {
        track: { kind: "carried", carrier: carrier.pose, piece },
        route,
        reversed,
        offsetLdu,
      };
    }
    if (layout.frame(placement).id !== WORLD_TRACK_FRAME.id) return null;
    const track = {
      kind: "laid",
      piece: layout.piece(placement),
      placement: layout.pose(placement),
      yPlates: layout.yPlates(placement),
    } as const;
    return { track, route, reversed, offsetLdu };
  }

  private placementOfAnchor(anchor: ConsistAnchor): number | null {
    const { track } = anchor;
    switch (track.kind) {
      case "laid":
        return this.placements.get(keyText(track)) ?? null;
      case "carried": {
        const carrier = this.carriers.find((candidate) =>
          sameCarrier(candidate.pose, track.carrier),
        );
        return carrier && track.piece < carrier.count ? carrier.first + track.piece : null;
      }
      default: {
        const unhandled: never = track;
        throw new Error(`unhandled track piece ref ${String(unhandled)}`);
      }
    }
  }

  headOf(anchor: ConsistAnchor): RailHead | null {
    const placement = this.placementOfAnchor(anchor);
    if (placement === null) return null;
    const routes = this.play.pieces[this.play.layout.piece(placement)]?.routes.length ?? 0;
    if (anchor.route >= routes) return null;
    const edge = (this.firstEdge[placement] ?? 0) + 2 * anchor.route + (anchor.reversed ? 1 : 0);
    if (anchor.offsetLdu > this.network.edgeLength(edge)) return null;
    return { edge, offsetLdu: anchor.offsetLdu };
  }
}

export function laidPieceRecord(pieces: ReadonlyArray<TrackPiece>, key: PieceKey): LaidPieceV1 {
  const piece = pieces[key.piece];
  if (!piece) throw new Error(`track catalog has no piece ${key.piece}`);
  return {
    on: "track",
    ref: piece.id,
    heading: key.placement.heading,
    position: encodeTrackPosition(key.placement.position),
    yPlates: key.yPlates,
  };
}

export function laidPieceRef(
  pieces: ReadonlyArray<TrackPiece>,
  record: LaidPieceV1,
): LaidPieceRef | null {
  const piece = pieces.findIndex((candidate) => candidate.id === record.ref);
  if (piece < 0) return null;
  return {
    kind: "laid",
    piece,
    placement: pose16(decodeTrackPosition(record.position), record.heading),
    yPlates: record.yPlates,
  };
}
