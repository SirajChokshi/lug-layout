export {
  backwardEdge,
  buildSimTrack,
  forwardEdge,
  NO_SWITCH,
  simTrackFromGraph,
  trackPoint,
  VEHICLE_POSE_FLOATS,
  type BuiltSimTrack,
  type CouplerGeometry,
  type CouplerMount,
  type GuideGeometry,
  type PlanPose,
  type SimPathSegment,
  type SimRoute,
  type SimTrack,
  type SimTrackInput,
  type TrackGraphTopology,
  type VehicleGeometry,
} from "@brr/domain";
export { loadSession, type LoadedSession } from "./load.ts";
export type {
  SimBenchResult,
  SimFrameMessage,
  SimLoad,
  SimLoaded,
  SimReply,
  SimRequest,
} from "./protocol.ts";
export {
  replay,
  SimSession,
  simFrameLayout,
  type SimCommand,
  type SimFrameLayout,
  type SimLogEntry,
  type SimScenario,
  type SimTrainLoad,
} from "./sim-session.ts";
export {
  DIRECTION_BACKWARD,
  DIRECTION_FORWARD,
  NO_EDGE,
  POSE_FLOATS_PER_VEHICLE,
  SIM_TICK_HZ,
  SIM_TICK_SECONDS,
  Simulation,
  type OpenEndRule,
  type SimCapacity,
  type SimRailway,
  type TrainPlacement,
  type TrainSpec,
  type VehicleSpec,
} from "./simulation.ts";
export { BlockMap, NO_BLOCK, type BlockTopology } from "./blocks/block-map.ts";
export {
  ARRIVAL_WINDOW_LDU,
  BLOCK_CLEARANCE_LDU,
  BlockKeeper,
  NO_TRAIN,
  type TrainRouteState,
} from "./blocks/block-keeper.ts";
export { RoutePlanner } from "./routing/route-planner.ts";
