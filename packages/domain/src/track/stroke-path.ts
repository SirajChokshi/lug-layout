export const PROJECTION_FLOATS = 3;
export const PROJECTED_DISTANCE = 0;
export const PROJECTED_ARC = 1;
export const PROJECTED_TANGENT = 2;

const INITIAL_POINTS = 64;

export class StrokePath {
  private xs = new Float64Array(INITIAL_POINTS);
  private zs = new Float64Array(INITIAL_POINTS);
  private arcs = new Float64Array(INITIAL_POINTS);
  private count = 1;

  constructor(
    x: number,
    z: number,
    private readonly spacingLdu: number,
  ) {
    this.xs[0] = x;
    this.zs[0] = z;
  }

  get points(): number {
    return this.count;
  }

  get length(): number {
    return this.arcs[this.count - 1] ?? 0;
  }

  get startX(): number {
    return this.xs[0] ?? 0;
  }

  get startZ(): number {
    return this.zs[0] ?? 0;
  }

  extend(x: number, z: number): void {
    const last = this.count - 1;
    const step = Math.hypot(x - (this.xs[last] ?? 0), z - (this.zs[last] ?? 0));
    if (step === 0) return;
    if (step < this.spacingLdu && last > 0) {
      this.xs[last] = x;
      this.zs[last] = z;
      const before = last - 1;
      this.arcs[last] =
        (this.arcs[before] ?? 0) +
        Math.hypot(x - (this.xs[before] ?? 0), z - (this.zs[before] ?? 0));
      return;
    }
    if (step < this.spacingLdu) return;
    this.grow();
    this.xs[this.count] = x;
    this.zs[this.count] = z;
    this.arcs[this.count] = (this.arcs[last] ?? 0) + step;
    this.count++;
  }

  private grow(): void {
    if (this.count < this.xs.length) return;
    const capacity = this.xs.length * 2;
    const xs = new Float64Array(capacity);
    const zs = new Float64Array(capacity);
    const arcs = new Float64Array(capacity);
    xs.set(this.xs);
    zs.set(this.zs);
    arcs.set(this.arcs);
    this.xs = xs;
    this.zs = zs;
    this.arcs = arcs;
  }

  private segmentAt(arc: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.arcs[mid] ?? 0) <= arc) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pointAt(arc: number, out: Float64Array): void {
    if (this.count === 1) {
      out[0] = this.xs[0] ?? 0;
      out[1] = this.zs[0] ?? 0;
      return;
    }
    const clamped = Math.min(Math.max(arc, 0), this.length);
    const i = this.segmentAt(clamped);
    const a = this.arcs[i] ?? 0;
    const span = (this.arcs[i + 1] ?? a) - a;
    const t = span > 0 ? (clamped - a) / span : 0;
    out[0] = (this.xs[i] ?? 0) + t * ((this.xs[i + 1] ?? 0) - (this.xs[i] ?? 0));
    out[1] = (this.zs[i] ?? 0) + t * ((this.zs[i + 1] ?? 0) - (this.zs[i] ?? 0));
  }

  private readonly ahead = new Float64Array(2);
  private readonly behind = new Float64Array(2);

  tangentAt(arc: number, halfSpanLdu: number): number {
    this.pointAt(arc - halfSpanLdu, this.behind);
    this.pointAt(arc + halfSpanLdu, this.ahead);
    const dx = (this.ahead[0] ?? 0) - (this.behind[0] ?? 0);
    const dz = (this.ahead[1] ?? 0) - (this.behind[1] ?? 0);
    return dx === 0 && dz === 0 ? Number.NaN : Math.atan2(dz, dx);
  }

  project(
    x: number,
    z: number,
    fromArc: number,
    toArc: number,
    tangentHalfSpanLdu: number,
    out: Float64Array,
  ): void {
    if (this.count === 1) {
      out[PROJECTED_DISTANCE] = Math.hypot(x - (this.xs[0] ?? 0), z - (this.zs[0] ?? 0));
      out[PROJECTED_ARC] = 0;
      out[PROJECTED_TANGENT] = Number.NaN;
      return;
    }
    const from = Math.min(Math.max(fromArc, 0), this.length);
    const to = Math.min(Math.max(toArc, from), this.length);
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestArc = from;
    for (let i = this.segmentAt(from); i < this.count - 1; i++) {
      const a = this.arcs[i] ?? 0;
      if (a > to) break;
      const span = (this.arcs[i + 1] ?? a) - a;
      if (span <= 0) continue;
      const ax = this.xs[i] ?? 0;
      const az = this.zs[i] ?? 0;
      const dx = ((this.xs[i + 1] ?? 0) - ax) / span;
      const dz = ((this.zs[i + 1] ?? 0) - az) / span;
      const along = (x - ax) * dx + (z - az) * dz;
      const t = Math.min(Math.max(along, from - a, 0), to - a, span);
      const distance = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestArc = a + t;
      }
    }
    out[PROJECTED_DISTANCE] = bestDistance;
    out[PROJECTED_ARC] = bestArc;
    out[PROJECTED_TANGENT] = this.tangentAt(bestArc, tangentHalfSpanLdu);
  }
}
