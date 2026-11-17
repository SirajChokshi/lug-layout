import type { PathSampler } from "../track-path/running-gear.ts";
import { trackPoint, type SimTrack } from "../track-path/sim-track.ts";

export const NO_STEP = -1;
export const TRACK_POINT_FLOATS = 3;
const POINT_EDGE = 0;
const POINT_OFFSET = 1;
const POINT_DISTANCE = 2;
const INITIAL_PATH_EDGES = 16;
const HALF_TURN = Math.PI;
const FULL_TURN = 2 * Math.PI;

export function onlySuccessor(track: SimTrack, edge: number): number {
  const start = track.successorStart[edge] ?? 0;
  const count = (track.successorStart[edge + 1] ?? 0) - start;
  return count === 1 ? (track.successors[start] ?? NO_STEP) : NO_STEP;
}

export function clearAhead(track: SimTrack, edge: number, offset: number, limit: number): number {
  let clear = (track.edgeLength[edge] ?? 0) - offset;
  let current = edge;
  while (clear < limit) {
    const next = onlySuccessor(track, current);
    if (next === NO_STEP) return clear;
    current = next;
    clear += track.edgeLength[current] ?? 0;
  }
  return clear;
}

export function clearBehind(track: SimTrack, edge: number, offset: number, limit: number): number {
  const reverse = track.reverseEdge[edge] ?? 0;
  return clearAhead(track, reverse, (track.edgeLength[edge] ?? 0) - offset, limit);
}

export function advanceAlong(
  track: SimTrack,
  edge: number,
  offset: number,
  distance: number,
  out: Float64Array,
): boolean {
  let current = edge;
  let at = offset + distance;
  let reached = true;
  while (at > (track.edgeLength[current] ?? 0)) {
    const next = onlySuccessor(track, current);
    if (next === NO_STEP) {
      at = track.edgeLength[current] ?? 0;
      reached = false;
      break;
    }
    at -= track.edgeLength[current] ?? 0;
    current = next;
  }
  out[POINT_EDGE] = current;
  out[POINT_OFFSET] = at;
  return reached;
}

function projectOnSegment(track: SimTrack, segment: number, x: number, z: number): number {
  const sx = track.segmentX[segment] ?? 0;
  const sz = track.segmentZ[segment] ?? 0;
  const heading = track.segmentHeading[segment] ?? 0;
  const k = track.segmentCurvature[segment] ?? 0;
  const length = track.segmentLength[segment] ?? 0;
  if (k === 0) {
    const s = (x - sx) * Math.cos(heading) + (z - sz) * Math.sin(heading);
    return Math.min(Math.max(s, 0), length);
  }
  const cx = sx - Math.sin(heading) / k;
  const cz = sz + Math.cos(heading) / k;
  const sign = Math.sign(k);
  const turned = Math.atan2(sign * (x - cx), -sign * (z - cz));
  let swept = sign * (turned - heading);
  swept -= FULL_TURN * Math.floor((swept + HALF_TURN) / FULL_TURN);
  return Math.min(Math.max(swept / Math.abs(k), 0), length);
}

function closerAlong(
  track: SimTrack,
  edge: number,
  along: number,
  x: number,
  z: number,
  scratch: Float64Array,
  out: Float64Array,
): void {
  trackPoint(track, edge, along, scratch, 0);
  const distance = Math.hypot((scratch[0] ?? 0) - x, (scratch[1] ?? 0) - z);
  if (distance >= (out[POINT_DISTANCE] ?? Number.POSITIVE_INFINITY)) return;
  out[POINT_EDGE] = edge;
  out[POINT_OFFSET] = along;
  out[POINT_DISTANCE] = distance;
}

