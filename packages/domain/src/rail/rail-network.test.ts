import { describe, expect, it } from "vitest";
import { NO_SWITCH } from "../track/track-graph.ts";
import { placeSegments, segmentsEnd, type PlanPose, type SimPathSegment } from "./route-geometry.ts";
import {
  RAIL_SPOT_FLOATS,
  RailNetwork,
  RailRun,
  SPOT_DISTANCE,
  SPOT_EDGE,
  SPOT_OFFSET,
} from "./rail-network.ts";
import { backwardEdge, buildSimTrack, forwardEdge, type SimRoute } from "./sim-track.ts";

const RADIUS = 800;
const STRAIGHT_LDU = 320;
const STRAIGHT: SimPathSegment = { kind: "straight", lengthLdu: STRAIGHT_LDU };
const LEFT: SimPathSegment = { kind: "arc", radiusLdu: RADIUS, sweepRadians: Math.PI / 8 };
const RIGHT: SimPathSegment = { kind: "arc", radiusLdu: RADIUS, sweepRadians: -Math.PI / 8 };

function chain(segments: ReadonlyArray<SimPathSegment>): SimRoute[] {
  const routes: SimRoute[] = [];
  let at: PlanPose = { x: 100, z: -40, heading: 0.3 };
  for (const segment of segments) {
    const to = segmentsEnd(at, placeSegments(at, [segment]));
    routes.push({ from: at, to, segments: [segment] });
    at = to;
  }
  return routes;
}

function network(segments: ReadonlyArray<SimPathSegment>, closed: boolean): RailNetwork {
  const count = segments.length;
  const successors: number[][] = [];
  for (let r = 0; r < count; r++) {
    const next = r + 1 < count || closed ? [forwardEdge((r + 1) % count)] : [];
    const previous = r > 0 || closed ? [backwardEdge((r + count - 1) % count)] : [];
    successors.push(next, previous);
  }
  const { track } = buildSimTrack({
    routes: chain(segments),
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  });
  return new RailNetwork(track, new Uint8Array(0));
}

const OPEN_LINE = [STRAIGHT, LEFT, LEFT, STRAIGHT, RIGHT, STRAIGHT];
const LINE_LDU = 3 * STRAIGHT_LDU + (3 * RADIUS * Math.PI) / 8;
const OVAL = [
  ...Array.from({ length: 8 }, () => LEFT),
  STRAIGHT,
  STRAIGHT,
  ...Array.from({ length: 8 }, () => LEFT),
  STRAIGHT,
  STRAIGHT,
];

function along(rails: RailNetwork, edge: number, offset: number): number {
  let before = 0;
  for (let e = edge & ~1; e > 0; e -= 2) before += rails.edgeLength(e - 2);
  return edge % 2 === 0 ? before + offset : before + rails.edgeLength(edge) - offset;
}

