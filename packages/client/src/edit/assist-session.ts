import { MateReport, type LatticePose, type ModelConnectors, type OverlapHit } from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import type { FrozenTechnic } from "../connect/frozen-technic.ts";
import type { PartBoxes } from "../connect/part-boxes.ts";
import type { FrozenVolumes } from "../connect/placeable-volumes.ts";
import {
  NOT_WAITING,
  SETTLED_AT_ONCE,
  placementChoice,
  type IPlacementSearch,
  type PlacementChoice,
} from "../connect/placement-search.ts";
import { CursorPick, RESTS_ON_TABLE_Y_PLATES } from "./cursor-pick.ts";
import type { Placeable } from "./placeable.ts";
import type {
  AssistNeighbourhood,
  HoverMateCount,
  HoverRefusalHit,
  HoverWait,
  MagnetOffset,
  PlacedModelView,
  PlacementHover,
  PlacementMode,
} from "./placement-hover.ts";
import { failedLoadText, refusalText } from "./placement-hover-view.ts";

export interface Connected {
  readonly model: ModelConnectors;
  readonly volumes: FrozenVolumes;
  readonly boxes: PartBoxes;
  readonly technic: FrozenTechnic;
}

export interface AssistTarget {
  readonly placeable: Placeable;
  readonly connected: Connected;
  readonly mode: PlacementMode;
}

export interface AssistHost {
  mateCounts(report: MateReport): ReadonlyArray<HoverMateCount>;
  refusalHit(overlap: OverlapHit): HoverRefusalHit | null;
  heldPoseRefusal(placeable: Placeable, pose: LatticePose): string | null;
  restsOn(connected: Connected, pose: LatticePose): ReadonlyArray<PlacedModelView>;
  neighbourhood(): AssistNeighbourhood;
  showGhost(pose: LatticePose): void;
  hoverWait(choice: PlacementChoice): HoverWait | null;
}

export type AssistPhase = "idle" | "held" | "held-due" | "turn-next" | "turn";
export type AssistSlice = "pointer" | "frame" | "commit";
export type AssistFrameOutcome = "quiet" | "published" | "restart";
type HeldStage = "provisional" | "held" | "final";
type TurnMates = Pick<PlacementHover, "turnMates" | "turnJoints">;

const ASSIST_SLICE_MS = 6;
const ASSIST_FRAME_BUDGET_MS = 14;
const ASSIST_UNIT_ALLOWANCE_MS = 2;
const ASSIST_MIN_FRAME_SLICE_MS = 3;
const NEXT_TURN = 1;
const EVERY_TURN = 4;
const NO_MATES: ReadonlyArray<HoverMateCount> = [];
const NO_TURN_MATES: TurnMates = { turnMates: NO_MATES, turnJoints: 0 };

class HoverCell {
  private placeable: Placeable | null = null;
  private x = 0;
  private z = 0;
  private yPlates = 0;
  private rot = 0;
  private mode: PlacementMode = "assist";
  private radiusLdu = 0;
  private revision = -1;

  holds(
    placeable: Placeable,
    pick: CursorPick,
    mode: PlacementMode,
    search: Pick<IPlacementSearch, "revision">,
  ): boolean {
    return (
      placeable === this.placeable &&
      pick.x === this.x &&
      pick.z === this.z &&
      pick.yPlates === this.yPlates &&
      pick.rot === this.rot &&
      mode === this.mode &&
      pick.radiusLdu === this.radiusLdu &&
      search.revision() === this.revision
    );
  }

  keep(
    placeable: Placeable,
    pick: CursorPick,
    mode: PlacementMode,
    search: Pick<IPlacementSearch, "revision">,
  ): void {
    this.placeable = placeable;
    this.x = pick.x;
    this.z = pick.z;
    this.yPlates = pick.yPlates;
    this.rot = pick.rot;
    this.mode = mode;
    this.radiusLdu = pick.radiusLdu;
    this.revision = search.revision();
  }

  forget(): void {
    this.placeable = null;
  }
}

function frameSliceDeadlineMs(frameStartMs: number): number {
  const sliceStartMs = performance.now();
  const left = ASSIST_FRAME_BUDGET_MS - ASSIST_UNIT_ALLOWANCE_MS - (sliceStartMs - frameStartMs);
  return sliceStartMs + Math.min(ASSIST_SLICE_MS, Math.max(ASSIST_MIN_FRAME_SLICE_MS, left));
}

