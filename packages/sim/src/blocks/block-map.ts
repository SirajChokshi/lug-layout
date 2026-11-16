import { NO_END, NO_SWITCH, type TrackGraph } from "@brr/domain";

export const NO_BLOCK = -1;

function findRoot(parent: Int32Array, node: number): number {
  let root = node;
  while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
  let walk = node;
  while (walk !== root) {
    const next = parent[walk] ?? root;
    parent[walk] = root;
    walk = next;
  }
  return root;
}

export class BlockMap {
  readonly blockCount: number;
  readonly placementBlock: Int32Array;
  readonly placementSwitch: Int32Array;
  readonly blockIsJunction: Uint8Array;
  readonly blockLengthLdu: Float64Array;

  constructor(
    readonly graph: TrackGraph,
    readonly edgeLengthLdu: Float64Array,
  ) {
    const placements = graph.placementCount;
    const routeCount = new Int32Array(placements);
    for (let edge = 0; edge < graph.edgeCount; edge += 2) {
      const placement = graph.edgePlacement[edge] ?? 0;
      routeCount[placement] = (routeCount[placement] ?? 0) + 1;
    }
    const junction = (placement: number): boolean => (routeCount[placement] ?? 0) > 1;
    const parent = new Int32Array(placements);
    for (let p = 0; p < placements; p++) parent[p] = p;
    for (let end = 0; end < graph.endCount; end++) {
      const partner = graph.endPartner[end] ?? NO_END;
      if (partner === NO_END || partner < end) continue;
      const a = graph.endPlacement[end] ?? 0;
      const b = graph.endPlacement[partner] ?? 0;
      if (junction(a) || junction(b)) continue;
      parent[findRoot(parent, a)] = findRoot(parent, b);
    }
    this.placementBlock = new Int32Array(placements).fill(NO_BLOCK);
    const rootBlock = new Int32Array(placements).fill(NO_BLOCK);
    let blocks = 0;
    for (let p = 0; p < placements; p++) {
      const root = findRoot(parent, p);
      if (rootBlock[root] === NO_BLOCK) rootBlock[root] = blocks++;
      this.placementBlock[p] = rootBlock[root] ?? NO_BLOCK;
    }
    this.blockCount = blocks;
    this.blockIsJunction = new Uint8Array(blocks);
    this.blockLengthLdu = new Float64Array(blocks);
    for (let p = 0; p < placements; p++) {
      if (junction(p)) this.blockIsJunction[this.placementBlock[p] ?? 0] = 1;
    }
    for (let edge = 0; edge < graph.edgeCount; edge += 2) {
      const block = this.edgeBlock(edge);
      this.blockLengthLdu[block] = (this.blockLengthLdu[block] ?? 0) + (edgeLengthLdu[edge] ?? 0);
    }
    this.placementSwitch = new Int32Array(placements).fill(NO_SWITCH);
    for (let s = 0; s < graph.switchCount; s++) {
      this.placementSwitch[graph.endPlacement[graph.switchEnd[s] ?? 0] ?? 0] = s;
    }
  }

  edgeBlock(edge: number): number {
    return this.placementBlock[this.graph.edgePlacement[edge] ?? 0] ?? NO_BLOCK;
  }

  edgeSwitchSetting(edge: number): number {
    return this.placementSwitch[this.graph.edgePlacement[edge] ?? 0] ?? NO_SWITCH;
  }
}
