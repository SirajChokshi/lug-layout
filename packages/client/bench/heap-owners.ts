const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const NODES_MARKER = '"nodes":[';
const EDGES_MARKER = '"edges":[';
const STRINGS_MARKER = '"strings":[';
const NO_PARENT = -1;
const ROOT_NODE = 0;

interface SnapshotMeta {
  readonly node_fields: ReadonlyArray<string>;
  readonly node_types: readonly [ReadonlyArray<string>, ...unknown[]];
  readonly edge_fields: ReadonlyArray<string>;
  readonly edge_types: readonly [ReadonlyArray<string>, ...unknown[]];
}

interface SnapshotHeader {
  readonly snapshot: {
    readonly meta: SnapshotMeta;
    readonly node_count: number;
    readonly edge_count: number;
  };
}

class IntReader {
  constructor(
    private readonly bytes: Buffer,
    private position: number,
  ) {}

  get at(): number {
    return this.position;
  }

  next(): number {
    const bytes = this.bytes;
    let b = bytes[this.position] ?? CLOSE_BRACKET;
    while (b < DIGIT_ZERO || b > DIGIT_NINE) {
      if (b === CLOSE_BRACKET) throw new Error(`heap snapshot array ended at ${this.position}`);
      this.position++;
      b = bytes[this.position] ?? CLOSE_BRACKET;
    }
    let value = 0;
    while (b >= DIGIT_ZERO && b <= DIGIT_NINE) {
      value = value * 10 + (b - DIGIT_ZERO);
      this.position++;
      b = bytes[this.position] ?? CLOSE_BRACKET;
    }
    return value;
  }
}

class HeapGraph {
  constructor(
    readonly nodeTypes: ReadonlyArray<string>,
    readonly edgeTypes: ReadonlyArray<string>,
    readonly strings: ReadonlyArray<string>,
    readonly type: Uint8Array,
    readonly name: Uint32Array,
    readonly selfSize: Float64Array,
    readonly firstEdge: Uint32Array,
    readonly edgeType: Uint8Array,
    readonly edgeName: Uint32Array,
    readonly edgeTo: Uint32Array,
  ) {}

  get nodeCount(): number {
    return this.type.length;
  }

  typeOf(node: number): string {
    return this.nodeTypes[this.type[node] ?? 0] ?? "";
  }

  nameOf(node: number): string {
    return this.strings[this.name[node] ?? 0] ?? "";
  }

  fieldName(edge: number): string | undefined {
    const kind = this.edgeTypes[this.edgeType[edge] ?? 0];
    if (kind === "element" || kind === "hidden") return undefined;
    return this.strings[this.edgeName[edge] ?? 0];
  }
}

function markerAt(bytes: Buffer, marker: string, from: number): number {
  const at = bytes.indexOf(marker, from, "latin1");
  if (at < 0) throw new Error(`heap snapshot has no ${marker}`);
  return at + marker.length;
}

export function parseHeapSnapshot(bytes: Buffer): HeapGraph {
  const nodesAt = markerAt(bytes, NODES_MARKER, 0);
  const headerText = bytes.toString("utf8", 0, nodesAt - NODES_MARKER.length).trim();
  const header: SnapshotHeader = JSON.parse(`${headerText.replace(/,$/u, "")}}`);
  const { meta, node_count: nodeCount, edge_count: edgeCount } = header.snapshot;
  const nodeFields = meta.node_fields.length;
  const edgeFields = meta.edge_fields.length;
  const typeField = meta.node_fields.indexOf("type");
  const nameField = meta.node_fields.indexOf("name");
  const sizeField = meta.node_fields.indexOf("self_size");
  const edgeCountField = meta.node_fields.indexOf("edge_count");
  const edgeTypeField = meta.edge_fields.indexOf("type");
  const edgeNameField = meta.edge_fields.indexOf("name_or_index");
  const edgeToField = meta.edge_fields.indexOf("to_node");

  const type = new Uint8Array(nodeCount);
  const name = new Uint32Array(nodeCount);
  const selfSize = new Float64Array(nodeCount);
  const firstEdge = new Uint32Array(nodeCount + 1);
  const nodes = new IntReader(bytes, nodesAt);
  for (let n = 0; n < nodeCount; n++) {
    let edges = 0;
    for (let f = 0; f < nodeFields; f++) {
      const value = nodes.next();
      if (f === typeField) type[n] = value;
      else if (f === nameField) name[n] = value;
      else if (f === sizeField) selfSize[n] = value;
      else if (f === edgeCountField) edges = value;
    }
    firstEdge[n + 1] = (firstEdge[n] ?? 0) + edges;
  }

  const edgeType = new Uint8Array(edgeCount);
  const edgeName = new Uint32Array(edgeCount);
  const edgeTo = new Uint32Array(edgeCount);
  const edges = new IntReader(bytes, markerAt(bytes, EDGES_MARKER, nodes.at));
  for (let e = 0; e < edgeCount; e++) {
    for (let f = 0; f < edgeFields; f++) {
      const value = edges.next();
      if (f === edgeTypeField) edgeType[e] = value;
      else if (f === edgeNameField) edgeName[e] = value;
      else if (f === edgeToField) edgeTo[e] = value / nodeFields;
    }
  }

  const stringsAt = markerAt(bytes, STRINGS_MARKER, edges.at) - 1;
  const stringsEnd = bytes.lastIndexOf(CLOSE_BRACKET);
  if (bytes[stringsAt] !== OPEN_BRACKET) throw new Error("heap snapshot strings are malformed");
  const strings: string[] = JSON.parse(bytes.toString("utf8", stringsAt, stringsEnd + 1));
  return new HeapGraph(
    meta.node_types[0],
    meta.edge_types[0],
    strings,
    type,
    name,
    selfSize,
    firstEdge,
    edgeType,
    edgeName,
    edgeTo,
  );
}

