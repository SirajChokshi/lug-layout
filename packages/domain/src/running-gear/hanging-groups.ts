export interface GraphEdge {
  readonly a: number;
  readonly b: number;
}

export interface HangingGroup {
  readonly members: ReadonlyArray<number>;
  readonly joins: ReadonlyArray<number>;
}

const UNSEEN = -1;
const NO_PARENT = -1;

interface Adjacency {
  readonly offsets: Int32Array;
  readonly node: Int32Array;
  readonly edge: Int32Array;
}

function adjacency(nodes: number, edges: ReadonlyArray<GraphEdge>): Adjacency {
  const offsets = new Int32Array(nodes + 1);
  for (const { a, b } of edges) {
    if (a === b) continue;
    offsets[a + 1] = (offsets[a + 1] ?? 0) + 1;
    offsets[b + 1] = (offsets[b + 1] ?? 0) + 1;
  }
  for (let n = 0; n < nodes; n++) offsets[n + 1] = (offsets[n + 1] ?? 0) + (offsets[n] ?? 0);
  const fill = offsets.slice(0, nodes);
  const node = new Int32Array(offsets[nodes] ?? 0);
  const edge = new Int32Array(node.length);
  edges.forEach(({ a, b }, e) => {
    if (a === b) return;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const at = fill[from] ?? 0;
      node[at] = to;
      edge[at] = e;
      fill[from] = at + 1;
    }
  });
  return { offsets, node, edge };
}

export function wheelFreeHangingGroups(
  nodes: number,
  edges: ReadonlyArray<GraphEdge>,
  wheelsets: Int32Array,
): ReadonlyArray<ReadonlyArray<HangingGroup>> {
  const { offsets, node, edge } = adjacency(nodes, edges);
  const disc = new Int32Array(nodes).fill(UNSEEN);
  const low = new Int32Array(nodes);
  const parent = new Int32Array(nodes).fill(NO_PARENT);
  const parentEdge = new Int32Array(nodes).fill(UNSEEN);
  const size = new Int32Array(nodes);
  const subtreeWheelsets = new Int32Array(nodes);
  const order = new Int32Array(nodes);
  const cursor = new Int32Array(nodes);
  const stack = new Int32Array(nodes);
  const groups: HangingGroup[][] = Array.from({ length: nodes }, () => []);
  let time = 0;
  for (let root = 0; root < nodes; root++) {
    if (disc[root] !== UNSEEN) continue;
    const start = time;
    let depth = 0;
    stack[depth++] = root;
    disc[root] = time;
    low[root] = time;
    order[time++] = root;
    cursor[root] = offsets[root] ?? 0;
    while (depth > 0) {
      const v = stack[depth - 1] ?? 0;
      const at = cursor[v] ?? 0;
      if (at < (offsets[v + 1] ?? 0)) {
        cursor[v] = at + 1;
        const w = node[at] ?? 0;
        const e = edge[at] ?? 0;
        if (disc[w] === UNSEEN) {
          parent[w] = v;
          parentEdge[w] = e;
          disc[w] = time;
          low[w] = time;
          order[time++] = w;
          cursor[w] = offsets[w] ?? 0;
          stack[depth++] = w;
        } else if (e !== parentEdge[v]) {
          low[v] = Math.min(low[v] ?? 0, disc[w] ?? 0);
        }
        continue;
      }
      depth--;
      size[v] = (size[v] ?? 0) + 1;
      subtreeWheelsets[v] = (subtreeWheelsets[v] ?? 0) + (wheelsets[v] ?? 0);
      const p = parent[v] ?? NO_PARENT;
      if (p !== NO_PARENT) {
        low[p] = Math.min(low[p] ?? 0, low[v] ?? 0);
        size[p] = (size[p] ?? 0) + (size[v] ?? 0);
        subtreeWheelsets[p] = (subtreeWheelsets[p] ?? 0) + (subtreeWheelsets[v] ?? 0);
      }
    }
    const componentWheelsets = subtreeWheelsets[root] ?? 0;
    for (let k = start; k < time; k++) {
      const s = order[k] ?? 0;
      if ((wheelsets[s] ?? 0) === 0) continue;
      const hanging: number[] = [];
      let otherWheelsets = 0;
      for (let at = offsets[s] ?? 0; at < (offsets[s + 1] ?? 0); at++) {
        const c = node[at] ?? 0;
        if (parent[c] !== s || parentEdge[c] !== edge[at]) continue;
        if ((low[c] ?? 0) >= (disc[s] ?? 0)) hanging.push(c);
        else otherWheelsets += subtreeWheelsets[c] ?? 0;
      }
      const inSubtree = (n: number, c: number) =>
        (disc[n] ?? 0) >= (disc[c] ?? 0) && (disc[n] ?? 0) < (disc[c] ?? 0) + (size[c] ?? 0);
      const joinsInto = (test: (n: number) => boolean): number[] => {
        const joins: number[] = [];
        for (let at = offsets[s] ?? 0; at < (offsets[s + 1] ?? 0); at++) {
          if (test(node[at] ?? 0)) joins.push(edge[at] ?? 0);
        }
        return [...new Set(joins)];
      };
      for (const c of hanging) {
        if ((subtreeWheelsets[c] ?? 0) !== 0) continue;
        const begin = disc[c] ?? 0;
        groups[s]?.push({
          members: Array.from(order.subarray(begin, begin + (size[c] ?? 0))),
          joins: joinsInto((n) => inSubtree(n, c)),
        });
      }
      if (parent[s] === NO_PARENT) continue;
      const parentSide = componentWheelsets - (subtreeWheelsets[s] ?? 0) + otherWheelsets;
      if (parentSide !== 0) continue;
      const outside = (n: number) => n !== s && !hanging.some((c) => inSubtree(n, c));
      const members: number[] = [];
      for (let j = start; j < time; j++) {
        const n = order[j] ?? 0;
        if (outside(n)) members.push(n);
      }
      groups[s]?.push({ members, joins: joinsInto(outside) });
    }
  }
  return groups;
}
