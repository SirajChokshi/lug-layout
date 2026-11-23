import {
  HALF_TURN_16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  normalizeHeading16,
  subtractZeta16,
  type Pose16,
} from "@brr/math";
import { shortClearClosure, type ClosureSite, type SupportSite } from "./clear-closure.ts";
import type { ClosureResult } from "./closure.ts";
import {
  addRotated,
  coefficientNumbers,
  coefficientsLduInto,
  type KitOutlines,
} from "./kit-outlines.ts";
import {
  PROJECTED_ARC,
  PROJECTED_DISTANCE,
  PROJECTED_TANGENT,
  PROJECTION_FLOATS,
  PROJECTION_QUERY_FLOATS,
  QUERY_FROM_ARC,
  QUERY_TANGENT_HALF_SPAN,
  QUERY_TO_ARC,
  QUERY_X,
  QUERY_Z,
  type StrokePath,
} from "./stroke-path.ts";
import {
  NO_OBSTACLE,
  RUN_CROSSING,
  poseLdu,
  studlessTopBlocker,
  type TrackClearance,
} from "./track-clearance.ts";
import { advance, type TrackMove } from "./track-pose.ts";
import { runMoves } from "./track-solver.ts";

export interface StrokeSite {
  readonly clearance: TrackClearance;
  readonly support: SupportSite;
  readonly startOwner: number;
}

export interface StrokeGoal {
  readonly pose: Pose16;
  readonly owner: number;
}

export interface StudlessScan {
  readonly supportedPieces: number;
  readonly blocker: number;
}

export interface FollowedRun {
  readonly moves: ReadonlyArray<TrackMove>;
  readonly progressLdu: Float64Array;
  readonly blocked: TrackMove | null;
  readonly blocker: number;
  readonly joined: boolean;
}

export type StrokeJoin =
  | { readonly kind: "exact"; readonly moves: ReadonlyArray<TrackMove> }
  | { readonly kind: "impossible" }
  | { readonly kind: "blocked"; readonly blocker: number }
  | { readonly kind: "limit" };

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const LOOKAHEAD_PIECES = 3;
const HEADING_WEIGHT_PIECES_PER_RADIAN = 0.5;
const JOIN_SLACK_PIECES = 2;
const JOIN_BACKOFF_PIECES = 4;
const MAX_FOLLOWED_PIECES = 512;
const NO_MOVES: ReadonlyArray<TrackMove> = [];

