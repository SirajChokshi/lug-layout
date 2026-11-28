import { chunkOf } from "@brr/math";
import { NO_EDGE } from "../track/track-graph.ts";
import { pointOnSegment, wrapAngle } from "./route-geometry.ts";
import type { PathSampler } from "./running-gear.ts";
import { trackLift, trackPoint, type SimTrack } from "./sim-track.ts";

export const RAIL_SPOT_FLOATS = 3;
export const SPOT_EDGE = 0;
export const SPOT_OFFSET = 1;
export const SPOT_DISTANCE = 2;

const FULL_TURN = 2 * Math.PI;
const QUARTER_TURN = Math.PI / 2;
const ROUNDING_FACTOR = 2 ** -32;
const QUERY_X = 0;
const QUERY_Z = 1;
const QUERY_RADIUS = 2;
const QUERY_GAP = 3;
const QUERY_FLOATS = 4;

export class RailNetwork {
  private diskIndex: SegmentDiskIndex | null = null;

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

  lift(edge: number, io: Float64Array, at: number): void {
    trackLift(this.track, edge, io, at);
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

  nearDisk(x: number, z: number, radius: number, gap: number): boolean {
    this.diskIndex ??= new SegmentDiskIndex(this.track);
    return this.diskIndex.nearDisk(x, z, radius, gap);
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
    return planDistance(x0 + s * Math.cos(heading) - x, z0 + s * Math.sin(heading) - z);
  }
  const turned = heading + curvature * s;
  const px = x0 + (Math.sin(turned) - Math.sin(heading)) / curvature;
  const pz = z0 - (Math.cos(turned) - Math.cos(heading)) / curvature;
  return planDistance(px - x, pz - z);
}

function planDistance(dx: number, dz: number): number {
  return Math.sqrt(dx * dx + dz * dz);
}

function forwardSegments(track: SimTrack): Int32Array {
  let count = 0;
  for (let edge = 0; edge < track.edgeCount; edge += 2) {
    count += (track.segmentStart[edge + 1] ?? 0) - (track.segmentStart[edge] ?? 0);
  }
  const segments = new Int32Array(count);
  let at = 0;
  for (let edge = 0; edge < track.edgeCount; edge += 2) {
    const first = track.segmentStart[edge] ?? 0;
    const end = track.segmentStart[edge + 1] ?? first;
    for (let i = first; i < end; i++) segments[at++] = i;
  }
  return segments;
}

function segmentErrorScale(track: SimTrack, segment: number): number {
  const curvature = track.segmentCurvature[segment] ?? 0;
  const length = track.segmentLength[segment] ?? 0;
  const turning =
    curvature === 0
      ? 0
      : (Math.abs(track.segmentHeading[segment] ?? 0) + Math.abs(curvature * length) + 1) /
        Math.abs(curvature);
  return (
    Math.abs(track.segmentX[segment] ?? 0) +
    Math.abs(track.segmentZ[segment] ?? 0) +
    length +
    turning +
    1
  );
}

interface DiskBuckets {
  readonly chunkX: Int32Array;
  readonly chunkZ: Int32Array;
  readonly starts: Int32Array;
  readonly members: Int32Array;
}

function chunksAcross(centre: number, extent: number): number {
  return chunkOf(centre + extent) - chunkOf(centre - extent) + 1;
}

function bucketDisks(
  centreX: Float64Array,
  centreZ: Float64Array,
  radius: Float64Array,
  allowance: number,
): DiskBuckets {
  let entries = 0;
  for (let d = 0; d < radius.length; d++) {
    const extent = (radius[d] ?? 0) + allowance;
    entries += chunksAcross(centreX[d] ?? 0, extent) * chunksAcross(centreZ[d] ?? 0, extent);
  }
  const entryX = new Int32Array(entries);
  const entryZ = new Int32Array(entries);
  const entryDisk = new Int32Array(entries);
  let at = 0;
  for (let d = 0; d < radius.length; d++) {
    const extent = (radius[d] ?? 0) + allowance;
    const fromX = chunkOf((centreX[d] ?? 0) - extent);
    const toX = chunkOf((centreX[d] ?? 0) + extent);
    const fromZ = chunkOf((centreZ[d] ?? 0) - extent);
    const toZ = chunkOf((centreZ[d] ?? 0) + extent);
    for (let x = fromX; x <= toX; x++) {
      for (let z = fromZ; z <= toZ; z++) {
        entryX[at] = x;
        entryZ[at] = z;
        entryDisk[at++] = d;
      }
    }
  }
  const order = new Int32Array(entries);
  for (let e = 0; e < entries; e++) order[e] = e;
  order.sort(
    (a, b) =>
      (entryX[a] ?? 0) - (entryX[b] ?? 0) ||
      (entryZ[a] ?? 0) - (entryZ[b] ?? 0) ||
      (entryDisk[a] ?? 0) - (entryDisk[b] ?? 0),
  );
  let distinct = 0;
  for (let e = 0; e < entries; e++) {
    const entry = order[e] ?? 0;
    const previous = order[e - 1] ?? 0;
    if (e === 0 || entryX[entry] !== entryX[previous] || entryZ[entry] !== entryZ[previous]) {
      distinct++;
    }
  }
  const chunkX = new Int32Array(distinct);
  const chunkZ = new Int32Array(distinct);
  const starts = new Int32Array(distinct + 1);
  const members = new Int32Array(entries);
  let bucket = -1;
  for (let e = 0; e < entries; e++) {
    const entry = order[e] ?? 0;
    const x = entryX[entry] ?? 0;
    const z = entryZ[entry] ?? 0;
    if (bucket < 0 || chunkX[bucket] !== x || chunkZ[bucket] !== z) {
      bucket++;
      chunkX[bucket] = x;
      chunkZ[bucket] = z;
      starts[bucket] = e;
    }
    members[e] = entryDisk[entry] ?? 0;
  }
  starts[distinct] = entries;
  return { chunkX, chunkZ, starts, members };
}

class SegmentDiskIndex {
  private readonly segments: Int32Array;
  private readonly centreX: Float64Array;
  private readonly centreZ: Float64Array;
  private readonly radius: Float64Array;
  private readonly errorScale: number;
  private readonly chunkX: Int32Array;
  private readonly chunkZ: Int32Array;
  private readonly starts: Int32Array;
  private readonly members: Int32Array;
  private readonly query = new Float64Array(QUERY_FLOATS);
  private readonly visited: Uint32Array;
  private visit = 0;