describe("RailNetwork", () => {
  it("finds the exact centreline point beside any point off a straight or a curve, on either side", () => {
    const rails = network(OPEN_LINE, false);
    const spot = new Float64Array(RAIL_SPOT_FLOATS);
    const sample = new Float64Array(2);
    const behind = new Float64Array(2);
    const ahead = new Float64Array(2);
    const misses: number[] = [];
    for (let route = 0; route < OPEN_LINE.length; route++) {
      const edge = forwardEdge(route);
      const length = rails.edgeLength(edge);
      for (const fraction of [0.1, 0.5, 0.9]) {
        for (const side of [-1, 1]) {
          sample[0] = fraction * length;
          rails.point(edge, sample, 0);
          behind[0] = fraction * length - 1;
          rails.point(edge, behind, 0);
          ahead[0] = fraction * length + 1;
          rails.point(edge, ahead, 0);
          const dx = (ahead[0] ?? 0) - (behind[0] ?? 0);
          const dz = (ahead[1] ?? 0) - (behind[1] ?? 0);
          const norm = Math.hypot(dx, dz);
          const offAxis = side * 60;
          const found = rails.nearest(
            (sample[0] ?? 0) - (dz / norm) * offAxis,
            (sample[1] ?? 0) + (dx / norm) * offAxis,
            spot,
          );
          misses.push(
            !found || spot[SPOT_EDGE] !== edge
              ? Number.POSITIVE_INFINITY
              : Math.max(
                  Math.abs((spot[SPOT_OFFSET] ?? 0) - fraction * length),
                  Math.abs((spot[SPOT_DISTANCE] ?? 0) - Math.abs(offAxis)),
                ),
          );
        }
      }
    }
    expect(Math.max(...misses)).toBeLessThan(1e-6);
  });

  it("centres a consist on the aimed point, and slides it back from an open end so it still fits, with the head on a whole LDU", () => {
    const rails = network(OPEN_LINE, false);
    const spot = new Float64Array(RAIL_SPOT_FLOATS);
    const consist = 700;
    const seat = (route: number, offset: number) => {
      const ok = rails.seat(forwardEdge(route), offset, consist, spot);
      const edge = spot[SPOT_EDGE] ?? 0;
      const head = spot[SPOT_OFFSET] ?? 0;
      return {
        ok,
        wholeLdu: Number.isInteger(head),
        headAlong: along(rails, edge, head),
        behind: rails.reachBehind(edge, head, consist),
      };
    };
    const middle = seat(2, 50);
    const nearEnd = seat(5, STRAIGHT_LDU - 10);
    const nearStart = seat(0, 10);

    expect(middle.ok && middle.wholeLdu).toBe(true);
    expect(Math.abs(middle.headAlong - (along(rails, forwardEdge(2), 50) + consist / 2))).toBeLessThanOrEqual(1);
    expect(nearEnd).toMatchObject({ ok: true, wholeLdu: true });
    expect(nearEnd.headAlong).toBeCloseTo(LINE_LDU, 9);
    expect(nearStart).toMatchObject({ ok: true, wholeLdu: true });
    expect(nearStart.headAlong).toBeGreaterThanOrEqual(consist);
    expect(nearStart.headAlong).toBeLessThan(consist + 1);
    expect([middle, nearEnd, nearStart].every((s) => s.behind >= consist)).toBe(true);
  });

  it("refuses a consist longer than the run it is aimed at", () => {
    const rails = network(OPEN_LINE, false);
    const spot = new Float64Array(RAIL_SPOT_FLOATS);

    expect(rails.seat(forwardEdge(2), 50, Math.ceil(LINE_LDU), spot)).toBe(false);
    expect(rails.seat(forwardEdge(2), 50, Math.floor(LINE_LDU) - 1, spot)).toBe(true);
  });

  it("travels a loop backwards as well as forwards, so a consist seats across the join of a closed oval", () => {
    const rails = network(OVAL, true);
    const spot = new Float64Array(RAIL_SPOT_FLOATS);

    expect(rails.seat(backwardEdge(0), 20, 900, spot)).toBe(true);
    expect(spot[SPOT_EDGE]).toBe(backwardEdge(OVAL.length - 1));
  });
});

describe("RailRun", () => {
  it("samples the track behind the head the way the track itself places points, across edges", () => {
    const rails = network(OPEN_LINE, false);
    const run = new RailRun(rails);
    const io = new Float64Array(2);
    const expected = new Float64Array(2);
    const headEdge = forwardEdge(4);
    const headOffset = 100;
    run.standAt(headEdge, headOffset, 900);
    const misses: number[] = [];
    for (const behind of [0, 50, 100, 350, 700, 900]) {
      io[0] = behind;
      run.pointBehind(io, 0);
      let edge = headEdge;
      let offset = headOffset - behind;
      while (offset < 0) {
        edge -= 2;
        offset += rails.edgeLength(edge);
      }
      expected[0] = offset;
      rails.point(edge, expected, 0);
      misses.push(Math.hypot((io[0] ?? 0) - (expected[0] ?? 0), (io[1] ?? 0) - (expected[1] ?? 0)));
    }
    expect(Math.max(...misses)).toBeLessThan(1e-9);
  });

  it("refuses to stand a consist that would wrap round a loop onto its own track", () => {
    const rails = network(OVAL, true);
    const run = new RailRun(rails);
    let loop = 0;
    for (let edge = 0; edge < rails.edgeCount; edge += 2) loop += rails.edgeLength(edge);

    expect(run.standAt(forwardEdge(3), 10, loop - 400)).toBe(true);
    expect(run.standAt(forwardEdge(3), 10, loop + 10)).toBe(false);
  });
});