function sliceDeadlineMs(slice: AssistSlice, startedMs: number): number {
  switch (slice) {
    case "pointer":
      return startedMs + ASSIST_SLICE_MS;
    case "frame":
      return frameSliceDeadlineMs(startedMs);
    case "commit":
      return Number.POSITIVE_INFINITY;
    default: {
      const unhandled: never = slice;
      throw new Error(`unhandled assist slice ${String(unhandled)}`);
    }
  }
}

function magnetOffset(cursor: CursorPick, pose: LatticePose): MagnetOffset {
  const dxLdu = pose.x - cursor.x;
  const dzLdu = pose.z - cursor.z;
  const dyPlates = pose.yPlates - cursor.yPlates;
  const dyLdu = dyPlates * PLATE_LDU;
  return { dxLdu, dzLdu, dyPlates, distanceLdu: Math.hypot(dxLdu, dzLdu, dyLdu) };
}

export class AssistSession {
  private phase: AssistPhase = "idle";
  private ticket = SETTLED_AT_ONCE;
  private target: AssistTarget | null = null;
  private readonly pick = new CursorPick();
  private readonly choice = placementChoice();
  private readonly turnChoice = placementChoice();
  private readonly mates = new MateReport();
  private readonly cell = new HoverCell();
  private sliceSinceFrame = false;
  private lastPublishMs = 0;
  private revision = -1;
  private shown: PlacementHover | null = null;
  private shownRefusal: string | null = null;
  private shownYPlates = RESTS_ON_TABLE_Y_PLATES;
  private snapRot = 0;

  constructor(
    private readonly search: IPlacementSearch,
    private readonly host: AssistHost,
  ) {}

  get placement(): PlacementHover | null {
    return this.shown;
  }

  get refusal(): string | null {
    return this.shownRefusal;
  }

  get yPlates(): number {
    return this.shownYPlates;
  }

  get snapTurn(): number | null {
    const shown = this.shown;
    return shown !== null && shown.turnSettled && shown.turnBlocksSnap ? this.snapRot : null;
  }

  aim(target: AssistTarget, pick: CursorPick, startedMs: number): void {
    if (this.shown && this.cell.holds(target.placeable, pick, target.mode, this.search)) return;
    this.drop();
    this.pick.copy(pick);
    this.target = target;
    this.phase = "held";
    const { model, volumes, boxes, technic } = target.connected;
    this.ticket = this.search.begin(
      model,
      volumes,
      boxes,
      technic,
      this.pick,
      RESTS_ON_TABLE_Y_PLATES,
      null,
      this.choice,
    );
    this.cell.keep(target.placeable, pick, target.mode, this.search);
    this.revision = this.search.revision();
    this.sliceSinceFrame = true;
    if (!this.continue(startedMs, "pointer")) this.publish(target, "provisional");
  }

  frame(startMs: number): AssistFrameOutcome {
    const sliced = this.sliceSinceFrame;
    this.sliceSinceFrame = false;
    if (sliced || this.idle()) return "quiet";
    if (this.continue(startMs, "frame")) return "published";
    return this.idle() ? "restart" : "quiet";
  }

  private idle(): boolean {
    return this.phase === "idle";
  }

  commit(): void {
    this.continue(performance.now(), "commit");
  }

  cancel(): void {
    this.drop();
    this.shown = null;
    this.shownRefusal = null;
  }

  leave(): void {
    this.drop();
    this.cell.forget();
    this.shown = null;
  }

  private continue(startedMs: number, slice: AssistSlice): boolean {
    const target = this.target;
    if (!target) return false;
    const deadline = sliceDeadlineMs(slice, startedMs);
    let published = false;
    if (this.phase === "held") {
      if (!this.advance(deadline)) return false;
      this.phase = "held-due";
      if (
        slice === "frame" &&
        performance.now() - startedMs + this.lastPublishMs > ASSIST_FRAME_BUDGET_MS
      ) {
        return false;
      }
    }
    if (this.phase === "held-due") {
      if (this.search.revision() !== this.revision) {
        this.drop();
        this.cell.forget();
        return false;
      }
      if (this.choice.waitingOn !== NOT_WAITING) {
        const failed = this.choice.waitFailed;
        this.drop();
        this.publish(target, failed ? "final" : "provisional");
        return true;
      }
      if (this.choice.accepted && this.choice.votes > 0) {
        this.drop();
        this.publish(target, "final");
        return true;
      }
      this.publish(target, "held");
      this.phase = "turn-next";
      published = true;
    }
    if (slice === "commit") return published;
    if (this.phase === "turn-next") {
      if (performance.now() >= deadline) return published;
      this.beginTurnProbe(target.connected);
    }
    if (!this.advance(deadline)) return published;
    this.settleTurn();
    return true;
  }