  constructor(private readonly track: SimTrack) {
    this.segments = forwardSegments(track);
    const count = this.segments.length;
    this.centreX = new Float64Array(count);
    this.centreZ = new Float64Array(count);
    this.radius = new Float64Array(count);
    this.visited = new Uint32Array(count);
    let largest = 0;
    for (let d = 0; d < count; d++) {
      const segment = this.segments[d] ?? 0;
      this.enclose(d, segment);
      largest = Math.max(largest, segmentErrorScale(track, segment));
    }
    this.errorScale = largest;
    const buckets = bucketDisks(this.centreX, this.centreZ, this.radius, ROUNDING_FACTOR * largest);
    this.chunkX = buckets.chunkX;
    this.chunkZ = buckets.chunkZ;
    this.starts = buckets.starts;
    this.members = buckets.members;
  }

  nearDisk(x: number, z: number, radius: number, gap: number): boolean {
    const query = this.query;
    query[QUERY_X] = x;
    query[QUERY_Z] = z;
    query[QUERY_RADIUS] = radius;
    query[QUERY_GAP] = gap;
    return this.answerQuery();
  }

  private answerQuery(): boolean {
    const { track, chunkX: xs, chunkZ: zs, starts, members, query, visited } = this;
    this.visit = (this.visit + 1) >>> 0;
    if (this.visit === 0) {
      visited.fill(0);
      this.visit = 1;
    }
    const visit = this.visit;
    const x = query[QUERY_X] ?? 0;
    const z = query[QUERY_Z] ?? 0;
    const radius = query[QUERY_RADIUS] ?? 0;
    const gap = query[QUERY_GAP] ?? 0;
    const extent =
      radius +
      gap +
      ROUNDING_FACTOR * (this.errorScale + Math.abs(x) + Math.abs(z) + radius + gap + 1);
    const fromX = chunkOf(x - extent);
    const toX = chunkOf(x + extent);
    const fromZ = chunkOf(z - extent);
    const toZ = chunkOf(z + extent);
    for (let chunkX = fromX; chunkX <= toX; chunkX++) {
      for (
        let bucket = this.firstBucket(chunkX, fromZ);
        bucket < xs.length && xs[bucket] === chunkX && (zs[bucket] ?? 0) <= toZ;
        bucket++
      ) {
        const to = starts[bucket + 1] ?? 0;
        for (let m = starts[bucket] ?? 0; m < to; m++) {
          const d = members[m] ?? 0;
          if (visited[d] === visit) continue;
          visited[d] = visit;
          const centreDistance = planDistance(
            x - (this.centreX[d] ?? 0),
            z - (this.centreZ[d] ?? 0),
          );
          if (centreDistance >= (this.radius[d] ?? 0) + extent) continue;
          const segment = this.segments[d] ?? 0;
          const s = nearestOnSegment(
            track.segmentX[segment] ?? 0,
            track.segmentZ[segment] ?? 0,
            track.segmentHeading[segment] ?? 0,
            track.segmentCurvature[segment] ?? 0,
            track.segmentLength[segment] ?? 0,
            x,
            z,
          );
          if (segmentDistance(track, segment, s, x, z) - radius < gap) return true;
        }
      }
    }
    return false;
  }

