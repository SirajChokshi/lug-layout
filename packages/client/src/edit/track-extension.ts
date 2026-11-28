import {
  continuingMove,
  runMoves,
  type DrawingKit,
  type TrackMove,
  type TrackPieceDef,
  type TrackRun,
} from "@brr/domain";
import { HALF_TURN_16, STUD_LDU, normalizeHeading16, pose16Equals, type Pose16 } from "@brr/math";
import { joinTargets } from "./join-targets.ts";
import type { TrackBlockView, TrackRefusal } from "./track-drag.ts";

export type ExtensionTurn = "straight" | "left" | "right";
export type ExtensionKind = ExtensionTurn | "piece" | "join";
type PreferredKind = ExtensionTurn | "piece";

export interface PieceFit {
  readonly joins: number | null;
  readonly blocked: TrackBlockView | null;
}

export type ExtensionChoice =
  | ({ readonly kind: PreferredKind; readonly moves: readonly [TrackMove] } & PieceFit)
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

type SingleChoice = Extract<ExtensionChoice, { readonly kind: PreferredKind }>;
type TurnChoice = SingleChoice & { readonly kind: ExtensionTurn };

export interface ExtensionSite {
  readonly kit: DrawingKit;
  endPoses(): ReadonlyArray<Pose16>;
  joinedEnd(from: number, move: TrackMove): number | null;
  closure(from: number, to: number): ExtensionJoin;
  crosses(from: number, move: TrackMove, joins: number | null): TrackBlockView | null;
  pieceFit(from: number, move: TrackMove): PieceFit;
  pieceLabel(piece: TrackPieceDef): string;
}

export interface ExtensionRun {
  readonly from: number;
  readonly start: Pose16;
  readonly choice: ExtensionChoice;
}

interface ChoiceCounts {
  readonly straights: number;
  readonly curves: number;
  readonly joinsEnd: boolean;
  readonly blocked: TrackBlockView | null;
}

export interface TrackChoicePiece {
  readonly label: string;
  readonly end: number;
  readonly ends: number;
}

export type TrackChoiceView =
  | (ChoiceCounts & { readonly kind: ExtensionTurn | "join" })
  | (ChoiceCounts & { readonly kind: "piece"; readonly piece: TrackChoicePiece });

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

const SUGGESTED_JOIN_PIECES = 4;
const TURN_ORDER: ReadonlyArray<ExtensionTurn> = ["straight", "left", "right"];
const NO_ENDS: ReadonlyArray<number> = [];
const LIBRARY_ENTRY = 0;

function turnSeenFromAbove(move: TrackMove): ExtensionTurn {
  const turn = normalizeHeading16(move.turn);
  if (turn === 0) return "straight";
  return turn < HALF_TURN_16 ? "right" : "left";
}

function choiceCounts(choice: ExtensionChoice): ChoiceCounts {
  const straights = choice.moves.filter((move) => move.turn === 0).length;
  return {
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
  private preferred: PreferredKind = "straight";
  private piece: TrackMove | null = null;
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
    this.focusWith(from);
  }

  append(piece: TrackPieceDef): boolean {
    const from = this.anchorEnd;
    const move =
      this.piece?.piece.id === piece.id ? this.piece : continuingMove(piece, LIBRARY_ENTRY);
    if (from === null || move === null) return false;
    this.remember(move, from);
    return true;
  }

  nextEntry(): boolean {
    const focus = this.focus;
    const choice = focus?.options.choices[focus.index];
    if (!focus || choice?.kind !== "piece") return false;
    const [current] = choice.moves;
    const ends = current.piece.connectors.length;
    for (let step = 1; step < ends; step++) {
      const move = continuingMove(current.piece, (current.from + step) % ends);
      if (move === null) continue;
      this.remember(move, focus.from);
      return true;
    }
    return false;
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

  private remember(move: TrackMove, from: number): void {
    this.piece = move;
    this.preferred = "piece";
    this.options.clear();
    this.focusWith(from);
    this.changes++;
  }

  private focusWith(from: number): void {
    const options = this.optionsFrom(from);
    this.focus = { from, options, index: this.suggested(options.choices) };
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
      choices: focus.options.choices.map((choice) => this.choiceView(choice)),
      index: focus.index,
      continuing: this.anchorEnd !== null && this.anchorEnd === focus.from,
      unjoined: focus.options.unjoined,
    };
  }

  private choiceView(choice: ExtensionChoice): TrackChoiceView {
    const counts = choiceCounts(choice);
    if (choice.kind !== "piece") return { kind: choice.kind, ...counts };
    const [move] = choice.moves;
    const piece: TrackChoicePiece = {
      label: this.site.pieceLabel(move.piece),
      end: move.from,
      ends: move.piece.connectors.length,
    };
    return { kind: "piece", ...counts, piece };
  }

  private endIndex(pose: Pose16): number | null {
    const index = this.site.endPoses().findIndex((end) => pose16Equals(end, pose));
    return index < 0 ? null : index;
  }

  private suggested(choices: ReadonlyArray<ExtensionChoice>): number {
    const piece = choices.findIndex((choice) => choice.kind === "piece");
    if (this.preferred === "piece" && piece >= 0) return piece;
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
    const turns = [kit.straight, kit.left, kit.right]
      .map((move): TurnChoice => {
        const joins = this.site.joinedEnd(from, move);
        return {
          kind: turnSeenFromAbove(move),
          moves: [move],
          joins,
          blocked: this.site.crosses(from, move, joins),
        };
      })
      .toSorted((a, b) => TURN_ORDER.indexOf(a.kind) - TURN_ORDER.indexOf(b.kind));
    const remembered = this.piece;
    const library: ReadonlyArray<SingleChoice> =
      remembered === null
        ? []
        : [{ kind: "piece", moves: [remembered], ...this.site.pieceFit(from, remembered) }];
    const nearest = joinTargets(this.site.endPoses(), from);
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
      choices: [...turns, ...library, ...joins.toSorted((a, b) => a.moves.length - b.moves.length)],
      unjoined,
    };
    this.options.set(from, options);
    return options;
  }
}
