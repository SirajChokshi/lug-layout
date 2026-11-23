import { runMoves, type DrawingKit, type TrackMove, type TrackRun } from "@brr/domain";
import {
  HALF_TURN_16,
  STUD_LDU,
  normalizeHeading16,
  pose16Equals,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
  planeHypot,
} from "@brr/math";
import type { TrackBlockView, TrackRefusal } from "./track-drag.ts";

export type ExtensionTurn = "straight" | "left" | "right";
export type ExtensionKind = ExtensionTurn | "join";

export type ExtensionChoice =
  | {
      readonly kind: ExtensionTurn;
      readonly moves: readonly [TrackMove];
      readonly joins: number | null;
      readonly blocked: TrackBlockView | null;
    }
  | {
      readonly kind: "join";
      readonly moves: ReadonlyArray<TrackMove>;
      readonly joins: number;
      readonly blocked: null;
    };

export type ExtensionJoin =
  | { readonly kind: "exact"; readonly run: TrackRun }
  | {
      readonly kind: "refused";
      readonly refusal: TrackRefusal;
      readonly blocked: TrackBlockView | null;
    };

type PieceChoice = Extract<ExtensionChoice, { readonly kind: ExtensionTurn }>;

export interface ExtensionSite {
  readonly kit: DrawingKit;
  endPoses(): ReadonlyArray<Pose16>;
  joinedEnd(from: number, move: TrackMove): number | null;
  closure(from: number, to: number): ExtensionJoin;
  crosses(from: number, move: TrackMove, joins: number | null): TrackBlockView | null;
}

export interface ExtensionRun {
  readonly from: number;
  readonly start: Pose16;
  readonly choice: ExtensionChoice;
}

export interface TrackChoiceView {
  readonly kind: ExtensionKind;
  readonly straights: number;
  readonly curves: number;
  readonly joinsEnd: boolean;
  readonly blocked: TrackBlockView | null;
}

export interface UnjoinedEndView {
  readonly studs: number;
  readonly refusal: TrackRefusal;
  readonly blocked: TrackBlockView | null;
}

export interface TrackExtendView {
  readonly choices: ReadonlyArray<TrackChoiceView>;
  readonly index: number;
  readonly continuing: boolean;
  readonly unjoined: UnjoinedEndView | null;
}

interface EndOptions {
  readonly choices: ReadonlyArray<ExtensionChoice>;
  readonly unjoined: UnjoinedEndView | null;
}

interface Focus {
  readonly from: number;
  readonly options: EndOptions;
  index: number;
}

interface JoinTarget {
  readonly index: number;
  readonly distanceLdu: number;
}

const JOIN_SEARCH_RADIUS_LDU = 96 * STUD_LDU;
const JOIN_TARGETS = 4;
const SUGGESTED_JOIN_PIECES = 4;
const TURN_ORDER: ReadonlyArray<ExtensionTurn> = ["straight", "left", "right"];
const NO_ENDS: ReadonlyArray<number> = [];

function targetAhead(start: Pose16, end: Pose16, index: number): JoinTarget | null {
  const from = zeta16ToStuds(start.position);
  const to = zeta16ToStuds(end.position);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const facing = zeta16Direction(start.heading);
  if (dx * facing.x + dz * facing.z <= 0) return null;
  const distanceLdu = planeHypot(dx, dz) * STUD_LDU;
  return distanceLdu <= JOIN_SEARCH_RADIUS_LDU ? { index, distanceLdu } : null;
}

function turnSeenFromAbove(move: TrackMove): ExtensionTurn {
  const turn = normalizeHeading16(move.turn);
  if (turn === 0) return "straight";
  return turn < HALF_TURN_16 ? "right" : "left";
}

function choiceView(choice: ExtensionChoice): TrackChoiceView {
  const straights = choice.moves.filter((move) => move.turn === 0).length;
  return {
    kind: choice.kind,
    straights,
    curves: choice.moves.length - straights,
    joinsEnd: choice.joins !== null,
    blocked: choice.blocked,
  };
}

export class TrackExtension {
  private anchor: Pose16 | null = null;
  private anchorEnd: number | null = null;
  private focus: Focus | null = null;
  private preferred: ExtensionTurn = "straight";
  private readonly options = new Map<number, EndOptions>();
  private changes = 0;
  private chosenAt = -1;
  private chosenRun: ExtensionRun | null = null;
  private highlightedAt = -1;
  private highlightedEnds: ReadonlyArray<number> = NO_ENDS;
  private viewAt = -1;
  private extendView: TrackExtendView | null = null;

  constructor(private readonly site: ExtensionSite) {}

  get version(): number {
    return this.changes;
  }

  endsChanged(): void {
    this.options.clear();
    this.focus = null;
    this.anchorEnd = this.anchor === null ? null : this.endIndex(this.anchor);
    if (this.anchorEnd === null) this.anchor = null;
    this.changes++;
  }

  continueFrom(end: Pose16 | null): void {
    this.anchorEnd = end === null ? null : this.endIndex(end);
    this.anchor = this.anchorEnd === null ? null : end;
    this.focus = null;
    this.changes++;
  }

