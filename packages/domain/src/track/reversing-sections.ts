import type { TrackGraph } from "./track-graph.ts";

export type ReversingTopology = Pick<
  TrackGraph,
  "placementCount" | "endPlacement" | "endPartner" | "edgeFromEnd" | "edgeToEnd" | "edgePlacement"
>;

const NO_LINK = -1;
const NO_END = -1;
const NO_PLACEMENT = -1;
const UNVISITED = 0;
const SHORTEST_ODD_CYCLE = 3;

export class ReversingSections {
  constructor(
    readonly turningEnd: Int32Array,
    readonly placementStart: Int32Array,
    readonly placements: Int32Array,
  ) {}

  get count(): number {
    return this.turningEnd.length;
  }
}

export const NO_REVERSING_SECTIONS = new ReversingSections(
  new Int32Array(0),
  new Int32Array(1),
  new Int32Array(0),
);

function room(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  return array.length >= length ? array : new Int32Array(Math.max(length, array.length * 2));
}

function grown(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const larger = new Int32Array(Math.max(length, array.length * 2));
  larger.set(array);
  return larger;
}

export class ReversingSectionFinder {
  private linkA = new Int32Array(0);
  private linkB = new Int32Array(0);
  private linkPlacement = new Int32Array(0);
  private linkBlock = new Int32Array(0);
  private adjacencyStart = new Int32Array(0);
  private adjacencyFill = new Int32Array(0);
  private adjacency = new Int32Array(0);
  private discovered = new Int32Array(0);
  private low = new Int32Array(0);
  private visitOrder = 0;
  private frameEnd = new Int32Array(0);
  private frameLink = new Int32Array(0);
  private frameNext = new Int32Array(0);
  private frames = 0;
  private linkStack = new Int32Array(0);
  private block = 0;
  private endBlock = new Int32Array(0);
  private colour = new Int32Array(0);
  private depth = new Int32Array(0);
  private treeLink = new Int32Array(0);
  private queue = new Int32Array(0);
  private turning = NO_END;
  private placementStamp = new Int32Array(0);
  private stampNow = 0;
  private sectionTurning = new Int32Array(0);
  private sectionStart = new Int32Array(1);
  private sectionPlacements = new Int32Array(0);
  private sectionCount = 0;
  private placementTotal = 0;

  find(graph: ReversingTopology): ReversingSections {
    const ends = graph.endPlacement.length;
    const links = this.collectLinks(graph);
    this.buildAdjacency(ends, links);
    this.prepare(ends, links, graph.placementCount);
    for (let root = 0; root < ends; root++) {
      if (this.discovered[root] === UNVISITED) this.searchFrom(root);
    }
    return this.result();
  }

  private collectLinks(graph: ReversingTopology): number {
    const routes = graph.edgeFromEnd.length >> 1;
    const ends = graph.endPartner.length;
    let joins = 0;
    for (let end = 0; end < ends; end++) {
      if ((graph.endPartner[end] ?? NO_END) > end) joins++;
    }
    const total = routes + joins;
    this.linkA = room(this.linkA, total);
    this.linkB = room(this.linkB, total);
    this.linkPlacement = room(this.linkPlacement, total);
    for (let route = 0; route < routes; route++) {
      const edge = route << 1;
      this.linkA[route] = graph.edgeFromEnd[edge] ?? 0;
      this.linkB[route] = graph.edgeToEnd[edge] ?? 0;
      this.linkPlacement[route] = graph.edgePlacement[edge] ?? NO_PLACEMENT;
    }
    let link = routes;
    for (let end = 0; end < ends; end++) {
      const partner = graph.endPartner[end] ?? NO_END;
      if (partner <= end) continue;
      this.linkA[link] = end;
      this.linkB[link] = partner;
      this.linkPlacement[link] = NO_PLACEMENT;
      link++;
    }
    return total;
  }

