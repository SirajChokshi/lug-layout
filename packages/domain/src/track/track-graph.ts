import { posesJoin16, type Pose16 } from "@brr/math";
import { pieceEnds, type PieceEnds } from "./piece-ends.ts";
import type { TrackLayout } from "./track-layout.ts";

export const NO_END = -1;
export const NO_EDGE = -1;
export const NO_SWITCH = -1;

export interface CoincidentEndsIssue {
  readonly kind: "coincident-ends-not-joined";
  readonly ends: ReadonlyArray<number>;
}

export type TrackGraphIssue = CoincidentEndsIssue;

export class TrackGraph {
  readonly placementCount: number;
  readonly endStart: Int32Array;
  readonly endPlacement: Int32Array;
  readonly endConnector: Int32Array;
  readonly endPartner: Int32Array;
  readonly endXLdu: Float64Array;
  readonly endZLdu: Float64Array;
  readonly endHeading: Uint8Array;
  readonly endYPlates: Int16Array;
  readonly endFrame: Uint32Array;
  readonly edgePlacement: Int32Array;
  readonly edgeRoute: Int32Array;
  readonly edgeFromEnd: Int32Array;
  readonly edgeToEnd: Int32Array;
  readonly outStart: Int32Array;
  readonly outEdges: Int32Array;
  readonly successorStart: Int32Array;
  readonly successors: Int32Array;
  readonly edgeSwitch: Int32Array;
  readonly switchEnd: Int32Array;
  readonly openEnds: Int32Array;
  readonly issues: ReadonlyArray<TrackGraphIssue>;

  static of(layout: TrackLayout): TrackGraph {
    return new TrackGraph(layout, layoutEnds(layout));
  }

  static fromEnds(layout: TrackLayout, ends: ReadonlyArray<PieceEnds>): TrackGraph {
    if (ends.length !== layout.count) {
      throw new Error(
        `ends were given for ${ends.length} placements of a ${layout.count}-piece layout`,
      );
    }
    for (let p = 0; p < layout.count; p++) {
      const given = ends[p];
      if (
        !given ||
        given.spec !== layout.pieces[layout.piece(p)] ||
        !layout.sameRow(p, given.placement)
      ) {
        throw new Error(`the ends given for placement ${p} weren't computed from its row`);
      }
    }
    return new TrackGraph(layout, ends);
  }

