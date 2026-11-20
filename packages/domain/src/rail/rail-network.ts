import { NO_EDGE } from "../track/track-graph.ts";
import { wrapAngle } from "./route-geometry.ts";
import type { PathSampler } from "./running-gear.ts";
import { trackPoint, type SimTrack } from "./sim-track.ts";

export const RAIL_SPOT_FLOATS = 3;
export const SPOT_EDGE = 0;
export const SPOT_OFFSET = 1;
export const SPOT_DISTANCE = 2;

const FULL_TURN = 2 * Math.PI;

export class RailNetwork {
  constructor(
    private readonly track: SimTrack,
    private readonly switchStates: Uint8Array,
  ) {}

  get edgeCount(): number {
    return this.track.edgeCount;
  }

  edgeLength(edge: number): number {
    return this.track.edgeLength[edge] ?? 0;
  }

  successor(edge: number): number {
    const start = this.track.successorStart[edge] ?? 0;
    const count = (this.track.successorStart[edge + 1] ?? start) - start;
    if (count === 0) return NO_EDGE;
    if (count === 1) return this.track.successors[start] ?? NO_EDGE;
    const control = this.track.switchOfEdge[edge] ?? 0;
    const choice = Math.min(this.switchStates[control] ?? 0, count - 1);
    return this.track.successors[start + choice] ?? NO_EDGE;
  }

  predecessor(edge: number): number {
    const behind = this.successor(edge ^ 1);
    return behind === NO_EDGE ? NO_EDGE : behind ^ 1;
  }

  point(edge: number, io: Float64Array, at: number): void {
    trackPoint(this.track, edge, io, at);
  }

  nearest(x: number, z: number, out: Float64Array): boolean {
    let best = Number.POSITIVE_INFINITY;
    const track = this.track;
    for (let edge = 0; edge < track.edgeCount; edge += 2) {
      const first = track.segmentStart[edge] ?? 0;
      const end = track.segmentStart[edge + 1] ?? first;
      let along = 0;
      for (let i = first; i < end; i++) {
        const length = track.segmentLength[i] ?? 0;
        const s = nearestOnSegment(
          track.segmentX[i] ?? 0,
          track.segmentZ[i] ?? 0,
          track.segmentHeading[i] ?? 0,
          track.segmentCurvature[i] ?? 0,
          length,
          x,
          z,
        );
        const distance = segmentDistance(track, i, s, x, z);
        if (distance < best) {
          best = distance;
          out[SPOT_EDGE] = edge;
          out[SPOT_OFFSET] = along + s;
          out[SPOT_DISTANCE] = distance;
        }
        along += length;
      }
    }
    return best < Number.POSITIVE_INFINITY;
  }

  advance(edge: number, offset: number, distance: number, out: Float64Array): number {
    let current = edge;
    let at = offset + distance;
    let length = this.edgeLength(current);
    while (at > length) {
      const next = this.successor(current);
      if (next === NO_EDGE) {
        out[SPOT_EDGE] = current;
        out[SPOT_OFFSET] = length;
        return distance - (at - length);
      }
      at -= length;
      current = next;
      length = this.edgeLength(current);
    }
    out[SPOT_EDGE] = current;
    out[SPOT_OFFSET] = at;
    return distance;
  }

  reachBehind(edge: number, offset: number, limit: number): number {
    let covered = offset;
    let current = edge;
    while (covered < limit) {
      const behind = this.predecessor(current);
      if (behind === NO_EDGE) return covered;
      current = behind;
      covered += this.edgeLength(current);
    }
    return covered;
  }

  seat(edge: number, offset: number, lengthLdu: number, out: Float64Array): boolean {
    const ahead = this.advance(edge, offset, lengthLdu / 2, out);
    const short = lengthLdu - ahead - this.reachBehind(edge, offset, lengthLdu - ahead);
    if (short > 0) this.advance(out[SPOT_EDGE] ?? edge, out[SPOT_OFFSET] ?? 0, short, out);
    const headEdge = out[SPOT_EDGE] ?? edge;
    const headOffset = out[SPOT_OFFSET] ?? 0;
    return (
      this.headFits(headEdge, Math.floor(headOffset), lengthLdu, out) ||
      this.headFits(headEdge, Math.ceil(headOffset), lengthLdu, out)
    );
  }

