import { describe, expect, it } from "vitest";
import { NO_SWITCH } from "../track/track-graph.ts";
import { SOLID_MATRIX_FLOATS } from "../solid-contact.ts";
import { RailNetwork, RailRun } from "./rail-network.ts";
import {
  placeSegments,
  segmentsEnd,
  type PlanPose,
  type SimPathSegment,
} from "./route-geometry.ts";
import {
  GEOMETRY_FIELDS,
  RunningGearPoser,
  VEHICLE_POSE_FLOATS,
  packGeometry,
  rigidLift,
  writeRigidFrame,
  type VehicleGeometry,
} from "./running-gear.ts";
import { backwardEdge, buildSimTrack, forwardEdge, type SimRoute } from "./sim-track.ts";

const STRAIGHT: SimPathSegment = { kind: "straight", lengthLdu: 320 };
const START: PlanPose = { x: 100, z: -40, heading: 0.3 };
const SLOPE = 16 / 320;
const UPHILL_X = Math.cos(START.heading);
const UPHILL_Z = Math.sin(START.heading);
const PROBE_LDU = 100;
const RIGIDS = 3;
const CAR: VehicleGeometry = {
  front: {
    pivotXLdu: 180.5,
    pivotZLdu: 0,
    leadAxleXLdu: 240.25,
    trailAxleXLdu: 120.75,
    axleZLdu: 0,
    pivots: true,
  },
  rear: {
    pivotXLdu: -180.5,
    pivotZLdu: 0,
    leadAxleXLdu: -120.75,
    trailAxleXLdu: -240.25,
    axleZLdu: 0,
    pivots: true,
  },
  frontCoupler: { xLdu: 345, zLdu: 0, mount: "body" },
  rearCoupler: { xLdu: -345, zLdu: 0, mount: "body" },
};

function rampedRun(): RailRun {
  const routes: SimRoute[] = [];
  let at = START;
  const lift = {
    baseLdu: 0,
    gx: SLOPE * UPHILL_X,
    gz: SLOPE * UPHILL_Z,
    lowX: START.x,
    lowZ: START.z,
  };
  for (let r = 0; r < 4; r++) {
    const to = segmentsEnd(at, placeSegments(at, [STRAIGHT]));
    routes.push({ from: at, to, segments: [STRAIGHT], lift });
    at = to;
  }
  const successors = routes.flatMap((_, r) => [
    r + 1 < routes.length ? [forwardEdge(r + 1)] : [],
    r > 0 ? [backwardEdge(r - 1)] : [],
  ]);
  const { track } = buildSimTrack({
    routes,
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  });
  return new RailRun(new RailNetwork(track, new Uint8Array(0)));
}

function heightAt(x: number, z: number): number {
  return SLOPE * ((x - START.x) * UPHILL_X + (z - START.z) * UPHILL_Z);
}

function posed(mirrored: boolean): Float64Array {
  const run = rampedRun();
  expect(run.standAt(forwardEdge(3), 200, 690)).toBe(true);
  const geometry = new Float64Array(GEOMETRY_FIELDS);
  packGeometry(CAR, geometry, 0);
  const poses = new Float64Array(VEHICLE_POSE_FLOATS);
  new RunningGearPoser().writeTrain(
    run,
    geometry,
    Int32Array.of(0),
    0,
    1,
    mirrored,
    null,
    0,
    poses,
    0,
    new Float64Array(1),
    0,
  );
  return poses;
}

function worldHeight(frame: Float64Array, localX: number): { along: number; y: number } {
  const x = (frame[0] ?? 0) * localX + (frame[3] ?? 0);
  const z = (frame[8] ?? 0) * localX + (frame[11] ?? 0);
  return { along: x * UPHILL_X + z * UPHILL_Z, y: (frame[4] ?? 0) * localX + (frame[7] ?? 0) };
}

describe("a vehicle posed on a ramp", () => {
  it.each([false, true])(
    "sits each body and bogie on the rails and tilts it up the slope, the right way round or reversed (%s)",
    (mirrored) => {
      const poses = posed(mirrored);
      const frame = new Float64Array(SOLID_MATRIX_FLOATS);
      const ground = new Float64Array(1);
      for (let rigid = 0; rigid < RIGIDS; rigid++) {
        const x = poses[rigid * 3] ?? 0;
        const z = poses[rigid * 3 + 1] ?? 0;
        expect(rigidLift(poses, 0, rigid)).toBeCloseTo(heightAt(x, z), 9);
        writeRigidFrame(poses, 0, rigid, ground, 0, frame, 0);
        const ahead = worldHeight(frame, PROBE_LDU);
        const behind = worldHeight(frame, -PROBE_LDU);
        expect((ahead.y - behind.y) / (ahead.along - behind.along)).toBeCloseTo(SLOPE, 9);
      }
    },
  );
});