export function nearestTrackPoint(
  track: SimTrack,
  x: number,
  z: number,
  radius: number,
  scratch: Float64Array,
  out: Float64Array,
): boolean {
  out[POINT_EDGE] = NO_STEP;
  out[POINT_DISTANCE] = Number.POSITIVE_INFINITY;
  for (let edge = 0; edge < track.edgeCount; edge += 2) {
    const first = track.segmentStart[edge] ?? 0;
    const last = track.segmentStart[edge + 1] ?? first;
    let before = 0;
    for (let segment = first; segment < last; segment++) {
      const length = track.segmentLength[segment] ?? 0;
      closerAlong(track, edge, before + projectOnSegment(track, segment, x, z), x, z, scratch, out);
      closerAlong(track, edge, before, x, z, scratch, out);
      closerAlong(track, edge, before + length, x, z, scratch, out);
      before += length;
    }
  }
  return (out[POINT_DISTANCE] ?? Number.POSITIVE_INFINITY) <= radius;
}

export class TrainPath implements PathSampler {
  private edges = new Int32Array(INITIAL_PATH_EDGES);
  private count = 0;
  private head = 0;

  constructor(readonly track: SimTrack) {}

  get edgeCount(): number {
    return this.count;
  }

  edge(index: number): number {
    return this.edges[index] ?? NO_STEP;
  }

  get headOffset(): number {
    return this.head;
  }

  stand(edge: number, offset: number, length: number): boolean {
    const track = this.track;
    const edgeLength = track.edgeLength[edge];
    if (edgeLength === undefined || !(offset >= 0) || offset > edgeLength) return false;
    this.count = 0;
    this.head = offset;
    this.push(edge);
    let behind = offset;
    let current = track.reverseEdge[edge] ?? 0;
    while (behind < length) {
      const next = onlySuccessor(track, current);
      if (next === NO_STEP) return false;
      current = next;
      const forward = track.reverseEdge[current] ?? 0;
      this.push(forward);
      behind += track.edgeLength[forward] ?? 0;
    }
    return true;
  }

  pointBehind(distance: number, out: Float64Array, outIndex: number): void {
    const track = this.track;
    let k = 0;
    let edge = this.edges[0] ?? 0;
    let offset = this.head - distance;
    while (offset < 0 && k + 1 < this.count) {
      k++;
      edge = this.edges[k] ?? 0;
      offset += track.edgeLength[edge] ?? 0;
    }
    trackPoint(track, edge, Math.max(offset, 0), out, outIndex);
  }

  distanceBehind(route: number, along: number): number {
    const track = this.track;
    let before = this.head;
    for (let k = 0; k < this.count; k++) {
      const edge = this.edges[k] ?? 0;
      const length = track.edgeLength[edge] ?? 0;
      if (edge >> 1 === route) {
        const position = (edge & 1) === 0 ? along : length - along;
        if (k === 0 && position <= this.head) return this.head - position;
        if (k > 0) return before + length - position;
      }
      if (k > 0) before += length;
    }
    return NO_STEP;
  }

  span(length: number, visit: (route: number, from: number, to: number) => void): void {
    const track = this.track;
    let remaining = length;
    for (let k = 0; k < this.count && remaining > 0; k++) {
      const edge = this.edges[k] ?? 0;
      const edgeLength = track.edgeLength[edge] ?? 0;
      const top = k === 0 ? this.head : edgeLength;
      const bottom = Math.max(top - remaining, 0);
      remaining -= top - bottom;
      if (top <= bottom) continue;
      const route = edge >> 1;
      if ((edge & 1) === 0) visit(route, bottom, top);
      else visit(route, edgeLength - top, edgeLength - bottom);
    }
  }

  private push(edge: number): void {
    if (this.count === this.edges.length) {
      const grown = new Int32Array(this.edges.length * 2);
      grown.set(this.edges);
      this.edges = grown;
    }
    this.edges[this.count++] = edge;
  }
}

export function pointEdge(point: Float64Array): number {
  return point[POINT_EDGE] ?? 0;
}

export function pointOffset(point: Float64Array): number {
  return point[POINT_OFFSET] ?? 0;
}

export function pointDistance(point: Float64Array): number {
  return point[POINT_DISTANCE] ?? 0;
}