function headingError(heading: number, tangent: number): number {
  if (Number.isNaN(tangent)) return 0;
  const d = heading * HEADING_RADIANS - tangent;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

export class StrokeRouter {
  readonly startReachLdu: number;
  private readonly projection = new Float64Array(PROJECTION_FLOATS);
  private readonly query = new Float64Array(PROJECTION_QUERY_FLOATS);
  private readonly branchCosts = new Float64Array(LOOKAHEAD_PIECES + 1);
  private readonly branchX = new Float64Array(LOOKAHEAD_PIECES + 1);
  private readonly branchZ = new Float64Array(LOOKAHEAD_PIECES + 1);
  private readonly branchProgress = new Float64Array(LOOKAHEAD_PIECES + 1);
  private readonly branchHeading = new Int32Array(LOOKAHEAD_PIECES + 1);
  private readonly coefficients = new Float64Array(ZETA16_COEFFICIENT_COUNT);
  private readonly next = new Float64Array(ZETA16_COEFFICIENT_COUNT);
  private readonly stepLdu = new Float64Array(2);
  private readonly originLdu = new Float64Array(2);
  private originPose: Pose16 | null = null;
  private finalStart: Pose16 | null = null;
  private finalGoal: Pose16 | null = null;
  private finalCoefficients: Float64Array | null = null;
  private readonly chosenFrames = new Int32Array(MAX_FOLLOWED_PIECES);
  private readonly chosenProgress = new Float64Array(MAX_FOLLOWED_PIECES + 1);
  private lastMoves: ReadonlyArray<TrackMove> = NO_MOVES;
  private readonly joinLimits = new Int32Array(JOIN_BACKOFF_PIECES + 1);
  private readonly lastJoinLimits = new Int32Array(JOIN_BACKOFF_PIECES + 1);
  private lastJoinLimitCount = -1;
  private lastJoin: StrokeJoin | null = null;
  private lastJoinStart: Pose16 | null = null;
  private lastJoinMoves: ReadonlyArray<TrackMove> | null = null;
  private lastJoinGoal: StrokeGoal | null = null;
  private lastJoinSite: StrokeSite | null = null;
  private lastScan: StudlessScan | null = null;
  private lastScanStart: Pose16 | null = null;
  private lastScanMoves: ReadonlyArray<TrackMove> | null = null;
  private lastScanSite: StrokeSite | null = null;
  private lastScanGoalOwner = NO_OBSTACLE;
  private readonly windowLdu: number;
  private readonly tangentSpanLdu: number;
  private readonly headingWeightLdu: number;

  constructor(private readonly outlines: KitOutlines) {
    this.startReachLdu = outlines.maxLengthLdu / 2;
    this.windowLdu = 2 * outlines.maxLengthLdu;
    this.tangentSpanLdu = outlines.maxLengthLdu / 2;
    this.headingWeightLdu = HEADING_WEIGHT_PIECES_PER_RADIAN * outlines.maxLengthLdu;
  }

  follow(
    start: Pose16,
    stroke: StrokePath,
    site: StrokeSite,
    goal: StrokeGoal | null = null,
  ): FollowedRun {
    const { outlines, coefficients, next, stepLdu, chosenFrames, chosenProgress } = this;
    const { clearance } = site;
    const origin = this.originOf(start);
    const originX = origin[0] ?? 0;
    const originZ = origin[1] ?? 0;
    coefficients.fill(0);
    const final = goal ? this.finalOf(goal.pose, start) : null;
    const finalHeading = goal ? normalizeHeading16(goal.pose.heading + HALF_TURN_16) : -1;
    let heading = start.heading;
    let x = originX;
    let z = originZ;
    let progress = this.progressOf(stroke, x, z, 0);
    let count = 0;
    chosenProgress[0] = progress;
    let laidLdu = 0;
    let blocked: TrackMove | null = null;
    let blocker = NO_OBSTACLE;
    let joined = false;
    const mark = clearance.count;
    try {
      while (count < MAX_FOLLOWED_PIECES) {
        const chosen = this.choose(stroke, x, z, heading, progress);
        const frame = outlines.frames[chosen];
        if (!frame) break;
        if (stroke.length - progress < frame.lengthLdu / 2) break;
        if (laidLdu + frame.lengthLdu > stroke.length + outlines.maxLengthLdu) break;
        next.set(coefficients);
        addRotated(frame.delta, heading, next, 1);
        const nextHeading = normalizeHeading16(heading + frame.turn);
        const lands =
          final !== null && nextHeading === finalHeading && sameCoefficients(next, final);
        const hit = outlines.blocker(
          clearance,
          frame,
          heading,
          x,
          z,
          count === 0 ? site.startOwner : mark + count - 1,
          lands && goal ? goal.owner : NO_OBSTACLE,
        );
        if (hit !== NO_OBSTACLE) {
          blocked = frame.move;
          blocker = hit >= mark ? RUN_CROSSING : hit;
          break;
        }
        outlines.addTo(clearance, frame, heading, x, z);
        chosenFrames[count] = chosen;
        count++;
        coefficients.set(next);
        heading = nextHeading;
        coefficientsLduInto(coefficients, stepLdu);
        x = originX + (stepLdu[0] ?? 0);
        z = originZ + (stepLdu[1] ?? 0);
        progress = this.progressOf(stroke, x, z, progress);
        chosenProgress[count] = progress;
        laidLdu += frame.lengthLdu;
        if (lands) {
          joined = true;
          break;
        }
      }
    } finally {
      clearance.truncate(mark);
    }
    const progressLdu = new Float64Array(count + 1);
    for (let i = 0; i <= count; i++) progressLdu[i] = chosenProgress[i] ?? 0;
    return { moves: this.chosenMoves(count), progressLdu, blocked, blocker, joined };
  }

  private originOf(start: Pose16): Float64Array {
    if (start !== this.originPose) {
      const origin = poseLdu(start);
      this.originLdu[0] = origin.x;
      this.originLdu[1] = origin.z;
      this.originPose = start;
    }
    return this.originLdu;
  }

  private finalOf(goal: Pose16, start: Pose16): Float64Array {
    const cached = this.finalCoefficients;
    if (cached && goal === this.finalGoal && start === this.finalStart) return cached;
    const final = coefficientNumbers(subtractZeta16(goal.position, start.position));
    this.finalCoefficients = final;
    this.finalGoal = goal;
    this.finalStart = start;
    return final;
  }

  private chosenMoves(count: number): ReadonlyArray<TrackMove> {
    const { frames } = this.outlines;
    const last = this.lastMoves;
    let same = last.length === count;
    for (let i = 0; same && i < count; i++) {
      same = last[i] === frames[this.chosenFrames[i] ?? 0]?.move;
    }
    if (same) return last;
    const moves: TrackMove[] = [];
    for (let i = 0; i < count; i++) {
      const frame = frames[this.chosenFrames[i] ?? 0];
      if (frame) moves.push(frame.move);
    }
    this.lastMoves = moves;
    return moves;
  }

  join(
    start: Pose16,
    stroke: StrokePath,
    followed: FollowedRun,
    goal: StrokeGoal,
    site: StrokeSite,
    closeWhole: (site: ClosureSite) => ClosureResult,
  ): StrokeJoin {
    if (followed.joined) return { kind: "exact", moves: followed.moves };
    const { supportedPieces } = this.studlessScan(start, followed.moves, site, NO_OBSTACLE);
    const backoffFrom = Math.min(followed.moves.length, supportedPieces);
    const backoffTo = Math.max(1, backoffFrom - JOIN_BACKOFF_PIECES);
    const limits = this.backoffLimits(stroke, followed, backoffFrom, backoffTo);
    const last = this.lastJoin;
    if (
      last !== null &&
      start === this.lastJoinStart &&
      followed.moves === this.lastJoinMoves &&
      goal === this.lastJoinGoal &&
      site === this.lastJoinSite &&
      this.sameJoinLimits(limits)
    ) {
      return last;
    }
    const joined = this.searchJoin(start, followed, goal, site, closeWhole, backoffFrom, backoffTo);
    this.lastJoin = joined;
    this.lastJoinStart = start;
    this.lastJoinMoves = followed.moves;
    this.lastJoinGoal = goal;
    this.lastJoinSite = site;
    this.lastJoinLimits.set(this.joinLimits);
    this.lastJoinLimitCount = limits;
    return joined;
  }

  private backoffLimits(
    stroke: StrokePath,
    followed: FollowedRun,
    backoffFrom: number,
    backoffTo: number,
  ): number {
    let count = 0;
    for (let k = backoffFrom; k >= backoffTo; k--) {
      const remaining = Math.max(0, stroke.length - (followed.progressLdu[k] ?? 0));
      this.joinLimits[count++] =
        Math.ceil(remaining / this.outlines.minLengthLdu) + JOIN_SLACK_PIECES;
    }
    return count;
  }

  private sameJoinLimits(count: number): boolean {
    if (count !== this.lastJoinLimitCount) return false;
    for (let i = 0; i < count; i++) {
      if (this.joinLimits[i] !== this.lastJoinLimits[i]) return false;
    }
    return true;
  }

  private searchJoin(
    start: Pose16,
    followed: FollowedRun,
    goal: StrokeGoal,
    site: StrokeSite,
    closeWhole: (site: ClosureSite) => ClosureResult,
    backoffFrom: number,
    backoffTo: number,
  ): StrokeJoin {
    const { outlines } = this;
    const { kit } = outlines;
    const { clearance, support } = site;
    const mark = clearance.count;
    const poses: Pose16[] = [start];
    try {
      let pose = start;
      for (const move of followed.moves) {
        const entry = poseLdu(pose);
        outlines.addTo(clearance, outlines.frameFor(move), pose.heading, entry.x, entry.z);
        pose = advance(pose, move);
        poses.push(pose);
      }
      for (let k = backoffFrom; k >= backoffTo; k--) {
        clearance.truncate(mark + k);
        const from = poses[k];
        if (!from) continue;
        const maxPieces = this.joinLimits[backoffFrom - k] ?? 0;
        const run = shortClearClosure(
          kit,
          from,
          goal.pose,
          { clearance, support, outlines, startOwner: mark + k - 1, goalOwner: goal.owner },
          maxPieces,
        );
        if (run) {
          return { kind: "exact", moves: [...followed.moves.slice(0, k), ...runMoves(kit, run)] };
        }
      }
      clearance.truncate(mark);
      const whole = closeWhole({
        clearance,
        support,
        outlines,
        startOwner: site.startOwner,
        goalOwner: goal.owner,
      });
      switch (whole.kind) {
        case "exact":
          return { kind: "exact", moves: runMoves(kit, whole.run) };
        case "impossible":
        case "blocked":
        case "limit":
          return whole;
        default: {
          const unhandled: never = whole;
          throw new Error(`unhandled closure ${String(unhandled)}`);
        }
      }
    } finally {
      clearance.truncate(mark);
    }
  }

  studlessScan(
    start: Pose16,
    moves: ReadonlyArray<TrackMove>,
    site: StrokeSite,
    goalOwner: number,
  ): StudlessScan {
    const last = this.lastScan;
    if (
      last !== null &&
      start === this.lastScanStart &&
      moves === this.lastScanMoves &&
      site === this.lastScanSite &&
      goalOwner === this.lastScanGoalOwner
    ) {
      return last;
    }
    const scan = this.scanStudless(start, moves, site, goalOwner);
    this.lastScan = scan;
    this.lastScanStart = start;
    this.lastScanMoves = moves;
    this.lastScanSite = site;
    this.lastScanGoalOwner = goalOwner;
    return scan;
  }

  private scanStudless(
    start: Pose16,
    moves: ReadonlyArray<TrackMove>,
    site: StrokeSite,
    goalOwner: number,
  ): StudlessScan {
    const { outlines } = this;
    const { clearance, support } = site;
    const mark = clearance.count;
    try {
      let pose = start;
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        if (!move) continue;
        const frame = outlines.frameFor(move);
        const at = poseLdu(pose);
        const top = outlines.blockerBesideJoins(
          support.studlessTops,
          clearance,
          frame,
          pose.heading,
          at.x,
          at.z,
          i === 0 ? site.startOwner : mark + i - 1,
          i === moves.length - 1 ? goalOwner : NO_OBSTACLE,
        );
        if (top !== NO_OBSTACLE && !support.supported(frame, pose)) {
          return { supportedPieces: i, blocker: studlessTopBlocker(top) };
        }
        outlines.addTo(clearance, frame, pose.heading, at.x, at.z);
        pose = advance(pose, move);
      }
      return { supportedPieces: moves.length, blocker: NO_OBSTACLE };
    } finally {
      clearance.truncate(mark);
    }
  }

  private progressOf(stroke: StrokePath, x: number, z: number, from: number): number {
    this.projectFrom(stroke, x, z, from);
    return Math.max(from, this.projection[PROJECTED_ARC] ?? from);
  }

  private projectFrom(stroke: StrokePath, x: number, z: number, from: number): void {
    const query = this.query;
    query[QUERY_X] = x;
    query[QUERY_Z] = z;
    query[QUERY_FROM_ARC] = from;
    query[QUERY_TO_ARC] = from + this.windowLdu;
    query[QUERY_TANGENT_HALF_SPAN] = this.tangentSpanLdu;
    stroke.project(query, this.projection);
  }

  private choose(
    stroke: StrokePath,
    x: number,
    z: number,
    heading: number,
    progress: number,
  ): number {
    const costs = this.branchCosts;
    this.branchX[LOOKAHEAD_PIECES] = x;
    this.branchZ[LOOKAHEAD_PIECES] = z;
    this.branchHeading[LOOKAHEAD_PIECES] = heading;
    this.branchProgress[LOOKAHEAD_PIECES] = progress;
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let f = 0; f < this.outlines.frames.length; f++) {
      this.branch(stroke, f, LOOKAHEAD_PIECES);
      const cost = costs[LOOKAHEAD_PIECES] ?? Number.POSITIVE_INFINITY;
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
      }
    }
    return best;
  }

  private branch(stroke: StrokePath, f: number, depth: number): void {
    const costs = this.branchCosts;
    const frame = this.outlines.frames[f];
    if (!frame) {
      costs[depth] = Number.POSITIVE_INFINITY;
      return;
    }
    const heading = this.branchHeading[depth] ?? 0;
    const progress = this.branchProgress[depth] ?? 0;
    const ex = (this.branchX[depth] ?? 0) + (frame.exitX[heading] ?? 0);
    const ez = (this.branchZ[depth] ?? 0) + (frame.exitZ[heading] ?? 0);
    const exitHeading = normalizeHeading16(heading + frame.turn);
    const p = this.projection;
    this.projectFrom(stroke, ex, ez, progress);
    const arc = Math.max(progress, p[PROJECTED_ARC] ?? progress);
    const cost =
      (p[PROJECTED_DISTANCE] ?? 0) +
      this.headingWeightLdu * headingError(exitHeading, p[PROJECTED_TANGENT] ?? Number.NaN);
    if (depth === 1 || arc >= stroke.length) {
      costs[depth] = cost;
      return;
    }
    const child = depth - 1;
    this.branchX[child] = ex;
    this.branchZ[child] = ez;
    this.branchHeading[child] = exitHeading;
    this.branchProgress[child] = arc;
    let bestChild = Number.POSITIVE_INFINITY;
    for (let g = 0; g < this.outlines.frames.length; g++) {
      this.branch(stroke, g, child);
      const childCost = costs[child] ?? Number.POSITIVE_INFINITY;
      if (childCost < bestChild) bestChild = childCost;
    }
    costs[depth] = cost + bestChild;
  }
}

function sameCoefficients(a: Float64Array, b: Float64Array): boolean {
  for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) if (a[k] !== b[k]) return false;
  return true;
}
