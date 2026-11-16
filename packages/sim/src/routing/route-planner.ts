import { NO_EDGE } from "@brr/domain";
import type { BlockMap } from "../blocks/block-map.ts";

export class RoutePlanner {
  private readonly distance: Float64Array;
  private readonly previous: Int32Array;
  private readonly settled: Uint8Array;
  private readonly heapEdge: Int32Array;
  private readonly heapKey: Float64Array;
  private heapSize = 0;
  lastLengthLdu = 0;

  constructor(private readonly blocks: BlockMap) {
    const edges = blocks.graph.edgeCount;
    const heapCapacity = edges + blocks.graph.successors.length + 1;
    this.distance = new Float64Array(edges);
    this.previous = new Int32Array(edges);
    this.settled = new Uint8Array(edges);
    this.heapEdge = new Int32Array(heapCapacity);
    this.heapKey = new Float64Array(heapCapacity);
  }

  plan(
    fromEdge: number,
    fromOffsetLdu: number,
    targetBlock: number,
    placementPenaltyLdu: Float64Array,
    out: Int32Array,
  ): number {
    const { graph, edgeLengthLdu } = this.blocks;
    this.distance.fill(Number.POSITIVE_INFINITY);
    this.previous.fill(NO_EDGE);
    this.settled.fill(0);
    this.heapSize = 0;
    this.distance[fromEdge] = (edgeLengthLdu[fromEdge] ?? 0) - fromOffsetLdu;
    this.push(fromEdge, this.distance[fromEdge] ?? 0);
    let goal = NO_EDGE;
    while (this.heapSize > 0) {
      const edge = this.pop();
      if (this.settled[edge] === 1) continue;
      this.settled[edge] = 1;
      if (edge !== fromEdge && this.isLastEdgeIn(edge, targetBlock)) {
        goal = edge;
        break;
      }
      const reached = this.distance[edge] ?? 0;
      const end = graph.successorStart[edge + 1] ?? 0;
      for (let s = graph.successorStart[edge] ?? 0; s < end; s++) {
        const next = graph.successors[s] ?? NO_EDGE;
        if (next === NO_EDGE || this.settled[next] === 1) continue;
        const cost =
          (edgeLengthLdu[next] ?? 0) + (placementPenaltyLdu[graph.edgePlacement[next] ?? 0] ?? 0);
        if (reached + cost < (this.distance[next] ?? Number.POSITIVE_INFINITY)) {
          this.distance[next] = reached + cost;
          this.previous[next] = edge;
          this.push(next, reached + cost);
        }
      }
    }
    if (goal === NO_EDGE) return 0;
    this.lastLengthLdu = this.distance[goal] ?? 0;
    let count = 0;
    for (let edge = goal; edge !== NO_EDGE; edge = this.previous[edge] ?? NO_EDGE) count++;
    if (count > out.length) throw new RangeError(`route of ${count} edges exceeds ${out.length}`);
    let index = count;
    for (let edge = goal; edge !== NO_EDGE; edge = this.previous[edge] ?? NO_EDGE) {
      out[--index] = edge;
    }
    return count;
  }

  private isLastEdgeIn(edge: number, block: number): boolean {
    if (this.blocks.edgeBlock(edge) !== block) return false;
    const { graph } = this.blocks;
    const end = graph.successorStart[edge + 1] ?? 0;
    for (let s = graph.successorStart[edge] ?? 0; s < end; s++) {
      if (this.blocks.edgeBlock(graph.successors[s] ?? 0) === block) return false;
    }
    return true;
  }

  private push(edge: number, key: number): void {
    let i = this.heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.heapKey[parent] ?? 0) <= key) break;
      this.heapEdge[i] = this.heapEdge[parent] ?? 0;
      this.heapKey[i] = this.heapKey[parent] ?? 0;
      i = parent;
    }
    this.heapEdge[i] = edge;
    this.heapKey[i] = key;
  }

  private pop(): number {
    const top = this.heapEdge[0] ?? 0;
    const last = --this.heapSize;
    const edge = this.heapEdge[last] ?? 0;
    const key = this.heapKey[last] ?? 0;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= last) break;
      if (child + 1 < last && (this.heapKey[child + 1] ?? 0) < (this.heapKey[child] ?? 0)) child++;
      if ((this.heapKey[child] ?? 0) >= key) break;
      this.heapEdge[i] = this.heapEdge[child] ?? 0;
      this.heapKey[i] = this.heapKey[child] ?? 0;
      i = child;
    }
    this.heapEdge[i] = edge;
    this.heapKey[i] = key;
    return top;
  }
}