  private firstBucket(chunkX: number, chunkZ: number): number {
    const { chunkX: xs, chunkZ: zs } = this;
    let low = 0;
    let high = xs.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const x = xs[mid] ?? 0;
      if (x < chunkX || (x === chunkX && (zs[mid] ?? 0) < chunkZ)) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private enclose(d: number, segment: number): void {
    const track = this.track;
    const x0 = track.segmentX[segment] ?? 0;
    const z0 = track.segmentZ[segment] ?? 0;
    const heading = track.segmentHeading[segment] ?? 0;
    const curvature = track.segmentCurvature[segment] ?? 0;
    const length = track.segmentLength[segment] ?? 0;
    if (curvature !== 0 && Math.abs(curvature * length) > QUARTER_TURN) {
      this.centreX[d] = x0 - Math.sin(heading) / curvature;
      this.centreZ[d] = z0 + Math.cos(heading) / curvature;
      this.radius[d] = 1 / Math.abs(curvature);
      return;
    }
    const end = pointOnSegment({ x: x0, z: z0, heading, curvature, length }, length);
    this.centreX[d] = (x0 + end.x) / 2;
    this.centreZ[d] = (z0 + end.z) / 2;
    this.radius[d] = planDistance(end.x - x0, end.z - z0) / 2;
  }
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
    this.network.point(this.edgeBehind(io, at), io, at);
  }

  liftBehind(io: Float64Array, at: number): void {
    this.network.lift(this.edgeBehind(io, at), io, at);
  }

  private edgeBehind(io: Float64Array, at: number): number {
    let i = 0;
    let edge = this.edges[0] ?? 0;
    let offset = this.headOffset - (io[at] ?? 0);
    while (offset < 0 && i + 1 < this.count) {
      i++;
      edge = this.edges[i] ?? 0;
      offset += this.network.edgeLength(edge);
    }
    io[at] = Math.max(offset, 0);
    return edge;
  }
}
