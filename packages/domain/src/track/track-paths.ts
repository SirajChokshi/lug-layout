import { NO_END, type TrackGraph } from "./track-graph.ts";

const MARKED = 1;
const BRANCHING_OUT_EDGES = 2;

function marked(flags: Uint8Array): Int32Array {
  let count = 0;
  for (let i = 0; i < flags.length; i++) count += flags[i] ?? 0;
  const out = new Int32Array(count);
  let next = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === MARKED) out[next++] = i;
  }
  return out;
}

export class TrackPaths {
  private readonly branches: Uint8Array;

  constructor(readonly graph: TrackGraph) {
    const { placementCount, endStart, outStart } = graph;
    this.branches = new Uint8Array(placementCount);
    for (let p = 0; p < placementCount; p++) {
      const last = endStart[p + 1] ?? 0;
      for (let end = endStart[p] ?? 0; end < last; end++) {
        const outEdges = (outStart[end + 1] ?? 0) - (outStart[end] ?? 0);
        if (outEdges >= BRANCHING_OUT_EDGES) this.branches[p] = MARKED;
      }
    }
  }

  run(start: number): Int32Array {
    this.check(start);
    const { endStart, endPlacement, endPartner, outStart, outEdges, edgeToEnd } = this.graph;
    const reached = new Uint8Array(this.graph.placementCount);
    const walked = new Uint8Array(this.graph.edgeCount);
    const arrivals = new Int32Array(this.graph.endCount);
    let top = 0;
    reached[start] = MARKED;
    const startLast = endStart[start + 1] ?? 0;
    for (let end = endStart[start] ?? 0; end < startLast; end++) {
      const outLast = outStart[end + 1] ?? 0;
      for (let o = outStart[end] ?? 0; o < outLast; o++) walked[outEdges[o] ?? 0] = MARKED;
      const partner = endPartner[end] ?? NO_END;
      if (partner !== NO_END) arrivals[top++] = partner;
    }
    while (top > 0) {
      const arrival = arrivals[--top] ?? 0;
      const piece = endPlacement[arrival] ?? 0;
      if (piece !== start && this.branches[piece] === MARKED) continue;
      reached[piece] = MARKED;
      const outLast = outStart[arrival + 1] ?? 0;
      for (let o = outStart[arrival] ?? 0; o < outLast; o++) {
        const edge = outEdges[o] ?? 0;
        if (walked[edge] === MARKED) continue;
        walked[edge] = MARKED;
        walked[this.graph.reverse(edge)] = MARKED;
        const partner = endPartner[edgeToEnd[edge] ?? 0] ?? NO_END;
        if (partner !== NO_END) arrivals[top++] = partner;
      }
    }
    return marked(reached);
  }

  network(start: number): Int32Array {
    this.check(start);
    const { endStart, endPlacement, endPartner } = this.graph;
    const reached = new Uint8Array(this.graph.placementCount);
    const pending = new Int32Array(this.graph.placementCount);
    let top = 0;
    reached[start] = MARKED;
    pending[top++] = start;
    while (top > 0) {
      const piece = pending[--top] ?? 0;
      const last = endStart[piece + 1] ?? 0;
      for (let end = endStart[piece] ?? 0; end < last; end++) {
        const partner = endPartner[end] ?? NO_END;
        if (partner === NO_END) continue;
        const next = endPlacement[partner] ?? 0;
        if (reached[next] === MARKED) continue;
        reached[next] = MARKED;
        pending[top++] = next;
      }
    }
    return marked(reached);
  }

  private check(placement: number): void {
    if (!Number.isInteger(placement) || placement < 0 || placement >= this.graph.placementCount) {
      throw new RangeError(`track placement ${placement} is not in the graph`);
    }
  }
}