  private buildAdjacency(ends: number, links: number): void {
    const start = room(this.adjacencyStart, ends + 1);
    start.fill(0, 0, ends + 1);
    for (let link = 0; link < links; link++) {
      const a = this.linkA[link] ?? 0;
      const b = this.linkB[link] ?? 0;
      start[a + 1] = (start[a + 1] ?? 0) + 1;
      start[b + 1] = (start[b + 1] ?? 0) + 1;
    }
    for (let end = 0; end < ends; end++) start[end + 1] = (start[end + 1] ?? 0) + (start[end] ?? 0);
    const fill = room(this.adjacencyFill, ends);
    for (let end = 0; end < ends; end++) fill[end] = start[end] ?? 0;
    const adjacency = room(this.adjacency, 2 * links);
    for (let link = 0; link < links; link++) {
      const a = this.linkA[link] ?? 0;
      const b = this.linkB[link] ?? 0;
      adjacency[fill[a] ?? 0] = link;
      fill[a] = (fill[a] ?? 0) + 1;
      adjacency[fill[b] ?? 0] = link;
      fill[b] = (fill[b] ?? 0) + 1;
    }
    this.adjacencyStart = start;
    this.adjacencyFill = fill;
    this.adjacency = adjacency;
  }

  private prepare(ends: number, links: number, placements: number): void {
    this.discovered = room(this.discovered, ends);
    this.discovered.fill(UNVISITED, 0, ends);
    this.low = room(this.low, ends);
    this.visitOrder = UNVISITED;
    this.frameEnd = room(this.frameEnd, ends);
    this.frameLink = room(this.frameLink, ends);
    this.frameNext = room(this.frameNext, ends);
    this.frames = 0;
    this.linkStack = room(this.linkStack, links);
    this.linkBlock = room(this.linkBlock, links);
    this.linkBlock.fill(0, 0, links);
    this.endBlock = room(this.endBlock, ends);
    this.endBlock.fill(0, 0, ends);
    this.block = 0;
    this.colour = room(this.colour, ends);
    this.depth = room(this.depth, ends);
    this.treeLink = room(this.treeLink, ends);
    this.queue = room(this.queue, ends);
    if (this.placementStamp.length < placements) {
      this.placementStamp = new Int32Array(Math.max(placements, this.placementStamp.length * 2));
      this.stampNow = 0;
    }
    this.sectionCount = 0;
    this.placementTotal = 0;
    this.sectionStart[0] = 0;
  }

  private enter(end: number, link: number): void {
    const order = ++this.visitOrder;
    this.discovered[end] = order;
    this.low[end] = order;
    const frame = this.frames++;
    this.frameEnd[frame] = end;
    this.frameLink[frame] = link;
    this.frameNext[frame] = this.adjacencyStart[end] ?? 0;
  }

  private searchFrom(root: number): void {
    let stacked = 0;
    this.enter(root, NO_LINK);
    while (this.frames > 0) {
      const top = this.frames - 1;
      const end = this.frameEnd[top] ?? 0;
      const next = this.frameNext[top] ?? 0;
      if (next < (this.adjacencyStart[end + 1] ?? 0)) {
        this.frameNext[top] = next + 1;
        const link = this.adjacency[next] ?? 0;
        if (link === this.frameLink[top]) continue;
        const other = this.otherEnd(link, end);
        const seen = this.discovered[other] ?? UNVISITED;
        if (seen === UNVISITED) {
          this.linkStack[stacked++] = link;
          this.enter(other, link);
        } else if (seen < (this.discovered[end] ?? 0)) {
          this.linkStack[stacked++] = link;
          this.low[end] = Math.min(this.low[end] ?? 0, seen);
        }
        continue;
      }
      this.frames = top;
      if (top === 0) return;
      const parent = this.frameEnd[top - 1] ?? 0;
      const reached = this.low[end] ?? 0;
      this.low[parent] = Math.min(this.low[parent] ?? 0, reached);
      if (reached < (this.discovered[parent] ?? 0)) continue;
      const entered = this.frameLink[top] ?? NO_LINK;
      let first = stacked - 1;
      while (first > 0 && this.linkStack[first] !== entered) first--;
      if (stacked - first >= SHORTEST_ODD_CYCLE) this.closeBlock(first, stacked);
      stacked = first;
    }
  }

  private otherEnd(link: number, end: number): number {
    const a = this.linkA[link] ?? 0;
    return a === end ? (this.linkB[link] ?? 0) : a;
  }

  private isRoute(link: number): boolean {
    return (this.linkPlacement[link] ?? NO_PLACEMENT) !== NO_PLACEMENT;
  }

