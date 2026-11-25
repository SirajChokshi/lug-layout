import { NO_SWITCH } from "../track/track-graph.ts";
import {
  placeSegments,
  reversedSegments,
  segmentsEnd,
  wrapAngle,
  type PlacedSegment,
  type PlanPose,
  type SimPathSegment,
} from "./route-geometry.ts";

export interface SimTrack {
  readonly edgeCount: number;
  readonly switchCount: number;
  readonly edgeLength: Float64Array;
  readonly reverseEdge: Int32Array;
  readonly successorStart: Int32Array;
  readonly successors: Int32Array;
  readonly switchOfEdge: Int32Array;
  readonly segmentStart: Int32Array;
  readonly segmentX: Float64Array;
  readonly segmentZ: Float64Array;
  readonly segmentHeading: Float64Array;
  readonly segmentCurvature: Float64Array;
  readonly segmentLength: Float64Array;
  readonly edgeLift: Float64Array;
}

export interface TrackLift {
  readonly baseLdu: number;
  readonly gx: number;
  readonly gz: number;
  readonly lowX: number;
  readonly lowZ: number;
}

export const LEVEL_TRACK: TrackLift = { baseLdu: 0, gx: 0, gz: 0, lowX: 0, lowZ: 0 };

export interface SimRoute {
  readonly from: PlanPose;
  readonly to: PlanPose;
  readonly segments: ReadonlyArray<SimPathSegment>;
  readonly lift?: TrackLift;
}

const LIFT_BASE = 0;
const LIFT_GX = 1;
const LIFT_GZ = 2;
const LIFT_LOW_X = 3;
const LIFT_LOW_Z = 4;
const LIFT_FLOATS = 5;

export interface SimTrackInput {
  readonly routes: ReadonlyArray<SimRoute>;
  readonly successors: ReadonlyArray<ReadonlyArray<number>>;
  readonly switchOfEdge: ReadonlyArray<number>;
  readonly switchCount: number;
}

export interface BuiltSimTrack {
  readonly track: SimTrack;
  readonly maxEndResidualLdu: number;
  readonly maxEndHeadingResidualRadians: number;
}

export function forwardEdge(route: number): number {
  return route * 2;
}

export function backwardEdge(route: number): number {
  return route * 2 + 1;
}

export function buildSimTrack(input: SimTrackInput): BuiltSimTrack {
  const edgeCount = input.routes.length * 2;
  if (input.successors.length !== edgeCount || input.switchOfEdge.length !== edgeCount) {
    throw new Error(`a track of ${input.routes.length} routes needs ${edgeCount} directed edges`);
  }
  const edgeSegments: PlacedSegment[][] = [];
  let maxEndResidualLdu = 0;
  let maxEndHeadingResidualRadians = 0;
  for (const route of input.routes) {
    const forward = placeSegments(route.from, route.segments);
    const end = segmentsEnd(route.from, forward);
    maxEndResidualLdu = Math.max(
      maxEndResidualLdu,
      Math.hypot(end.x - route.to.x, end.z - route.to.z),
    );
    maxEndHeadingResidualRadians = Math.max(
      maxEndHeadingResidualRadians,
      Math.abs(wrapAngle(end.heading - route.to.heading)),
    );
    edgeSegments.push(forward, reversedSegments(forward));
  }
  const segmentCount = edgeSegments.reduce((sum, list) => sum + list.length, 0);
  const successorCount = input.successors.reduce((sum, list) => sum + list.length, 0);
  const track: SimTrack = {
    edgeCount,
    switchCount: input.switchCount,
    edgeLength: new Float64Array(edgeCount),
    reverseEdge: new Int32Array(edgeCount),
    successorStart: new Int32Array(edgeCount + 1),
    successors: new Int32Array(successorCount),
    switchOfEdge: new Int32Array(edgeCount),
    segmentStart: new Int32Array(edgeCount + 1),
    segmentX: new Float64Array(segmentCount),
    segmentZ: new Float64Array(segmentCount),
    segmentHeading: new Float64Array(segmentCount),
    segmentCurvature: new Float64Array(segmentCount),
    segmentLength: new Float64Array(segmentCount),
    edgeLift: new Float64Array(edgeCount * LIFT_FLOATS),
  };
  let segment = 0;
  let successor = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const lift = input.routes[edge >> 1]?.lift ?? LEVEL_TRACK;
    const l = edge * LIFT_FLOATS;
    track.edgeLift[l + LIFT_BASE] = lift.baseLdu;
    track.edgeLift[l + LIFT_GX] = lift.gx;
    track.edgeLift[l + LIFT_GZ] = lift.gz;
    track.edgeLift[l + LIFT_LOW_X] = lift.lowX;
    track.edgeLift[l + LIFT_LOW_Z] = lift.lowZ;
    track.reverseEdge[edge] = edge ^ 1;
    track.segmentStart[edge] = segment;
    let length = 0;
    for (const piece of edgeSegments[edge] ?? []) {
      track.segmentX[segment] = piece.x;
      track.segmentZ[segment] = piece.z;
      track.segmentHeading[segment] = piece.heading;
      track.segmentCurvature[segment] = piece.curvature;
      track.segmentLength[segment] = piece.length;
      length += piece.length;
      segment++;
    }
    track.edgeLength[edge] = length;
    track.successorStart[edge] = successor;
    const next = input.successors[edge] ?? [];
    for (const target of next) {
      if (!Number.isInteger(target) || target < 0 || target >= edgeCount) {
        throw new Error(`edge ${edge} lists successor ${target}, which is not a directed edge`);
      }
      track.successors[successor++] = target;
    }
    const switchIndex = input.switchOfEdge[edge] ?? NO_SWITCH;
    if (next.length > 1 && (switchIndex < 0 || switchIndex >= input.switchCount)) {
      throw new Error(`edge ${edge} has ${next.length} successors but no switch picks one`);
    }
    track.switchOfEdge[edge] = next.length > 1 ? switchIndex : NO_SWITCH;
  }
  track.segmentStart[edgeCount] = segment;
  track.successorStart[edgeCount] = successor;
  return { track, maxEndResidualLdu, maxEndHeadingResidualRadians };
}

