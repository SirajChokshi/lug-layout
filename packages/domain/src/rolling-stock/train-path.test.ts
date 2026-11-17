import { describe, expect, it } from "vitest";
import { NO_SWITCH } from "../track/track-graph.ts";
import { pointOnSegment, placeSegments } from "../track-path/route-geometry.ts";
import {
  buildSimTrack,
  trackPoint,
  type SimRoute,
  type SimTrack,
} from "../track-path/sim-track.ts";
import {
  fitClear,
  fitEdge,
  fitOffset,
  fitTrain,
  placementsUnder,
  TRAIN_FIT_FLOATS,
  trainsOverlap,
} from "./train-fit.ts";
import {
  clearAhead,
  clearBehind,
  nearestTrackPoint,
  pointDistance,
  pointEdge,
  pointOffset,
  TRACK_POINT_FLOATS,
  TrainPath,
} from "./train-path.ts";

const STRAIGHT_LDU = 320;
const RADIUS_LDU = 400;
const SWEEP = Math.PI / 8;
const ARC_LDU = RADIUS_LDU * SWEEP;
const PICK_LDU = 60;

function route(x: number, z: number, heading: number, segments: SimRoute["segments"]): SimRoute {
  const from = { x, z, heading };
  const placed = placeSegments(from, segments);
  const last = placed.at(-1);
  if (!last) throw new Error("a route needs a segment");
  return { from, to: pointOnSegment(last, last.length), segments };
}

function straightThenCurve(): SimTrack {
  const straight = route(0, 0, 0, [{ kind: "straight", lengthLdu: STRAIGHT_LDU }]);
  const curve = route(STRAIGHT_LDU, 0, 0, [
    { kind: "arc", radiusLdu: RADIUS_LDU, sweepRadians: SWEEP },
  ]);
  return buildSimTrack({
    routes: [straight, curve],
    successors: [[2], [], [], [1]],
    switchOfEdge: [NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH],
    switchCount: 0,
  }).track;
}

function lineIntoSwitch(): SimTrack {
  const lead = route(0, 0, 0, [{ kind: "straight", lengthLdu: STRAIGHT_LDU }]);
  const through = route(STRAIGHT_LDU, 0, 0, [{ kind: "straight", lengthLdu: STRAIGHT_LDU }]);
  const diverging = route(STRAIGHT_LDU, 0, 0, [
    { kind: "arc", radiusLdu: RADIUS_LDU, sweepRadians: SWEEP },
  ]);
  return buildSimTrack({
    routes: [lead, through, diverging],
    successors: [[2, 4], [], [], [1], [], [1]],
    switchOfEdge: [0, NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH],
    switchCount: 1,
  }).track;
}

function headingAt(track: SimTrack, edge: number, offset: number): number {
  const a = new Float64Array(2);
  const b = new Float64Array(2);
  const step = 1e-3;
  trackPoint(track, edge, Math.max(offset - step, 0), a, 0);
  trackPoint(track, edge, offset + step, b, 0);
  return Math.atan2((b[1] ?? 0) - (a[1] ?? 0), (b[0] ?? 0) - (a[0] ?? 0));
}

describe("nearestTrackPoint", () => {
  it("projects a point beside straight or curved track back to the centreline", () => {
    const track = straightThenCurve();
    const scratch = new Float64Array(2);
    const found = new Float64Array(TRACK_POINT_FLOATS);
    const centre = new Float64Array(2);
    for (const [edge, total] of [
      [0, STRAIGHT_LDU],
      [2, ARC_LDU],
    ] as const) {
      for (const along of [0.25, 0.5, 0.9].map((f) => f * total)) {
        for (const aside of [-55, -20, 0, 35]) {
          trackPoint(track, edge, along, centre, 0);
          const heading = headingAt(track, edge, along);
          const x = (centre[0] ?? 0) - aside * Math.sin(heading);
          const z = (centre[1] ?? 0) + aside * Math.cos(heading);
          expect(nearestTrackPoint(track, x, z, PICK_LDU, scratch, found)).toBe(true);
          expect(pointEdge(found)).toBe(edge);
          expect(pointOffset(found)).toBeCloseTo(along, 9);
          expect(pointDistance(found)).toBeCloseTo(Math.abs(aside), 9);
        }
      }
    }
  });

  it("finds nothing further from every centreline than the pick radius", () => {
    const track = straightThenCurve();
    const found = new Float64Array(TRACK_POINT_FLOATS);
    expect(nearestTrackPoint(track, 160, PICK_LDU + 1, PICK_LDU, new Float64Array(2), found)).toBe(
      false,
    );
  });
});

