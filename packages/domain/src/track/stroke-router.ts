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
  coefficientsLdu,
  type KitOutlines,
} from "./kit-outlines.ts";
import {
  PROJECTED_ARC,
  PROJECTED_DISTANCE,
  PROJECTED_TANGENT,
  PROJECTION_FLOATS,
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
  readonly progressLdu: ReadonlyArray<number>;
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

function headingError(heading: number, tangent: number): number {
  if (Number.isNaN(tangent)) return 0;
  const d = heading * HEADING_RADIANS - tangent;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

export class StrokeRouter {
  readonly startReachLdu: number;
  private readonly projection = new Float64Array(PROJECTION_FLOATS);
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
    const { outlines } = this;
    const { clearance } = site;
    const origin = poseLdu(start);
    const coefficients = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const next = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const final = goal
      ? coefficientNumbers(subtractZeta16(goal.pose.position, start.position))
      : null;
    const finalHeading = goal ? normalizeHeading16(goal.pose.heading + HALF_TURN_16) : -1;
    let heading = start.heading;
    let x = origin.x;
    let z = origin.z;
    let progress = this.progressOf(stroke, x, z, 0);
    const moves: TrackMove[] = [];
    const progressLdu = [progress];
    let laidLdu = 0;
    let blocked: TrackMove | null = null;
    let blocker = NO_OBSTACLE;
    let joined = false;
    const mark = clearance.count;
    try {
      while (moves.length < MAX_FOLLOWED_PIECES) {
        const frame = outlines.frames[this.choose(stroke, x, z, heading, progress)];
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
          moves.length === 0 ? site.startOwner : mark + moves.length - 1,
          lands && goal ? goal.owner : NO_OBSTACLE,
        );
        if (hit !== NO_OBSTACLE) {
          blocked = frame.move;
          blocker = hit >= mark ? RUN_CROSSING : hit;
          break;
        }
        outlines.addTo(clearance, frame, heading, x, z);
        moves.push(frame.move);
        coefficients.set(next);
        heading = nextHeading;
        const [dx, dz] = coefficientsLdu(coefficients);
        x = origin.x + dx;
        z = origin.z + dz;
        progress = this.progressOf(stroke, x, z, progress);
        progressLdu.push(progress);
        laidLdu += frame.lengthLdu;
        if (lands) {
          joined = true;
          break;
        }
      }
    } finally {
      clearance.truncate(mark);
    }
    return { moves, progressLdu, blocked, blocker, joined };
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
    const { outlines } = this;
    const { kit } = outlines;
    const { clearance, support } = site;
    const { supportedPieces } = this.studlessScan(start, followed.moves, site, NO_OBSTACLE);
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
      const backoffFrom = Math.min(followed.moves.length, supportedPieces);
      const backoffTo = Math.max(1, backoffFrom - JOIN_BACKOFF_PIECES);
      for (let k = backoffFrom; k >= backoffTo; k--) {
        clearance.truncate(mark + k);
        const from = poses[k];
        if (!from) continue;
        const remaining = Math.max(0, stroke.length - (followed.progressLdu[k] ?? 0));
        const maxPieces = Math.ceil(remaining / outlines.minLengthLdu) + JOIN_SLACK_PIECES;
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
    stroke.project(x, z, from, from + this.windowLdu, this.tangentSpanLdu, this.projection);
    return Math.max(from, this.projection[PROJECTED_ARC] ?? from);
  }

  private choose(
    stroke: StrokePath,
    x: number,
    z: number,
    heading: number,
    progress: number,
  ): number {
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let f = 0; f < this.outlines.frames.length; f++) {
      const cost = this.branch(stroke, f, x, z, heading, progress, LOOKAHEAD_PIECES);
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
      }
    }
    return best;
  }

  private branch(
    stroke: StrokePath,
    f: number,
    x: number,
    z: number,
    heading: number,
    progress: number,
    depth: number,
  ): number {
    const frame = this.outlines.frames[f];
    if (!frame) return Number.POSITIVE_INFINITY;
    const ex = x + (frame.exitX[heading] ?? 0);
    const ez = z + (frame.exitZ[heading] ?? 0);
    const exitHeading = normalizeHeading16(heading + frame.turn);
    const p = this.projection;
    stroke.project(ex, ez, progress, progress + this.windowLdu, this.tangentSpanLdu, p);
    const arc = Math.max(progress, p[PROJECTED_ARC] ?? progress);
    const cost =
      (p[PROJECTED_DISTANCE] ?? 0) +
      this.headingWeightLdu * headingError(exitHeading, p[PROJECTED_TANGENT] ?? Number.NaN);
    if (depth === 1 || arc >= stroke.length) return cost;
    let bestChild = Number.POSITIVE_INFINITY;
    for (let g = 0; g < this.outlines.frames.length; g++) {
      const child = this.branch(stroke, g, ex, ez, exitHeading, arc, depth - 1);
      if (child < bestChild) bestChild = child;
    }
    return cost + bestChild;
  }
}

function sameCoefficients(a: Float64Array, b: Float64Array): boolean {
  for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) if (a[k] !== b[k]) return false;
  return true;
}
