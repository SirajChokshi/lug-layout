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

export type ClosureState = "exact" | "impossible" | "blocked" | "limit" | null;
export type TrackRefusal = "impossible" | "blocked" | "limit";

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
  owner(end: number): number;
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

export interface TrackPieceOutline {
  readonly outline: Float64Array;
  readonly placement: Pose16;
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
    pieces: ReadonlyArray<TrackPieceOutline | null>,
    private readonly obstacles: TrackObstacles,
  ) {
    this.pieceIds = new Int32Array(pieces.length).fill(NO_OBSTACLE);
    pieces.forEach((piece, placement) => {
      if (piece) this.pieceIds[placement] = this.clearance.addPiece(piece.outline, piece.placement);
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
  private readonly site: StrokeSite;
  private readonly wholeClosures = new Map<string, ClosureResult>();
  private readonly at = new Float64Array(2);
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
    private readonly field: DragField,
    private readonly ends: DragEnds,
    private readonly now: () => number,
    private readonly press: DragPress,
    readonly fromEnd: number | null,
  ) {
    this.stroke = new StrokePath(press.hitX, press.hitZ, STROKE_SPACING_LDU);
    this.start = fromEnd === null ? null : ends.pose(fromEnd);
    this.site = {
      clearance: field.clearance,
      startOwner: fromEnd === null ? NO_OBSTACLE : ends.owner(fromEnd),
    };
  }

  extend(hitX: number, hitZ: number): void {
    this.stroke.extend(hitX, hitZ);
    if (this.fromEnd === null) this.start = this.newRunStart();
    const start = this.start;
    if (!start) return;
    const target = this.ends.near(hitX, hitZ, this.fromEnd);
    const goal: StrokeGoal | null =
      target === null ? null : { pose: this.ends.pose(target), owner: this.ends.owner(target) };
    this.target = target;
    this.goal = goal?.pose ?? null;
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
