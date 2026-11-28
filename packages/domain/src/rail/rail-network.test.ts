import { CHUNK_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import { NO_SWITCH } from "../track/track-graph.ts";
import {
  placeSegments,
  pointOnSegment,
  segmentsEnd,
  type PlanPose,
  type SimPathSegment,
} from "./route-geometry.ts";
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

const START: PlanPose = { x: 100, z: -40, heading: 0.3 };

function chain(segments: ReadonlyArray<SimPathSegment>, from: PlanPose): SimRoute[] {
  const routes: SimRoute[] = [];
  let at = from;
  for (const segment of segments) {
    const to = segmentsEnd(at, placeSegments(at, [segment]));
    routes.push({ from: at, to, segments: [segment] });
    at = to;
  }
  return routes;
}

function network(
  segments: ReadonlyArray<SimPathSegment>,
  closed: boolean,
  from: PlanPose = START,
): RailNetwork {
  const count = segments.length;
  const successors: number[][] = [];
  for (let r = 0; r < count; r++) {
    const next = r + 1 < count || closed ? [forwardEdge((r + 1) % count)] : [];
    const previous = r > 0 || closed ? [backwardEdge((r + count - 1) % count)] : [];
    successors.push(next, previous);
  }
  const { track } = buildSimTrack({
    routes: chain(segments, from),
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  });
  return new RailNetwork(track, new Uint8Array(0));
}

function switched(): RailNetwork {
  const lead = segmentsEnd(START, placeSegments(START, [STRAIGHT]));
  const diverging: SimPathSegment[] = [LEFT, STRAIGHT];
  const routes: SimRoute[] = [
    { from: START, to: lead, segments: [STRAIGHT] },
    { from: lead, to: segmentsEnd(lead, placeSegments(lead, [STRAIGHT])), segments: [STRAIGHT] },
    { from: lead, to: segmentsEnd(lead, placeSegments(lead, diverging)), segments: diverging },
  ];
  const successors = [
    [forwardEdge(1), forwardEdge(2)],
    [],
    [],
    [backwardEdge(0)],
    [],
    [backwardEdge(0)],
  ];
  const switchOfEdge = successors.map(() => NO_SWITCH);
  switchOfEdge[forwardEdge(0)] = 0;
  const { track } = buildSimTrack({ routes, successors, switchOfEdge, switchCount: 1 });
  return new RailNetwork(track, new Uint8Array(1));
}

function reversedArcs(): RailNetwork {
  const curves: SimPathSegment[] = [LEFT, RIGHT];
  const { track } = buildSimTrack({
    routes: [
      { from: START, to: segmentsEnd(START, placeSegments(START, curves)), segments: curves },
    ],
    successors: [[], []],
    switchOfEdge: [NO_SWITCH, NO_SWITCH],
    switchCount: 0,
  });
  return new RailNetwork(track, new Uint8Array(0));
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function nearByScan(
  rails: RailNetwork,
  x: number,
  z: number,
  radius: number,
  gap: number,
): boolean {
  const spot = new Float64Array(RAIL_SPOT_FLOATS);
  return rails.nearest(x, z, spot) && (spot[SPOT_DISTANCE] ?? 0) - radius < gap;
}

function centrelineBounds(rails: RailNetwork): readonly [number, number, number, number] {
  const point = new Float64Array(2);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let edge = 0; edge < rails.edgeCount; edge += 2) {
    for (let step = 0; step <= 16; step++) {
      point[0] = (rails.edgeLength(edge) * step) / 16;
      rails.point(edge, point, 0);
      minX = Math.min(minX, point[0] ?? 0);
      maxX = Math.max(maxX, point[0] ?? 0);
      minZ = Math.min(minZ, point[1] ?? 0);
      maxZ = Math.max(maxZ, point[1] ?? 0);
    }
  }
  return [minX, maxX, minZ, maxZ];
}

const SAMPLE_SEED = 0x7a1d;
const SAMPLES_PER_LAYOUT = 1500;
const SAMPLE_MARGIN_LDU = 2 * CHUNK_LDU;
const MAX_SAMPLE_LDU = 600;
const TIGHT_LDU = 2 ** -20;
const HALF_TURN_AND_A_QUARTER: SimPathSegment = {
  kind: "arc",
  radiusLdu: RADIUS / 2,
  sweepRadians: 1.25 * Math.PI,
};
const SHORT_LDU = 40;
const WIDE_LDU = 900;
const NARROW_LDU = 20;

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
    expect(
      Math.abs(middle.headAlong - (along(rails, forwardEdge(2), 50) + consist / 2)),
    ).toBeLessThanOrEqual(1);
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

  it("comes within a gap of a disk exactly where the nearest centreline point does, all round straights, curves both ways, a switch and multi-segment routes", () => {
    const random = seeded(SAMPLE_SEED);
    const layouts = [network(OPEN_LINE, false), switched(), reversedArcs()];
    const mismatches: string[] = [];
    let near = 0;
    let samples = 0;
    for (const rails of layouts) {
      const [minX, maxX, minZ, maxZ] = centrelineBounds(rails);
      for (let k = 0; k < SAMPLES_PER_LAYOUT; k++) {
        const x = minX - SAMPLE_MARGIN_LDU + random() * (maxX - minX + 2 * SAMPLE_MARGIN_LDU);
        const z = minZ - SAMPLE_MARGIN_LDU + random() * (maxZ - minZ + 2 * SAMPLE_MARGIN_LDU);
        const radius = random() * MAX_SAMPLE_LDU;
        const gap = random() * MAX_SAMPLE_LDU;
        const byIndex = rails.nearDisk(x, z, radius, gap);
        if (byIndex !== nearByScan(rails, x, z, radius, gap)) {
          mismatches.push(`${x}, ${z}, ${radius}, ${gap}`);
        }
        if (byIndex) near++;
        samples++;
      }
    }

    expect(mismatches).toEqual([]);
    expect(near).toBeGreaterThan(samples / 10);
    expect(samples - near).toBeGreaterThan(samples / 10);
  });

  it("comes within a gap of a disk just inside, but not just outside, an exact distance from each end of a straight or a minor arc, and from a curve past a half turn", () => {
    const verdicts: Array<readonly [string, boolean, boolean]> = [];
    const judge = (
      name: string,
      rails: RailNetwork,
      from: readonly [number, number],
      direction: readonly [number, number],
      radius: number,
      gap: number,
    ) => {
      for (const [side, expected] of [
        [-TIGHT_LDU, true],
        [TIGHT_LDU, false],
      ] as const) {
        const fromTip = radius + gap + side;
        const x = from[0] + direction[0] * fromTip;
        const z = from[1] + direction[1] * fromTip;
        verdicts.push([
          `${name} ${side < 0 ? "inside" : "outside"}`,
          rails.nearDisk(x, z, radius, gap),
          expected,
        ]);
      }
    };
    const [radius, gap] = [0, 300];
    for (const [name, segment] of [
      ["straight", STRAIGHT],
      ["left curve", LEFT],
      ["right curve", RIGHT],
    ] as const) {
      const rails = network([segment], false);
      const end = segmentsEnd(START, placeSegments(START, [segment]));
      const midX = (START.x + end.x) / 2;
      const midZ = (START.z + end.z) / 2;
      const half = Math.hypot(end.x - midX, end.z - midZ);
      for (const tip of [START, end]) {
        const direction = [(tip.x - midX) / half, (tip.z - midZ) / half] as const;
        const beyond = `${name} beyond ${tip === START ? "its start" : "its end"}`;
        judge(beyond, rails, [tip.x, tip.z], direction, radius, gap);
        if (segment === STRAIGHT && tip === end) {
          judge(`${beyond}, a wide disk`, rails, [tip.x, tip.z], direction, WIDE_LDU, NARROW_LDU);
        }
      }
    }
    const longArc = network([HALF_TURN_AND_A_QUARTER], false);
    const [placed] = placeSegments(START, [HALF_TURN_AND_A_QUARTER]);
    if (!placed) throw new Error("the long arc did not place");
    const middle = pointOnSegment(placed, placed.length / 2);
    const turning = Math.sign(placed.curvature);
    const outward = [
      turning * Math.sin(middle.heading),
      -turning * Math.cos(middle.heading),
    ] as const;
    judge(
      "curve past a half turn, outside its middle",
      longArc,
      [middle.x, middle.z],
      outward,
      radius,
      gap,
    );

    expect(verdicts).toHaveLength(16);
    expect(verdicts.filter(([, got, expected]) => got !== expected)).toEqual([]);
  });

  it("comes within a gap of a disk whose segment sits wholly in the chunk next to the query's own, from below and from above on both axes", () => {
    const inChunk = 3 * CHUNK_LDU;
    const shortStraight = (heading: number) =>
      network([{ kind: "straight", lengthLdu: SHORT_LDU }], false, {
        x: heading === 0 ? inChunk + 200 : inChunk + 320,
        z: heading === 0 ? inChunk + 320 : inChunk + 200,
        heading,
      });
    const verdicts: Array<readonly [string, boolean, boolean]> = [];
    for (const [axis, heading] of [
      ["x", 0],
      ["z", Math.PI / 2],
    ] as const) {
      const rails = shortStraight(heading);
      const start = inChunk + 200;
      const across = inChunk + 320;
      for (const [from, sign, gap] of [
        ["below", -1, 300],
        ["above", 1, 500],
      ] as const) {
        const tip = sign < 0 ? start : start + SHORT_LDU;
        for (const [side, expected] of [
          [-TIGHT_LDU, true],
          [TIGHT_LDU, false],
        ] as const) {
          const at = tip + sign * (gap + side);
          const [x, z] = axis === "x" ? [at, across] : [across, at];
          verdicts.push([
            `${axis} from ${from} ${side < 0 ? "inside" : "outside"}`,
            rails.nearDisk(x, z, 0, gap),
            expected,
          ]);
        }
      }
    }

    expect(verdicts).toHaveLength(8);
    expect(verdicts.filter(([, got, expected]) => got !== expected)).toEqual([]);
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
