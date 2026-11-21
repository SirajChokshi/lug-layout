import {
  NO_OBSTACLE,
  RUN_CROSSING,
  StrokePath,
  TrackClearance,
  layMoves,
  solveClosure,
  type ClosureResult,
  type ClosureSite,
  type DrawingKit,
  type SearchBudget,
  type StrokeGoal,
  type StrokeRouter,
  type StrokeSite,
  type TrackMove,
} from "@brr/domain";
import {
  QUARTER_TURN_16,
  STUD_LDU,
  normalizeHeading16,
  pose16,
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { OBSTACLE_RECT_FLOATS, type TrackObstacles } from "./track-obstacles.ts";

export type ClosureState = "exact" | "impossible" | "blocked" | "limit" | "pending" | null;
export type TrackRefusal = "impossible" | "blocked" | "limit" | "pending";

export type TrackBlockView =
  | { readonly kind: "track" }
  | { readonly kind: "run" }
  | { readonly kind: "model"; readonly label: string; readonly unseated: boolean };

export interface TrackDragView {
  readonly pieces: number;
  readonly straights: number;
  readonly curves: number;
  readonly missStuds: number;
  readonly closure: ClosureState;
  readonly blocked: TrackBlockView | null;
  readonly fromOpenEnd: boolean;
  readonly solveMs: number;
}

export interface DragTargetView {
  readonly end: number;
  readonly joins: boolean;
}

export interface DragEnds {
  near(xLdu: number, zLdu: number, except: number | null): number | null;
  pose(end: number): Pose16;
  placement(end: number): number | undefined;
}

export interface DragPress {
  readonly hitX: number;
  readonly hitZ: number;
  readonly latticeX: number;
  readonly latticeZ: number;
}

export interface DragRoute {
  readonly start: Pose16 | null;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly blockedMove: TrackMove | null;
  readonly closure: ClosureState;
  readonly goal: Pose16 | null;
  readonly blocked: TrackBlockView | null;
}

const QUARTER_TURN_RADIANS = Math.PI / 2;
const MIN_START_DRAG_LDU = STUD_LDU;
const STROKE_SPACING_LDU = STUD_LDU / 2;
const CLOSURE_BUDGET_MS = 30;

export class DragField {
  readonly clearance = new TrackClearance();
  private readonly pieceIds: Int32Array;
  private readonly rectBase: number;

  constructor(
    outlines: ReadonlyArray<Float64Array | null>,
    private readonly obstacles: TrackObstacles,
  ) {
    this.pieceIds = new Int32Array(outlines.length).fill(NO_OBSTACLE);
    outlines.forEach((outline, placement) => {
      if (outline) this.pieceIds[placement] = this.clearance.add(outline);
    });
    this.rectBase = this.clearance.count;
    const { rects } = obstacles;
    for (let r = 0; r < rects.length; r += OBSTACLE_RECT_FLOATS) {
      this.clearance.addRect(
        rects[r] ?? 0,
        rects[r + 1] ?? 0,
        rects[r + 2] ?? 0,
        rects[r + 3] ?? 0,
      );
    }
  }

  pieceOwner(placement: number | undefined): number {
    return placement === undefined ? NO_OBSTACLE : (this.pieceIds[placement] ?? NO_OBSTACLE);
  }

  describe(blocker: number): TrackBlockView | null {
    if (blocker === RUN_CROSSING) return { kind: "run" };
    if (blocker === NO_OBSTACLE || blocker < 0) return null;
    if (blocker < this.rectBase) return { kind: "track" };
    const rect = blocker - this.rectBase;
    const owner = this.obstacles.owners[rect] ?? -1;
    return {
      kind: "model",
      label: this.obstacles.labels[owner] ?? "",
      unseated: this.obstacles.unseated[rect] === 1,
    };
  }
}

export class TrackDrag {
  private readonly stroke: StrokePath;
  private readonly wholeClosures = new Map<string, ClosureResult>();
  private readonly at = new Float64Array(2);
  private field: DragField;
  private site: StrokeSite;
  private seatsPending: boolean;
  private start: Pose16 | null;
  private moves: ReadonlyArray<TrackMove> = [];
  private blockedMove: TrackMove | null = null;
  private blocker = NO_OBSTACLE;
  private closure: ClosureState = null;
  private target: number | null = null;
  private goal: Pose16 | null = null;
  private missStuds = 0;

  constructor(
    private readonly kit: DrawingKit,
    private readonly router: StrokeRouter,
    private readonly ends: DragEnds,
    private readonly now: () => number,
    private readonly press: DragPress,
    readonly fromEnd: number | null,
    field: DragField,
    seatsPending: boolean,
  ) {
    this.stroke = new StrokePath(press.hitX, press.hitZ, STROKE_SPACING_LDU);
    this.start = fromEnd === null ? null : ends.pose(fromEnd);
    this.field = field;
    this.seatsPending = seatsPending;
    this.site = this.siteOf(field);
  }

  reseat(field: DragField, seatsPending: boolean): void {
    this.field = field;
    this.seatsPending = seatsPending;
    this.site = this.siteOf(field);
    this.wholeClosures.clear();
  }

  private siteOf(field: DragField): StrokeSite {
    const start = this.fromEnd === null ? undefined : this.ends.placement(this.fromEnd);
    return { clearance: field.clearance, startOwner: field.pieceOwner(start) };
  }

  private owner(end: number): number {
    return this.field.pieceOwner(this.ends.placement(end));
  }

  extend(hitX: number, hitZ: number): void {
    this.stroke.extend(hitX, hitZ);
    if (this.fromEnd === null) this.start = this.newRunStart();
    const start = this.start;
    if (!start) return;
    const target = this.ends.near(hitX, hitZ, this.fromEnd);
    const goal: StrokeGoal | null =
      target === null ? null : { pose: this.ends.pose(target), owner: this.owner(target) };
    this.target = target;
    this.goal = goal?.pose ?? null;
    if (goal && this.seatsPending) {
      this.closure = "pending";
      this.moves = [];
      this.blockedMove = null;
      this.blocker = NO_OBSTACLE;
      this.missStuds = 0;
      return;
    }
    const followed = this.router.follow(start, this.stroke, this.site, goal);
    if (goal) {
      const join = this.router.join(start, this.stroke, followed, goal, this.site, (site) =>
        this.closeWhole(start, goal, site),
      );
      this.closure = join.kind;
      this.moves = join.kind === "exact" ? join.moves : [];
      this.blockedMove = null;
      this.blocker = join.kind === "blocked" ? join.blocker : NO_OBSTACLE;
    } else {
      this.closure = null;
      this.moves = followed.moves;
      this.blockedMove = followed.blocked;
      this.blocker = followed.blocker;
    }
    const end = zeta16ToStuds(layMoves(start, this.moves).end.position);
    this.missStuds = Math.hypot(end.x - hitX / STUD_LDU, end.z - hitZ / STUD_LDU);
  }

  private closeWhole(start: Pose16, goal: StrokeGoal, site: ClosureSite): ClosureResult {
    const key = `${this.target}|${start.heading}|${start.position.join(",")}`;
    const cached = this.wholeClosures.get(key);
    if (cached) return cached;
    const budget: SearchBudget = { now: this.now, limitMs: CLOSURE_BUDGET_MS };
    const result = solveClosure(this.kit, start, goal.pose, budget, site);
    this.wholeClosures.set(key, result);
    return result;
  }

  private newRunStart(): Pose16 | null {
    const { press, stroke } = this;
    const reach = Math.min(stroke.length, this.router.startReachLdu);
    if (reach < MIN_START_DRAG_LDU) return null;
    stroke.pointAt(reach, this.at);
    const dx = (this.at[0] ?? 0) - press.latticeX;
    const dz = (this.at[1] ?? 0) - press.latticeZ;
    const quarterTurns = Math.round(Math.atan2(dz, dx) / QUARTER_TURN_RADIANS);
    const position = zeta16([
      BigInt(press.latticeX / STUD_LDU),
      0n,
      0n,
      0n,
      BigInt(press.latticeZ / STUD_LDU),
      0n,
      0n,
      0n,
    ]);
    return pose16(position, normalizeHeading16(quarterTurns * QUARTER_TURN_16));
  }

  route(): DragRoute {
    return {
      start: this.start,
      moves: this.moves,
      blockedMove: this.blockedMove,
      closure: this.closure,
      goal: this.goal,
      blocked: this.field.describe(this.blocker),
    };
  }

  view(solveMs: number): TrackDragView {
    const straights = this.moves.filter((m) => m.turn === 0).length;
    return {
      pieces: this.moves.length,
      straights,
      curves: this.moves.length - straights,
      missStuds: this.missStuds,
      closure: this.closure,
      blocked: this.field.describe(this.blocker),
      fromOpenEnd: this.fromEnd !== null,
      solveMs,
    };
  }

  targetView(): DragTargetView | null {
    if (this.target === null) return null;
    return { end: this.target, joins: this.closure === "exact" };
  }
}
