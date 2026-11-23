import {
  KitOutlines,
  NO_OBSTACLE,
  StrokePath,
  StrokeRouter,
  TrackClearance,
  layMoves,
  runMoves,
  type ClosureResult,
  type FollowedRun,
  type StrokeGoal,
  type StrokeSite,
  type DrawingKit,
  type TrackMove,
  type TrackRun,
} from "@brr/domain";
import { HALF_TURN_16, normalizeHeading16, pose16, zeta16, type Pose16 } from "@brr/math";
import { beforeAll, expect, it } from "vitest";
import { ColorTable } from "../scene/viewer-scene.ts";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import { TrackDrawing } from "./track-drawing.ts";

const STROKE_SPACING_LDU = 10;
const OUT_OF_BUDGET: ClosureResult = { kind: "limit" };

interface Fixture {
  readonly outlines: KitOutlines;
  readonly starts: ReadonlyArray<Pose16>;
  readonly runs: ReadonlyArray<FollowedRun>;
  readonly goals: ReadonlyArray<StrokeGoal>;
  readonly sites: ReadonlyArray<StrokeSite>;
  readonly followStroke: StrokePath;
  readonly joinStrokes: ReadonlyArray<StrokePath>;
}

let fixture: Fixture;

function strokeAlongX(lengthLdu: number): StrokePath {
  const stroke = new StrokePath(0, 0, STROKE_SPACING_LDU);
  for (let x = STROKE_SPACING_LDU; x <= lengthLdu; x += STROKE_SPACING_LDU) stroke.extend(x, 0);
  return stroke;
}

function clearanceOf(rects: ReadonlyArray<ReadonlyArray<number>>): TrackClearance {
  const clearance = new TrackClearance();
  for (const [minX = 0, minZ = 0, maxX = 0, maxZ = 0] of rects) {
    clearance.addRect(minX, minZ, maxX, maxZ);
  }
  return clearance;
}

function site(
  solid: ReadonlyArray<ReadonlyArray<number>>,
  studless: ReadonlyArray<ReadonlyArray<number>>,
): StrokeSite {
  return {
    clearance: clearanceOf(solid),
    support: { studlessTops: clearanceOf(studless), supported: () => false },
    startOwner: NO_OBSTACLE,
  };
}

function endOf(kit: DrawingKit, start: Pose16, run: TrackRun): Pose16 {
  const end = layMoves(start, runMoves(kit, run)).end;
  return pose16(end.position, normalizeHeading16(end.heading + HALF_TURN_16));
}

function straights(count: number): TrackRun {
  return { segments: [{ kind: "straight", count }], pieces: count };
}

function bend(sign: 1 | -1): TrackRun {
  return {
    segments: [
      { kind: "straight", count: 6 },
      { kind: "turn", sign, curves: 2 },
      { kind: "straight", count: 2 },
    ],
    pieces: 10,
  };
}

function fixedRun(moves: ReadonlyArray<TrackMove>, progressLdu: Float64Array): FollowedRun {
  return { moves, progressLdu, blocked: null, blocker: NO_OBSTACLE, joined: false };
}

beforeAll(async () => {
  const bundle = await fixtureBundleLoader().load("standard", (part) => part.role === "track");
  const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const { kit } = drawing;
  const outlineById = new Map(drawing.kitParts().map((part) => [part.def.id, part.outline]));
  const outlines = new KitOutlines(kit, (piece) => {
    const outline = outlineById.get(piece.id);
    if (!outline) throw new Error(`${piece.id} has no outline`);
    return outline;
  });
  const origin = pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);
  const ahead = endOf(kit, origin, straights(1));
  const lengthLdu = outlines.frameFor(kit.straight).lengthLdu;
  const progress = Float64Array.from([0, 1, 2, 3], (k) => k * lengthLdu);
  const leftGoal = endOf(kit, origin, bend(1));
  const lastPiece = [2.75 * lengthLdu, -40, 2.95 * lengthLdu, 40];
  const studlessTop = [2.8 * lengthLdu, -20, 2.9 * lengthLdu, 20];
  fixture = {
    outlines,
    starts: [origin, pose16(ahead.position, origin.heading)],
    runs: [
      fixedRun([kit.straight, kit.straight, kit.straight], progress),
      fixedRun([kit.left, kit.straight, kit.straight], progress),
    ],
    goals: [
      { pose: leftGoal, owner: 0 },
      { pose: leftGoal, owner: NO_OBSTACLE },
      { pose: endOf(kit, origin, bend(-1)), owner: NO_OBSTACLE },
      { pose: endOf(kit, origin, straights(3)), owner: NO_OBSTACLE },
    ],
    sites: [
      site([], []),
      site([[3.2 * lengthLdu, -30, 5.8 * lengthLdu, 30]], []),
      site([lastPiece], [studlessTop]),
    ],
    followStroke: strokeAlongX(3.1 * lengthLdu),
    joinStrokes: [strokeAlongX(3 * lengthLdu), strokeAlongX(12 * lengthLdu)],
  };
});