  private constructor(layout: TrackLayout, ends: ReadonlyArray<PieceEnds>) {
    const placementCount = layout.count;
    const endStart = new Int32Array(placementCount + 1);
    let edgeTotal = 0;
    for (let p = 0; p < placementCount; p++) {
      const spec = layout.pieces[layout.piece(p)];
      endStart[p + 1] = (endStart[p] ?? 0) + (spec?.connectors.length ?? 0);
      edgeTotal += 2 * (spec?.routes.length ?? 0);
    }
    const endTotal = endStart[placementCount] ?? 0;
    const endPlacement = new Int32Array(endTotal);
    const endConnector = new Int32Array(endTotal);
    const endPartner = new Int32Array(endTotal).fill(NO_END);
    const endXLdu = new Float64Array(endTotal);
    const endZLdu = new Float64Array(endTotal);
    const endHeading = new Uint8Array(endTotal);
    const endYPlates = new Int16Array(endTotal);
    const endFrame = new Uint32Array(endTotal);
    const poses: Pose16[] = [];
    const byPosition = new Map<string, number[]>();

    for (let p = 0; p < placementCount; p++) {
      const piece = ends[p];
      if (!piece) throw new Error(`placement ${p} has no ends to build its graph from`);
      const first = endStart[p] ?? 0;
      const frame = piece.placement.frame.id;
      for (let connector = 0; connector < piece.ends.length; connector++) {
        const at = piece.ends[connector];
        if (!at) throw new Error(`placement ${p} has no end at connector ${connector}`);
        const end = first + connector;
        poses.push(at.pose);
        endPlacement[end] = p;
        endConnector[end] = connector;
        endXLdu[end] = at.xLdu;
        endZLdu[end] = at.zLdu;
        endHeading[end] = at.pose.heading;
        endYPlates[end] = at.yPlates;
        endFrame[end] = frame;
        const group = byPosition.get(at.key);
        if (group) group.push(end);
        else byPosition.set(at.key, [end]);
      }
    }

    const issues: TrackGraphIssue[] = [];
    for (const group of byPosition.values()) {
      if (group.length === 1) continue;
      const [a, b] = group;
      const poseA = a === undefined ? undefined : poses[a];
      const poseB = b === undefined ? undefined : poses[b];
      if (
        group.length === 2 &&
        a !== undefined &&
        b !== undefined &&
        poseA &&
        poseB &&
        posesJoin16(poseA, poseB)
      ) {
        endPartner[a] = b;
        endPartner[b] = a;
      } else {
        issues.push({ kind: "coincident-ends-not-joined", ends: group });
      }
    }

    const edgePlacement = new Int32Array(edgeTotal);
    const edgeRoute = new Int32Array(edgeTotal);
    const edgeFromEnd = new Int32Array(edgeTotal);
    const edgeToEnd = new Int32Array(edgeTotal);
    const outStart = new Int32Array(endTotal + 1);
    let edge = 0;
    for (let p = 0; p < placementCount; p++) {
      const first = endStart[p] ?? 0;
      const routes = layout.pieces[layout.piece(p)]?.routes ?? [];
      routes.forEach(({ from, to }, route) => {
        for (const [a, b] of [
          [from, to],
          [to, from],
        ] as const) {
          edgePlacement[edge] = p;
          edgeRoute[edge] = route;
          edgeFromEnd[edge] = first + a;
          edgeToEnd[edge] = first + b;
          outStart[first + a + 1] = (outStart[first + a + 1] ?? 0) + 1;
          edge++;
        }
      });
    }
    for (let end = 0; end < endTotal; end++) {
      outStart[end + 1] = (outStart[end + 1] ?? 0) + (outStart[end] ?? 0);
    }
    const outEdges = new Int32Array(edgeTotal);
    const outFill = outStart.slice(0, endTotal);
    for (let e = 0; e < edgeTotal; e++) {
      const from = edgeFromEnd[e] ?? 0;
      const slot = outFill[from] ?? 0;
      outEdges[slot] = e;
      outFill[from] = slot + 1;
    }

    const switchOfEnd = new Int32Array(endTotal).fill(NO_SWITCH);
    const switchEnds: number[] = [];
    for (let end = 0; end < endTotal; end++) {
      if ((outStart[end + 1] ?? 0) - (outStart[end] ?? 0) > 1) {
        switchOfEnd[end] = switchEnds.length;
        switchEnds.push(end);
      }
    }

    const successorStart = new Int32Array(edgeTotal + 1);
    const edgeSwitch = new Int32Array(edgeTotal).fill(NO_SWITCH);
    for (let e = 0; e < edgeTotal; e++) {
      const partner = endPartner[edgeToEnd[e] ?? 0] ?? NO_END;
      const count =
        partner === NO_END ? 0 : (outStart[partner + 1] ?? 0) - (outStart[partner] ?? 0);
      successorStart[e + 1] = (successorStart[e] ?? 0) + count;
      if (partner !== NO_END) edgeSwitch[e] = switchOfEnd[partner] ?? NO_SWITCH;
    }
    const successors = new Int32Array(successorStart[edgeTotal] ?? 0);
    for (let e = 0; e < edgeTotal; e++) {
      const partner = endPartner[edgeToEnd[e] ?? 0] ?? NO_END;
      if (partner === NO_END) continue;
      successors.set(
        outEdges.subarray(outStart[partner] ?? 0, outStart[partner + 1] ?? 0),
        successorStart[e] ?? 0,
      );
    }

    const openEnds: number[] = [];
    for (let end = 0; end < endTotal; end++) {
      if (endPartner[end] === NO_END) openEnds.push(end);
    }

    this.placementCount = placementCount;
    this.endStart = endStart;
    this.endPlacement = endPlacement;
    this.endConnector = endConnector;
    this.endPartner = endPartner;
    this.endXLdu = endXLdu;
    this.endZLdu = endZLdu;
    this.endHeading = endHeading;
    this.endYPlates = endYPlates;
    this.endFrame = endFrame;
    this.edgePlacement = edgePlacement;
    this.edgeRoute = edgeRoute;
    this.edgeFromEnd = edgeFromEnd;
    this.edgeToEnd = edgeToEnd;
    this.outStart = outStart;
    this.outEdges = outEdges;
    this.successorStart = successorStart;
    this.successors = successors;
    this.edgeSwitch = edgeSwitch;
    this.switchEnd = Int32Array.from(switchEnds);
    this.openEnds = Int32Array.from(openEnds);
    this.issues = issues;
  }

  get endCount(): number {
    return this.endPlacement.length;
  }

  get edgeCount(): number {
    return this.edgeFromEnd.length;
  }

  get switchCount(): number {
    return this.switchEnd.length;
  }

  get joinCount(): number {
    let joined = 0;
    for (let end = 0; end < this.endPartner.length; end++) {
      if ((this.endPartner[end] ?? NO_END) > end) joined++;
    }
    return joined;
  }

  reverse(edge: number): number {
    return edge ^ 1;
  }

  successorCount(edge: number): number {
    return (this.successorStart[edge + 1] ?? 0) - (this.successorStart[edge] ?? 0);
  }

  successor(edge: number, switchStates: Uint8Array): number {
    const start = this.successorStart[edge] ?? 0;
    const count = (this.successorStart[edge + 1] ?? 0) - start;
    if (count === 0) return NO_EDGE;
    const control = this.edgeSwitch[edge] ?? NO_SWITCH;
    const choice = control === NO_SWITCH ? 0 : (switchStates[control] ?? 0);
    return this.successors[start + (choice < count ? choice : 0)] ?? NO_EDGE;
  }

  reachableEdgeCount(from: number): number {
    const seen = new Uint8Array(this.edgeCount);
    const stack = new Int32Array(this.edgeCount);
    let top = 0;
    let reached = 0;
    stack[top++] = from;
    seen[from] = 1;
    while (top > 0) {
      const edge = stack[--top] ?? 0;
      reached++;
      const end = this.successorStart[edge + 1] ?? 0;
      for (let s = this.successorStart[edge] ?? 0; s < end; s++) {
        const next = this.successors[s] ?? 0;
        if (seen[next] === 0) {
          seen[next] = 1;
          stack[top++] = next;
        }
      }
    }
    return reached;
  }
}

function layoutEnds(layout: TrackLayout): ReadonlyArray<PieceEnds> {
  return Array.from({ length: layout.count }, (_, p) => {
    const piece = layout.piece(p);
    const spec = layout.pieces[piece];
    if (!spec) throw new RangeError(`placement ${p} has no piece ${piece} in its layout`);
    return pieceEnds(spec, {
      piece,
      pose: layout.pose(p),
      yPlates: layout.yPlates(p),
      rise: layout.rise(p),
      frame: layout.frame(p),
    });
  });
}