export function trackPoint(track: SimTrack, edge: number, io: Float64Array, at: number): void {
  const first = track.segmentStart[edge] ?? 0;
  const last = (track.segmentStart[edge + 1] ?? first) - 1;
  let s = io[at] ?? 0;
  let i = first;
  while (i < last && s > (track.segmentLength[i] ?? 0)) {
    s -= track.segmentLength[i] ?? 0;
    i++;
  }
  const x = track.segmentX[i] ?? 0;
  const z = track.segmentZ[i] ?? 0;
  const h = track.segmentHeading[i] ?? 0;
  const k = track.segmentCurvature[i] ?? 0;
  const length = track.segmentLength[i] ?? 0;
  if (s > length && k !== 0) {
    const endHeading = h + k * length;
    const beyond = s - length;
    io[at] = x + (Math.sin(endHeading) - Math.sin(h)) / k + beyond * Math.cos(endHeading);
    io[at + 1] = z - (Math.cos(endHeading) - Math.cos(h)) / k + beyond * Math.sin(endHeading);
    return;
  }
  if (k === 0) {
    io[at] = x + s * Math.cos(h);
    io[at + 1] = z + s * Math.sin(h);
    return;
  }
  const turned = h + k * s;
  io[at] = x + (Math.sin(turned) - Math.sin(h)) / k;
  io[at + 1] = z - (Math.cos(turned) - Math.cos(h)) / k;
}

const liftPoint = new Float64Array(2);

export function trackLift(track: SimTrack, edge: number, io: Float64Array, at: number): void {
  const l = edge * LIFT_FLOATS;
  const base = track.edgeLift[l + LIFT_BASE] ?? 0;
  const gx = track.edgeLift[l + LIFT_GX] ?? 0;
  const gz = track.edgeLift[l + LIFT_GZ] ?? 0;
  if (gx === 0 && gz === 0) {
    io[at] = base;
    return;
  }
  liftPoint[0] = io[at] ?? 0;
  trackPoint(track, edge, liftPoint, 0);
  io[at] =
    base +
    gx * ((liftPoint[0] ?? 0) - (track.edgeLift[l + LIFT_LOW_X] ?? 0)) +
    gz * ((liftPoint[1] ?? 0) - (track.edgeLift[l + LIFT_LOW_Z] ?? 0));
}