export interface OwnerRules {
  readonly byClass: ReadonlyMap<string, string>;
  readonly byField: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly unowned: string;
}

export interface OwnerTally {
  readonly bytes: ReadonlyMap<string, number>;
  readonly objects: ReadonlyMap<string, number>;
}

function spanningTree(graph: HeapGraph): {
  parent: Int32Array;
  viaEdge: Int32Array;
  order: Uint32Array;
} {
  const count = graph.nodeCount;
  const weak = graph.edgeTypes.indexOf("weak");
  const parent = new Int32Array(count).fill(NO_PARENT);
  const viaEdge = new Int32Array(count).fill(NO_PARENT);
  const order = new Uint32Array(count);
  const seen = new Uint8Array(count);
  let head = 0;
  let tail = 0;
  order[tail++] = ROOT_NODE;
  seen[ROOT_NODE] = 1;
  while (head < tail) {
    const node = order[head++] ?? 0;
    const end = graph.firstEdge[node + 1] ?? 0;
    for (let e = graph.firstEdge[node] ?? 0; e < end; e++) {
      if (graph.edgeType[e] === weak) continue;
      const to = graph.edgeTo[e] ?? 0;
      if (seen[to] === 1) continue;
      seen[to] = 1;
      parent[to] = node;
      viaEdge[to] = e;
      order[tail++] = to;
    }
  }
  return { parent, viaEdge, order: order.subarray(0, tail) };
}

export function tallyOwners(graph: HeapGraph, rules: OwnerRules): OwnerTally {
  const { parent, viaEdge, order } = spanningTree(graph);
  const owners: string[] = [rules.unowned];
  const ownerIndex = new Map<string, number>([[rules.unowned, 0]]);
  const indexOf = (owner: string): number => {
    let index = ownerIndex.get(owner);
    if (index === undefined) {
      index = owners.push(owner) - 1;
      ownerIndex.set(owner, index);
    }
    return index;
  };
  const ownerOf = new Uint16Array(graph.nodeCount);
  const bytes = new Float64Array(graph.nodeCount > 0 ? 64 : 0);
  const objects = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    const node = order[i] ?? 0;
    const up = parent[node] ?? NO_PARENT;
    const inherited = up === NO_PARENT ? 0 : (ownerOf[up] ?? 0);
    const fieldName = up === NO_PARENT ? undefined : graph.fieldName(viaEdge[node] ?? 0);
    const fieldOwner =
      fieldName === undefined ? undefined : rules.byField.get(graph.nameOf(up))?.get(fieldName);
    const classOwner =
      graph.typeOf(node) === "object" ? rules.byClass.get(graph.nameOf(node)) : undefined;
    let owner = inherited;
    if (fieldOwner !== undefined) owner = indexOf(fieldOwner);
    else if (inherited === 0 && classOwner !== undefined) owner = indexOf(classOwner);
    ownerOf[node] = owner;
    bytes[owner] = (bytes[owner] ?? 0) + (graph.selfSize[node] ?? 0);
    if (graph.typeOf(node) === "object") {
      const className = graph.nameOf(node);
      objects.set(className, (objects.get(className) ?? 0) + 1);
    }
  }
  const byOwner = new Map<string, number>();
  for (let o = 0; o < owners.length; o++) {
    byOwner.set(owners[o] ?? rules.unowned, bytes[o] ?? 0);
  }
  return { bytes: byOwner, objects };
}