function wholeSearchOutOfBudget(): ClosureResult {
  return OUT_OF_BUDGET;
}

function followedFields(run: FollowedRun): unknown {
  return {
    moves: [...run.moves],
    progressLdu: [...run.progressLdu],
    blocked: run.blocked,
    blocker: run.blocker,
    joined: run.joined,
  };
}

type Step = readonly [start: number, run: number, goal: number, site: number, stroke: number];

function radices(): Step {
  return [
    fixture.starts.length,
    fixture.runs.length,
    fixture.goals.length,
    fixture.sites.length,
    fixture.joinStrokes.length,
  ];
}

function grayWalk(radix: Step, fastestFirst: ReadonlyArray<number>): ReadonlyArray<Step> {
  const digits = [0, 0, 0, 0, 0];
  const rising = [true, true, true, true, true];
  const snapshot = (): Step => [
    digits[0] ?? 0,
    digits[1] ?? 0,
    digits[2] ?? 0,
    digits[3] ?? 0,
    digits[4] ?? 0,
  ];
  const walk: Step[] = [snapshot()];
  for (;;) {
    let moved = false;
    for (const d of fastestFirst) {
      const value = digits[d] ?? 0;
      const next = rising[d] ? value + 1 : value - 1;
      if (next >= 0 && next < (radix[d] ?? 1)) {
        digits[d] = next;
        moved = true;
        break;
      }
      rising[d] = !rising[d];
    }
    if (!moved) return walk;
    walk.push(snapshot());
  }
}

function rotations(count: number): ReadonlyArray<ReadonlyArray<number>> {
  const digits = Array.from({ length: count }, (_, digit) => digit);
  return digits.map((first) => digits.map((k) => (first + k) % count));
}

function at<T>(list: ReadonlyArray<T>, index: number): T {
  const item = list[index];
  if (item === undefined) throw new RangeError(`no fixture item ${index}`);
  return item;
}

it("a reused router's follow, join and studless scan equal a fresh router's at every step of a one-input-at-a-time walk", () => {
  const reused = new StrokeRouter(fixture.outlines);
  const radix = radices();
  const states = radix.reduce((product, r) => product * r, 1);
  const walks = rotations(radix.length).map((order) => grayWalk(radix, order));
  for (const walk of walks) expect(walk).toHaveLength(states);
  for (const [startIndex, runIndex, goalIndex, siteIndex, strokeIndex] of walks.flat()) {
    const start = at(fixture.starts, startIndex);
    const run = at(fixture.runs, runIndex);
    const goal = at(fixture.goals, goalIndex);
    const stepSite = at(fixture.sites, siteIndex);
    const joinStroke = at(fixture.joinStrokes, strokeIndex);
    const fresh = (): StrokeRouter => new StrokeRouter(fixture.outlines);
    expect(followedFields(reused.follow(start, fixture.followStroke, stepSite, goal))).toEqual(
      followedFields(fresh().follow(start, fixture.followStroke, stepSite, goal)),
    );
    const join = reused.join(start, joinStroke, run, goal, stepSite, wholeSearchOutOfBudget);
    expect(join).toEqual(
      fresh().join(start, joinStroke, run, goal, stepSite, wholeSearchOutOfBudget),
    );
    expect(reused.join(start, joinStroke, run, goal, stepSite, wholeSearchOutOfBudget)).toBe(join);
    const scan = reused.studlessScan(start, run.moves, stepSite, goal.owner);
    expect(scan).toEqual(fresh().studlessScan(start, run.moves, stepSite, goal.owner));
    expect(reused.studlessScan(start, run.moves, stepSite, goal.owner)).toBe(scan);
  }
});
