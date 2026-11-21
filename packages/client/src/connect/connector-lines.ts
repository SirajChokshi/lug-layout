import { AXIS_FREE, axisDimension } from "@brr/domain";

const COORDINATES = 3;
const LINE_KEYS = 4;
const DIMENSION = 0;
const U = 1;
const V = 2;
const ALONG = 3;

export interface AxisConnectors {
  readonly count: number;
  readonly axis: Int8Array;
  readonly origin: Int32Array;
}

export function acrossU(dimension: number): number {
  return (dimension + 1) % COORDINATES;
}

export function acrossV(dimension: number): number {
  return (dimension + 2) % COORDINATES;
}

export class ConnectorLines {
  private constructor(
    private readonly keys: Int32Array,
    readonly connector: Int32Array,
  ) {}

  get count(): number {
    return this.connector.length;
  }

  static of(connectors: AxisConnectors): ConnectorLines {
    let count = 0;
    for (let k = 0; k < connectors.count; k++) if (connectors.axis[k] !== AXIS_FREE) count++;
    const unsorted = new Int32Array(count * LINE_KEYS);
    const connectorOf = new Int32Array(count);
    let n = 0;
    for (let k = 0; k < connectors.count; k++) {
      const axis = connectors.axis[k] ?? AXIS_FREE;
      if (axis === AXIS_FREE) continue;
      const dimension = axisDimension(axis);
      const at = n * LINE_KEYS;
      const origin = k * COORDINATES;
      unsorted[at + DIMENSION] = dimension;
      unsorted[at + U] = connectors.origin[origin + acrossU(dimension)] ?? 0;
      unsorted[at + V] = connectors.origin[origin + acrossV(dimension)] ?? 0;
      unsorted[at + ALONG] = connectors.origin[origin + dimension] ?? 0;
      connectorOf[n++] = k;
    }
    const order = Int32Array.from({ length: count }, (_, i) => i).toSorted((a, b) =>
      compareKeys(unsorted, a * LINE_KEYS, b * LINE_KEYS),
    );
    const keys = new Int32Array(count * LINE_KEYS);
    const connector = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const from = (order[i] ?? 0) * LINE_KEYS;
      keys.set(unsorted.subarray(from, from + LINE_KEYS), i * LINE_KEYS);
      connector[i] = connectorOf[order[i] ?? 0] ?? 0;
    }
    return new ConnectorLines(keys, connector);
  }

  first(dimension: number, u: number, v: number): number {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.before(middle, dimension, u, v)) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  holds(entry: number, dimension: number, u: number, v: number): boolean {
    const at = entry * LINE_KEYS;
    return (
      entry < this.count &&
      this.keys[at + DIMENSION] === dimension &&
      this.keys[at + U] === u &&
      this.keys[at + V] === v
    );
  }

  along(entry: number): number {
    return this.keys[entry * LINE_KEYS + ALONG] ?? 0;
  }

  private before(entry: number, dimension: number, u: number, v: number): boolean {
    const at = entry * LINE_KEYS;
    const d = this.keys[at + DIMENSION] ?? 0;
    if (d !== dimension) return d < dimension;
    const eu = this.keys[at + U] ?? 0;
    if (eu !== u) return eu < u;
    return (this.keys[at + V] ?? 0) < v;
  }
}

function compareKeys(keys: Int32Array, a: number, b: number): number {
  for (let k = 0; k < LINE_KEYS; k++) {
    const difference = (keys[a + k] ?? 0) - (keys[b + k] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
