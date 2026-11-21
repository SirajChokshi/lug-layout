import { NO_SWITCH, type TrackGraph } from "../track/track-graph.ts";
import { ZETA16_ORDER } from "@brr/math";
import { buildSimTrack, type BuiltSimTrack, type SimRoute } from "./sim-track.ts";
import type { PlanPose, SimPathSegment } from "./route-geometry.ts";

export type TrackGraphTopology = Pick<
  TrackGraph,
  | "edgeCount"
  | "switchCount"
  | "endXLdu"
  | "endZLdu"
  | "endHeading"
  | "edgeFromEnd"
  | "edgeToEnd"
  | "successorStart"
  | "successors"
  | "edgeSwitch"
  | "placementCount"
  | "edgePlacement"
  | "edgeRoute"
  | "endPlacement"
  | "endPartner"
  | "switchEnd"
>;

const HEADING_STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;

function endPose(graph: TrackGraphTopology, end: number, travelsOutward: boolean): PlanPose {
  const outward = graph.endHeading[end] ?? 0;
  const steps = travelsOutward ? outward : outward + ZETA16_ORDER / 2;
  return {
    x: graph.endXLdu[end] ?? 0,
    z: graph.endZLdu[end] ?? 0,
    heading: steps * HEADING_STEP_RADIANS,
  };
}

export function simTrackFromGraph(
  graph: TrackGraphTopology,
  routeSegments: ReadonlyArray<ReadonlyArray<SimPathSegment>>,
): BuiltSimTrack {
  if (!Number.isInteger(graph.edgeCount) || !Number.isInteger(graph.switchCount)) {
    throw new Error("track graph topology needs integer edgeCount and switchCount");
  }
  if (graph.edgeCount % 2 !== 0) throw new Error("track graph edges must come in pairs");
  if (routeSegments.length * 2 !== graph.edgeCount) {
    throw new Error(`${graph.edgeCount} directed edges need ${graph.edgeCount / 2} route paths`);
  }
  const routes: SimRoute[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 2) {
    routes.push({
      from: endPose(graph, graph.edgeFromEnd[edge] ?? 0, false),
      to: endPose(graph, graph.edgeToEnd[edge] ?? 0, true),
      segments: routeSegments[edge / 2] ?? [],
    });
  }
  const successors: number[][] = [];
  const switchOfEdge: number[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const start = graph.successorStart[edge] ?? 0;
    const end = graph.successorStart[edge + 1] ?? start;
    const next: number[] = [];
    for (let i = start; i < end; i++) next.push(graph.successors[i] ?? 0);
    successors.push(next);
    switchOfEdge.push(graph.edgeSwitch[edge] ?? NO_SWITCH);
  }
  return buildSimTrack({ routes, successors, switchOfEdge, switchCount: graph.switchCount });
}