  laid(run: ExtensionRun, end: Pose16): void {
    if (run.choice.kind !== "join") this.preferred = run.choice.kind;
    this.continueFrom(end);
  }

  drop(): boolean {
    const anchored = this.anchor !== null;
    this.anchor = null;
    this.anchorEnd = null;
    if (this.focus) this.changes++;
    this.focus = null;
    return anchored;
  }

  focusOn(hovered: number | null): void {
    const from = hovered ?? this.anchorEnd;
    if (from === (this.focus?.from ?? null)) return;
    this.changes++;
    if (from === null) {
      this.focus = null;
      return;
    }
    const options = this.optionsFrom(from);
    this.focus = { from, options, index: this.suggested(options.choices) };
  }

  cycle(step: 1 | -1): boolean {
    const focus = this.focus;
    if (!focus) return false;
    const count = focus.options.choices.length;
    return this.select((((focus.index + step) % count) + count) % count);
  }

  choose(turn: ExtensionTurn): boolean {
    const index = this.focus?.options.choices.findIndex((choice) => choice.kind === turn) ?? -1;
    return this.select(index);
  }

  select(index: number): boolean {
    const focus = this.focus;
    if (!focus || index < 0 || index >= focus.options.choices.length) return false;
    if (focus.index !== index) this.changes++;
    focus.index = index;
    return true;
  }

  chosen(): ExtensionRun | null {
    if (this.chosenAt !== this.changes) {
      this.chosenRun = this.findChosen();
      this.chosenAt = this.changes;
    }
    return this.chosenRun;
  }

  highlighted(): ReadonlyArray<number> {
    if (this.highlightedAt !== this.changes) {
      this.highlightedEnds = this.findHighlighted();
      this.highlightedAt = this.changes;
    }
    return this.highlightedEnds;
  }

  view(): TrackExtendView | null {
    if (this.viewAt !== this.changes) {
      this.extendView = this.buildView();
      this.viewAt = this.changes;
    }
    return this.extendView;
  }

  private findChosen(): ExtensionRun | null {
    const focus = this.focus;
    const choice = focus?.options.choices[focus.index];
    const start = focus ? this.site.endPoses()[focus.from] : undefined;
    if (!focus || !choice || !start) return null;
    return { from: focus.from, start, choice };
  }

  private findHighlighted(): ReadonlyArray<number> {
    const run = this.chosen();
    if (!run) return NO_ENDS;
    return run.choice.joins === null ? [run.from] : [run.from, run.choice.joins];
  }

  private buildView(): TrackExtendView | null {
    const focus = this.focus;
    if (!focus) return null;
    return {
      choices: focus.options.choices.map(choiceView),
      index: focus.index,
      continuing: this.anchorEnd !== null && this.anchorEnd === focus.from,
      unjoined: focus.options.unjoined,
    };
  }

  private endIndex(pose: Pose16): number | null {
    const index = this.site.endPoses().findIndex((end) => pose16Equals(end, pose));
    return index < 0 ? null : index;
  }

  private suggested(choices: ReadonlyArray<ExtensionChoice>): number {
    let shortest = -1;
    choices.forEach((choice, index) => {
      if (choice.blocked !== null || choice.joins === null) return;
      if (choice.moves.length > SUGGESTED_JOIN_PIECES) return;
      const best = choices[shortest];
      if (!best || choice.moves.length < best.moves.length) shortest = index;
    });
    if (shortest >= 0) return shortest;
    return Math.max(
      0,
      choices.findIndex((choice) => choice.kind === this.preferred),
    );
  }

  private optionsFrom(from: number): EndOptions {
    const cached = this.options.get(from);
    if (cached) return cached;
    const { kit } = this.site;
    const ends = this.site.endPoses();
    const start = ends[from];
    if (!start) throw new RangeError(`there is no open end ${from}`);
    const pieces = [kit.straight, kit.left, kit.right]
      .map((move): PieceChoice => {
        const joins = this.site.joinedEnd(from, move);
        return {
          kind: turnSeenFromAbove(move),
          moves: [move],
          joins,
          blocked: this.site.crosses(from, move, joins),
        };
      })
      .toSorted((a, b) => TURN_ORDER.indexOf(a.kind) - TURN_ORDER.indexOf(b.kind));
    const nearest = ends
      .flatMap((end, index) => (index === from ? [] : (targetAhead(start, end, index) ?? [])))
      .toSorted((a, b) => a.distanceLdu - b.distanceLdu)
      .slice(0, JOIN_TARGETS);
    const joins: ExtensionChoice[] = [];
    let unjoined: UnjoinedEndView | null = null;
    nearest.forEach(({ index, distanceLdu }, rank) => {
      const result = this.site.closure(from, index);
      if (result.kind === "refused") {
        if (rank === 0) {
          unjoined = {
            studs: distanceLdu / STUD_LDU,
            refusal: result.refusal,
            blocked: result.blocked,
          };
        }
        return;
      }
      const moves = runMoves(kit, result.run);
      if (moves.length > 1) joins.push({ kind: "join", moves, joins: index, blocked: null });
    });
    const options: EndOptions = {
      choices: [...pieces, ...joins.toSorted((a, b) => a.moves.length - b.moves.length)],
      unjoined,
    };
    this.options.set(from, options);
    return options;
  }
}