  private closeBlock(first: number, last: number): void {
    const block = ++this.block;
    let start = NO_END;
    for (let k = first; k < last; k++) {
      const link = this.linkStack[k] ?? 0;
      this.linkBlock[link] = block;
      const a = this.linkA[link] ?? 0;
      const b = this.linkB[link] ?? 0;
      const lower = Math.min(a, b);
      if (start === NO_END || lower < start) start = lower;
    }
    if (this.findTurning(block, start)) this.addSection(first, last);
  }

  private findTurning(block: number, start: number): boolean {
    this.endBlock[start] = block;
    this.colour[start] = 0;
    this.depth[start] = 0;
    this.treeLink[start] = NO_LINK;
    this.queue[0] = start;
    let head = 0;
    let tail = 1;
    while (head < tail) {
      const end = this.queue[head++] ?? 0;
      const last = this.adjacencyStart[end + 1] ?? 0;
      for (let k = this.adjacencyStart[end] ?? 0; k < last; k++) {
        const link = this.adjacency[k] ?? 0;
        if (this.linkBlock[link] !== block || link === this.treeLink[end]) continue;
        const other = this.otherEnd(link, end);
        if (this.endBlock[other] !== block) {
          this.endBlock[other] = block;
          this.colour[other] = 1 - (this.colour[end] ?? 0);
          this.depth[other] = (this.depth[end] ?? 0) + 1;
          this.treeLink[other] = link;
          this.queue[tail++] = other;
        } else if (this.colour[other] === this.colour[end]) {
          this.turning = this.turningOnCycle(end, other, link);
          return true;
        }
      }
    }
    return false;
  }

  private turningOnCycle(a: number, b: number, closing: number): number {
    let turning = NO_END;
    let atA = a;
    let atB = b;
    let intoA = closing;
    let intoB = closing;
    while (atA !== atB) {
      const climbA = (this.depth[atA] ?? 0) >= (this.depth[atB] ?? 0);
      const at = climbA ? atA : atB;
      const into = climbA ? intoA : intoB;
      const up = this.treeLink[at] ?? NO_LINK;
      if (up === NO_LINK) return a;
      turning = this.lowerTurning(turning, at, into, up);
      if (climbA) {
        intoA = up;
        atA = this.otherEnd(up, at);
      } else {
        intoB = up;
        atB = this.otherEnd(up, at);
      }
    }
    turning = this.lowerTurning(turning, atA, intoA, intoB);
    return turning === NO_END ? a : turning;
  }

  private lowerTurning(turning: number, end: number, into: number, out: number): number {
    if (!this.isRoute(into) || !this.isRoute(out)) return turning;
    return turning === NO_END || end < turning ? end : turning;
  }

  private addSection(first: number, last: number): void {
    const section = this.sectionCount++;
    this.sectionTurning = grown(this.sectionTurning, section + 1);
    this.sectionStart = grown(this.sectionStart, section + 2);
    this.sectionPlacements = grown(this.sectionPlacements, this.placementTotal + last - first);
    this.sectionTurning[section] = this.turning;
    const stamp = ++this.stampNow;
    const from = this.placementTotal;
    for (let k = first; k < last; k++) {
      const placement = this.linkPlacement[this.linkStack[k] ?? 0] ?? NO_PLACEMENT;
      if (placement === NO_PLACEMENT || this.placementStamp[placement] === stamp) continue;
      this.placementStamp[placement] = stamp;
      this.sectionPlacements[this.placementTotal++] = placement;
    }
    this.sectionPlacements.subarray(from, this.placementTotal).sort();
    this.sectionStart[section + 1] = this.placementTotal;
  }

  private result(): ReversingSections {
    const count = this.sectionCount;
    if (count === 0) return NO_REVERSING_SECTIONS;
    const turnings = this.sectionTurning;
    const order = Int32Array.from({ length: count }, (_, k) => k).toSorted(
      (a, b) => (turnings[a] ?? 0) - (turnings[b] ?? 0),
    );
    const turningEnd = new Int32Array(count);
    const placementStart = new Int32Array(count + 1);
    const placements = new Int32Array(this.placementTotal);
    let written = 0;
    for (let k = 0; k < count; k++) {
      const section = order[k] ?? 0;
      turningEnd[k] = turnings[section] ?? 0;
      const from = this.sectionStart[section] ?? 0;
      const to = this.sectionStart[section + 1] ?? 0;
      placements.set(this.sectionPlacements.subarray(from, to), written);
      written += to - from;
      placementStart[k + 1] = written;
    }
    return new ReversingSections(turningEnd, placementStart, placements);
  }
}