  private headFits(edge: number, offset: number, lengthLdu: number, out: Float64Array): boolean {
    if (offset > this.edgeLength(edge)) return false;
    if (this.reachBehind(edge, offset, lengthLdu) < lengthLdu) return false;
    out[SPOT_EDGE] = edge;
    out[SPOT_OFFSET] = offset;
    return true;
  }
}

function nearestOnSegment(
  x0: number,
  z0: number,
  heading: number,
  curvature: number,
  length: number,
  x: number,
  z: number,
): number {
  if (curvature === 0) {
    const along = (x - x0) * Math.cos(heading) + (z - z0) * Math.sin(heading);
    return Math.min(Math.max(along, 0), length);
  }
  const cx = x0 - Math.sin(heading) / curvature;
  const cz = z0 + Math.cos(heading) / curvature;
  const start = Math.atan2(z0 - cz, x0 - cx);
  const turn = wrapAngle(Math.atan2(z - cz, x - cx) - start);
  const sweep = curvature > 0 ? (turn + FULL_TURN) % FULL_TURN : -((FULL_TURN - turn) % FULL_TURN);
  const s = sweep / curvature;
  if (s <= length) return s;
  const pastEnd = s - length;
  const beforeStart = FULL_TURN / Math.abs(curvature) - s;
  return pastEnd < beforeStart ? length : 0;
}

function segmentDistance(
  track: SimTrack,
  segment: number,
  s: number,
  x: number,
  z: number,
): number {
  const x0 = track.segmentX[segment] ?? 0;
  const z0 = track.segmentZ[segment] ?? 0;
  const heading = track.segmentHeading[segment] ?? 0;
  const curvature = track.segmentCurvature[segment] ?? 0;
  if (curvature === 0) {
    return Math.hypot(x0 + s * Math.cos(heading) - x, z0 + s * Math.sin(heading) - z);
  }
  const turned = heading + curvature * s;
  const px = x0 + (Math.sin(turned) - Math.sin(heading)) / curvature;
  const pz = z0 - (Math.cos(turned) - Math.cos(heading)) / curvature;
  return Math.hypot(px - x, pz - z);
}

export class RailRun implements PathSampler {
  private readonly edges: Int32Array;
  private count = 0;
  private headOffset = 0;

  constructor(private readonly network: RailNetwork) {
    this.edges = new Int32Array(network.edgeCount / 2 + 1);
  }

  get edgeCount(): number {
    return this.count;
  }

  edge(index: number): number {
    return this.edges[index] ?? NO_EDGE;
  }

  standAt(edge: number, offset: number, lengthLdu: number): boolean {
    this.count = 0;
    this.headOffset = offset;
    let current = edge;
    let covered = offset;
    this.edges[this.count++] = current;
    while (covered < lengthLdu) {
      const behind = this.network.predecessor(current);
      if (behind === NO_EDGE || this.holdsRoute(behind)) return false;
      current = behind;
      this.edges[this.count++] = current;
      covered += this.network.edgeLength(current);
    }
    return true;
  }

  private holdsRoute(edge: number): boolean {
    for (let i = 0; i < this.count; i++) {
      if ((this.edges[i] ?? NO_EDGE) >> 1 === edge >> 1) return true;
    }
    return this.count >= this.edges.length;
  }

  pointBehind(io: Float64Array, at: number): void {
    let i = 0;
    let edge = this.edges[0] ?? 0;
    let offset = this.headOffset - (io[at] ?? 0);
    while (offset < 0 && i + 1 < this.count) {
      i++;
      edge = this.edges[i] ?? 0;
      offset += this.network.edgeLength(edge);
    }
    io[at] = Math.max(offset, 0);
    this.network.point(edge, io, at);
  }
}