  private beginTurnProbe(connected: Connected): void {
    this.pick.turns = EVERY_TURN;
    this.pick.firstTurn = NEXT_TURN;
    this.phase = "turn";
    const { model, volumes, boxes, technic } = connected;
    this.ticket = this.search.begin(
      model,
      volumes,
      boxes,
      technic,
      this.pick,
      RESTS_ON_TABLE_Y_PLATES,
      null,
      this.turnChoice,
    );
  }

  private settleTurn(): void {
    const connected = this.target?.connected;
    const turned = this.turnChoice;
    const turnBlocksSnap = turned.accepted && turned.votes > 0 && turned.rot !== this.pick.rot;
    this.snapRot = turned.rot;
    const held = this.shown;
    this.drop();
    if (!held || !connected) return;
    this.shown = {
      ...held,
      turnBlocksSnap,
      ...(turnBlocksSnap ? this.turnMates(connected) : NO_TURN_MATES),
      turnSettled: true,
    };
  }

  private advance(deadlineMs: number): boolean {
    if (this.ticket === SETTLED_AT_ONCE) return true;
    const step = this.search.advance(this.ticket, deadlineMs);
    switch (step) {
      case "running":
        return false;
      case "settled":
        this.ticket = SETTLED_AT_ONCE;
        return true;
      case "stale":
        this.ticket = SETTLED_AT_ONCE;
        this.drop();
        this.cell.forget();
        return false;
      default: {
        const unhandled: never = step;
        throw new Error(`unhandled search step ${String(unhandled)}`);
      }
    }
  }

  private drop(): void {
    if (this.ticket !== SETTLED_AT_ONCE) this.search.cancel();
    this.ticket = SETTLED_AT_ONCE;
    this.phase = "idle";
    this.target = null;
  }

  private turnMates(connected: Connected): TurnMates {
    const turned = this.turnChoice;
    this.search.evaluate(
      connected.model,
      { x: turned.x, z: turned.z, yPlates: turned.yPlates, rot: turned.rot },
      this.mates,
    );
    return { turnMates: this.host.mateCounts(this.mates), turnJoints: this.mates.jointCount };
  }

  private publish({ placeable, connected, mode }: AssistTarget, stage: HeldStage): void {
    const startedMs = performance.now();
    const choice = this.choice;
    const pose = { x: choice.x, z: choice.z, yPlates: choice.yPlates, rot: choice.rot };
    const magnet = magnetOffset(this.pick, pose);
    this.search.evaluate(connected.model, pose, this.mates);
    const mates = this.host.mateCounts(this.mates);
    const joints = this.mates.jointCount;
    const waitingOn = this.host.hoverWait(choice);
    const waiting = waitingOn !== null && !waitingOn.failed;
    const hit = choice.accepted || waitingOn ? null : this.host.refusalHit(choice.overlap);
    const blocked = choice.accepted ? this.host.heldPoseRefusal(placeable, pose) : null;
    this.shownYPlates = pose.yPlates;
    this.shown = {
      pose,
      accepted: choice.accepted && blocked === null,
      hit,
      mates,
      joints,
      lifted: pose.yPlates > RESTS_ON_TABLE_Y_PLATES,
      restsOn: this.host.restsOn(connected, pose),
      turnBlocksSnap: false,
      ...NO_TURN_MATES,
      mode,
      magnetised: magnet.distanceLdu > 0,
      magnet,
      assistNeighbourhood: this.host.neighbourhood(),
      settled: stage !== "provisional" && !waiting,
      turnSettled: stage === "final" && !waiting,
      waitingOn,
    };
    this.shownRefusal = this.refusalOf(placeable, blocked, waitingOn, hit);
    this.host.showGhost(pose);
    this.lastPublishMs = performance.now() - startedMs;
  }

  private refusalOf(
    placeable: Placeable,
    blocked: string | null,
    waitingOn: HoverWait | null,
    hit: HoverRefusalHit | null,
  ): string | null {
    if (this.choice.accepted) return blocked;
    if (!waitingOn) return refusalText(placeable.label, hit);
    return waitingOn.failed
      ? failedLoadText(placeable.label, waitingOn.placed.label, "here")
      : null;
  }
}
