import {
  NO_OBSTACLE,
  RUN_CROSSING,
  StrokePath,
  TrackClearance,
  layMoves,
  solveClosure,
  studlessTopOf,
  type ClosureResult,
  type ClosureSite,
  type DrawingKit,
  type FollowedRun,
  type MoveFrame,
  type SearchBudget,
  type SupportSite,
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

export type ClosureState =
  | "exact"
  | "impossible"
  | "blocked"
  | "limit"
  | "pending"
  | "too-steep"
  | null;
export type TrackRefusal = "impossible" | "blocked" | "limit" | "pending" | "too-steep";
export type DragRefusal = Exclude<TrackRefusal, "pending">;
export type JoinWithheld = "unsupported" | "pending";

export type TrackBlockView =
  | { readonly kind: "track" }
  | { readonly kind: "run" }
  | { readonly kind: "model"; readonly label: string; readonly unseated: boolean };

export function trackBlockText(block: TrackBlockView): string {
  switch (block.kind) {
    case "track":
      return "cross the track laid there";
    case "run":
      return "cross this run";
    case "model":
      return block.unseated
        ? `sit on ${block.label} where it has no studs`
        : `run into ${block.label}`;
    default: {
      const unhandled: never = block;
      throw new Error(`unhandled block ${String(unhandled)}`);
    }
  }
}

export interface TrackDragView {
  readonly pieces: number;
  readonly straights: number;
  readonly curves: number;
  readonly missStuds: number;
  readonly closure: ClosureState;
  readonly blocked: TrackBlockView | null;
  readonly withheld: JoinWithheld | null;
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
  readonly goalEnd: number | null;
  readonly blocked: TrackBlockView | null;
  readonly withheld: JoinWithheld | null;
}

const QUARTER_TURN_RADIANS = Math.PI / 2;
const MIN_START_DRAG_LDU = STUD_LDU;
const STROKE_SPACING_LDU = STUD_LDU / 2;
export const CLOSURE_BUDGET_MS = 30;

export type SupportedPiece = (
  frame: MoveFrame,
  pose: Pose16,
  studlessTops: TrackClearance,
) => boolean;

export class DragField {
  readonly clearance = new TrackClearance();
  readonly support: SupportSite;
  private readonly pieceIds: Int32Array;
  private readonly rectBase: number;
  private readonly solidRectOf: Int32Array;
  private readonly studlessRectOf: Int32Array;

  constructor(
    outlines: ReadonlyArray<Float64Array | null>,
    private readonly obstacles: TrackObstacles,
    supported: SupportedPiece,
  ) {
    const studlessTops = new TrackClearance();
    this.support = {
      studlessTops,
      supported: (frame, pose) => supported(frame, pose, studlessTops),
    };
    this.pieceIds = new Int32Array(outlines.length).fill(NO_OBSTACLE);
    outlines.forEach((outline, placement) => {
      if (outline) this.pieceIds[placement] = this.clearance.add(outline);
    });
    this.rectBase = this.clearance.count;
    const { rects, unseated } = obstacles;
    const solid: number[] = [];
    const studless: number[] = [];
    for (let rect = 0; rect * OBSTACLE_RECT_FLOATS < rects.length; rect++) {
      const at = rect * OBSTACLE_RECT_FLOATS;
      const onStudlessTop = unseated[rect] === 1;
      (onStudlessTop ? studless : solid).push(rect);
      (onStudlessTop ? studlessTops : this.clearance).addRect(
        rects[at] ?? 0,
        rects[at + 1] ?? 0,
        rects[at + 2] ?? 0,
        rects[at + 3] ?? 0,
      );
    }
    this.solidRectOf = Int32Array.from(solid);
    this.studlessRectOf = Int32Array.from(studless);
    for (const outline of obstacles.outlines) this.clearance.add(outline);
  }

  pieceOwner(placement: number | undefined): number {
    return placement === undefined ? NO_OBSTACLE : (this.pieceIds[placement] ?? NO_OBSTACLE);
  }

  get tracks(): number {
    return this.rectBase;
  }

  ownedIds(placements: ReadonlySet<number>, owners: ReadonlySet<number>): Int32Array {
    const ids: number[] = [];
    for (const placement of placements) {
      const id = this.pieceOwner(placement);
      if (id !== NO_OBSTACLE) ids.push(id);
    }
    this.solidRectOf.forEach((rect, k) => {
      if (owners.has(this.obstacles.owners[rect] ?? NO_OBSTACLE)) ids.push(this.rectBase + k);
    });
    return Int32Array.from(ids);
  }

  isTrack(blocker: number): boolean {
    return blocker >= 0 && blocker < this.rectBase;
  }

  describe(blocker: number): TrackBlockView | null {
    if (blocker === RUN_CROSSING) return { kind: "run" };
    const top = studlessTopOf(blocker);
    if (top !== NO_OBSTACLE) return this.modelView(this.studlessRectOf[top] ?? -1);
    if (blocker < 0) return null;
    if (blocker < this.rectBase) return { kind: "track" };
    const rect = blocker - this.rectBase;
    if (rect < this.solidRectOf.length) return this.modelView(this.solidRectOf[rect] ?? -1);
    const owner = this.obstacles.outlineOwners[rect - this.solidRectOf.length] ?? -1;
    return { kind: "model", label: this.obstacles.labels[owner] ?? "", unseated: false };
  }

  private modelView(rect: number): TrackBlockView {
    const owner = this.obstacles.owners[rect] ?? -1;
    return {
      kind: "model",
      label: this.obstacles.labels[owner] ?? "",
      unseated: this.obstacles.unseated[rect] === 1,
    };
  }
}

function unjoined(followed: FollowedRun): FollowedRun {
  if (!followed.joined) return followed;
  return {
    ...followed,
    moves: followed.moves.slice(0, -1),
    progressLdu: followed.progressLdu.slice(0, -1),
    joined: false,
  };
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
  private withheld: JoinWithheld | null = null;
  private target: number | null = null;
  private goal: Pose16 | null = null;
  private missStuds = 0;
  private revised = 0;

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

  get revision(): number {
    return this.revised;
  }

  reseat(field: DragField, seatsPending: boolean): void {
    this.revised++;
    this.field = field;
    this.seatsPending = seatsPending;
    this.site = this.siteOf(field);
    this.wholeClosures.clear();
  }

  private siteOf(field: DragField): StrokeSite {
    const start = this.fromEnd === null ? undefined : this.ends.placement(this.fromEnd);
    return {
      clearance: field.clearance,
      support: field.support,
      startOwner: field.pieceOwner(start),
    };
  }

  private owner(end: number): number {
    return this.field.pieceOwner(this.ends.placement(end));
  }

  extend(hitX: number, hitZ: number): void {
    this.revised++;
    this.stroke.extend(hitX, hitZ);
    if (this.fromEnd === null) this.start = this.newRunStart();
    const start = this.start;
    if (!start) return;
    const target = this.ends.near(hitX, hitZ, this.fromEnd);
    const goal: StrokeGoal | null =
      target === null ? null : { pose: this.ends.pose(target), owner: this.owner(target) };
    this.target = target;
    this.goal = goal?.pose ?? null;
    this.withheld = null;
    const followed = this.router.follow(start, this.stroke, this.site, goal);
    if (!goal) {
      this.closure = null;
      this.moves = followed.moves;
      this.blockedMove = followed.blocked;
      this.blocker = followed.blocker;
    } else if (this.seatsPending) {
      this.withhold("pending", unjoined(followed), NO_OBSTACLE);
    } else {
      this.joinOrWithhold(start, followed, goal);
    }
    const end = zeta16ToStuds(layMoves(start, this.moves).end.position);
    this.missStuds = Math.hypot(end.x - hitX / STUD_LDU, end.z - hitZ / STUD_LDU);
  }

  private joinOrWithhold(start: Pose16, followed: FollowedRun, goal: StrokeGoal): void {
    if (followed.joined) {
      this.joinLanded(start, followed, goal);
      return;
    }
    const join = this.router.join(start, this.stroke, followed, goal, this.site, (site) =>
      this.closeWhole(start, goal, site),
    );
    if (join.kind === "blocked" && studlessTopOf(join.blocker) !== NO_OBSTACLE) {
      this.withhold("unsupported", followed, join.blocker);
      return;
    }
    this.closure = join.kind;
    this.moves = join.kind === "exact" ? join.moves : [];
    this.blockedMove = null;
    this.blocker = join.kind === "blocked" ? join.blocker : NO_OBSTACLE;
  }

  private joinLanded(start: Pose16, followed: FollowedRun, goal: StrokeGoal): void {
    const top = this.router.studlessScan(start, followed.moves, this.site, goal.owner).blocker;
    if (top === NO_OBSTACLE) {
      this.joined(followed.moves);
      return;
    }
    const short = unjoined(followed);
    const detour = this.router.join(start, this.stroke, short, goal, this.site, (site) =>
      this.closeWhole(start, goal, site),
    );
    if (detour.kind === "exact") this.joined(detour.moves);
    else this.withhold("unsupported", short, top);
  }

  private joined(moves: ReadonlyArray<TrackMove>): void {
    this.closure = "exact";
    this.moves = moves;
    this.blockedMove = null;
    this.blocker = NO_OBSTACLE;
  }

  private withhold(reason: JoinWithheld, followed: FollowedRun, joinBlocker: number): void {
    this.withheld = reason;
    this.closure = reason === "pending" ? "pending" : "blocked";
    this.moves = followed.moves;
    this.blockedMove = followed.blocked;
    this.blocker = joinBlocker === NO_OBSTACLE ? followed.blocker : joinBlocker;
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
      goalEnd: this.goal === null ? null : this.target,
      blocked: this.field.describe(this.blocker),
      withheld: this.withheld,
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
      withheld: this.withheld,
      fromOpenEnd: this.fromEnd !== null,
      solveMs,
    };
  }

  targetView(): DragTargetView | null {
    if (this.target === null) return null;
    return { end: this.target, joins: this.closure === "exact" };
  }
}