describe("fitTrain", () => {
  it("stands any consist that fits the line whole, with an integer head and the tail on track", () => {
    const track = straightThenCurve();
    const total = STRAIGHT_LDU + ARC_LDU;
    const path = new TrainPath(track);
    const fit = new Float64Array(TRAIN_FIT_FLOATS);
    for (const length of [100, 300.5, 470]) {
      for (const cursor of [0, 50, 200, 319]) {
        if (!fitTrain(track, path, 0, cursor, length, fit)) {
          throw new Error(`${length} LDU did not fit at ${cursor}`);
        }
        expect(Number.isInteger(fitOffset(fit))).toBe(true);
        expect(path.stand(fitEdge(fit), fitOffset(fit), length)).toBe(true);
        const ahead = clearAhead(track, fitEdge(fit), fitOffset(fit), total);
        const behind = clearBehind(track, fitEdge(fit), fitOffset(fit), total);
        expect(behind).toBeGreaterThanOrEqual(length);
        expect(ahead + behind).toBeCloseTo(total, 9);
      }
    }
    expect(fitTrain(track, path, 0, 100, total + 1, fit)).toBe(false);
    expect(fitClear(fit)).toBeCloseTo(total, 9);
  });

  it("never stands a consist across a facing switch, where the path behind would need a choice", () => {
    const track = lineIntoSwitch();
    const path = new TrainPath(track);
    const fit = new Float64Array(TRAIN_FIT_FLOATS);
    expect(clearAhead(track, 0, 100, 10_000)).toBe(STRAIGHT_LDU - 100);
    expect(fitTrain(track, path, 2, 10, 500, fit)).toBe(true);
    expect(fitTrain(track, path, 1, 10, 500, fit)).toBe(false);
    expect(fitClear(fit)).toBe(STRAIGHT_LDU);
  });
});

describe("trainsOverlap", () => {
  const track = straightThenCurve();
  const routePlacement = Int32Array.of(0, 1);

  it("separates consists that only touch, and refuses ones that share track", () => {
    const front = new TrainPath(track);
    const rear = new TrainPath(track);
    expect(front.stand(0, 300, 100)).toBe(true);
    expect(rear.stand(0, 200, 100)).toBe(true);
    expect(trainsOverlap(front, 100, rear, 100, routePlacement)).toBe(false);
    expect(rear.stand(0, 201, 100)).toBe(true);
    expect(trainsOverlap(front, 100, rear, 100, routePlacement)).toBe(true);
    const opposite = new TrainPath(track);
    expect(opposite.stand(1, STRAIGHT_LDU - 250, 100)).toBe(true);
    expect(trainsOverlap(front, 100, opposite, 100, routePlacement)).toBe(true);
  });

  it("lists every track piece a consist stands on, and not the one its head only touches", () => {
    const path = new TrainPath(track);
    expect(path.stand(2, 30, 100)).toBe(true);
    expect([...placementsUnder(path, 100, routePlacement)].toSorted()).toEqual([0, 1]);
    expect(path.stand(2, 0, 100)).toBe(true);
    expect([...placementsUnder(path, 100, routePlacement)]).toEqual([0]);
  });
});

describe("TrainPath.pointBehind", () => {
  it("samples the centreline behind the head across a joint", () => {
    const track = straightThenCurve();
    const path = new TrainPath(track);
    expect(path.stand(2, 40, 200)).toBe(true);
    const out = new Float64Array(2);
    const expected = new Float64Array(2);
    path.pointBehind(150, out, 0);
    trackPoint(track, 0, STRAIGHT_LDU - 110, expected, 0);
    expect(out[0]).toBeCloseTo(expected[0] ?? Number.NaN, 9);
    expect(out[1]).toBeCloseTo(expected[1] ?? Number.NaN, 9);
    expect(path.distanceBehind(0, STRAIGHT_LDU - 110)).toBeCloseTo(150, 9);
    expect(path.distanceBehind(1, 10)).toBeCloseTo(30, 9);
  });
});
