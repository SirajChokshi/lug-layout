import {
  placeSegments,
  pointOnSegment,
  reversedSegments,
  segmentsEnd,
  wrapAngle,
  type PlacedSegment,
  type PlanPose,
  type SimPathSegment,
} from "./route-geometry.ts";

export const NO_SWITCH = -1;

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
}

export interface SimRoute {
  readonly from: PlanPose;
  readonly to: PlanPose;
  readonly segments: ReadonlyArray<SimPathSegment>;
}

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
  };
  let segment = 0;
  let successor = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
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

export function trackPoint(
  track: SimTrack,
  edge: number,
  offset: number,
  out: Float64Array,
  outIndex: number,
): void {
  const first = track.segmentStart[edge] ?? 0;
  const last = (track.segmentStart[edge + 1] ?? first) - 1;
  let s = offset;
  let i = first;
  while (i < last && s > (track.segmentLength[i] ?? 0)) {
    s -= track.segmentLength[i] ?? 0;
    i++;
  }
  const x = track.segmentX[i] ?? 0;
  const z = track.segmentZ[i] ?? 0;
  const h = track.segmentHeading[i] ?? 0;
  const k = track.segmentCurvature[i] ?? 0;
  if (k === 0) {
    out[outIndex] = x + s * Math.cos(h);
    out[outIndex + 1] = z + s * Math.sin(h);
    return;
  }
  const turned = h + k * s;
  out[outIndex] = x + (Math.sin(turned) - Math.sin(h)) / k;
  out[outIndex + 1] = z - (Math.cos(turned) - Math.cos(h)) / k;
}

export function edgeEndPose(track: SimTrack, edge: number): PlanPose {
  const last = (track.segmentStart[edge + 1] ?? 1) - 1;
  return pointOnSegment(
    {
      x: track.segmentX[last] ?? 0,
      z: track.segmentZ[last] ?? 0,
      heading: track.segmentHeading[last] ?? 0,
      curvature: track.segmentCurvature[last] ?? 0,
      length: track.segmentLength[last] ?? 0,
    },
    track.segmentLength[last] ?? 0,
  );
}

export function simTrackBuffers(track: SimTrack): ArrayBuffer[] {
  return [
    track.edgeLength,
    track.reverseEdge,
    track.successorStart,
    track.successors,
    track.switchOfEdge,
    track.segmentStart,
    track.segmentX,
    track.segmentZ,
    track.segmentHeading,
    track.segmentCurvature,
    track.segmentLength,
  ].map((array) => {
    if (!(array.buffer instanceof ArrayBuffer))
      throw new Error("sim track arrays must own plain buffers");
    return array.buffer;
  });
}
