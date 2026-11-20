import {
  layMoves,
  runMoves,
  type ClosureResult,
  type DrawingKit,
  type TrackMove,
} from "@brr/domain";
import {
  HALF_TURN_16,
  STUD_LDU,
  normalizeHeading16,
  pose16Equals,
  posesJoin16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";

export type TrackRefusal = Exclude<ClosureResult["kind"], "exact">;
export type ExtensionTurn = "straight" | "left" | "right";
export type ExtensionKind = ExtensionTurn | "join";

export type ExtensionChoice =
  | {
      readonly kind: ExtensionTurn;
      readonly moves: readonly [TrackMove];
      readonly joins: number | null;
      readonly blocked: boolean;
    }
  | {
      readonly kind: "join";
      readonly moves: ReadonlyArray<TrackMove>;
      readonly joins: number;
      readonly blocked: false;
    };

type PieceChoice = Extract<ExtensionChoice, { readonly kind: ExtensionTurn }>;

export interface ExtensionSite {
  readonly kit: DrawingKit;
  endPoses(): ReadonlyArray<Pose16>;
  layableEnd(end: number): boolean;
  closure(from: number, to: number): ClosureResult;
  crosses(from: number, move: TrackMove, joins: number | null): boolean;
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
  readonly blocked: boolean;
}

export interface UnjoinedEndView {
  readonly studs: number;
  readonly refusal: TrackRefusal;
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

function targetAhead(start: Pose16, end: Pose16, index: number): JoinTarget | null {
  const from = zeta16ToStuds(start.position);
  const to = zeta16ToStuds(end.position);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const facing = zeta16Direction(start.heading);
  if (dx * facing.x + dz * facing.z <= 0) return null;
  const distanceLdu = Math.hypot(dx, dz) * STUD_LDU;
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
  private focus: Focus | null = null;
  private preferred: ExtensionTurn = "straight";
  private readonly options = new Map<number, EndOptions>();
  private changes = 0;

  constructor(private readonly site: ExtensionSite) {}

  get version(): number {
    return this.changes;
  }

  endsChanged(): void {
    this.options.clear();
    this.focus = null;
    if (this.anchor && this.endIndex(this.anchor) === null) this.anchor = null;
    this.changes++;
  }

  continueFrom(end: Pose16 | null): void {
    this.anchor = end !== null && this.endIndex(end) !== null ? end : null;
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
    if (this.focus) this.changes++;
    this.focus = null;
    return anchored;
  }

  focusOn(hovered: number | null): void {
    const pointed = hovered !== null && this.site.layableEnd(hovered) ? hovered : null;
    const from = pointed ?? (this.anchor === null ? null : this.endIndex(this.anchor));
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
    const focus = this.focus;
    const choice = focus?.options.choices[focus.index];
    const start = focus ? this.site.endPoses()[focus.from] : undefined;
    if (!focus || !choice || !start) return null;
    return { from: focus.from, start, choice };
  }

  highlighted(): ReadonlyArray<number> {
    const run = this.chosen();
    if (!run) return [];
    return run.choice.joins === null ? [run.from] : [run.from, run.choice.joins];
  }

  view(): TrackExtendView | null {
    const focus = this.focus;
    if (!focus) return null;
    return {
      choices: focus.options.choices.map(choiceView),
      index: focus.index,
      continuing: this.anchor !== null && this.endIndex(this.anchor) === focus.from,
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
      if (choice.blocked || choice.joins === null) return;
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

  private joinedEnd(start: Pose16, move: TrackMove): number | null {
    const { end } = layMoves(start, [move]);
    const joined = this.site
      .endPoses()
      .findIndex((open, index) => this.site.layableEnd(index) && posesJoin16(end, open));
    return joined < 0 ? null : joined;
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
        const joins = this.joinedEnd(start, move);
        return {
          kind: turnSeenFromAbove(move),
          moves: [move],
          joins,
          blocked: this.site.crosses(from, move, joins),
        };
      })
      .toSorted((a, b) => TURN_ORDER.indexOf(a.kind) - TURN_ORDER.indexOf(b.kind));
    const nearest = ends
      .flatMap((end, index) =>
        this.site.layableEnd(index) ? (targetAhead(start, end, index) ?? []) : [],
      )
      .toSorted((a, b) => a.distanceLdu - b.distanceLdu)
      .slice(0, JOIN_TARGETS);
    const joins: ExtensionChoice[] = [];
    let unjoined: UnjoinedEndView | null = null;
    nearest.forEach(({ index, distanceLdu }, rank) => {
      const result = this.site.closure(from, index);
      if (result.kind !== "exact") {
        if (rank === 0) unjoined = { studs: distanceLdu / STUD_LDU, refusal: result.kind };
        return;
      }
      const moves = runMoves(kit, result.run);
      if (moves.length > 1) joins.push({ kind: "join", moves, joins: index, blocked: false });
    });
    const options: EndOptions = {
      choices: [...pieces, ...joins.toSorted((a, b) => a.moves.length - b.moves.length)],
      unjoined,
    };
    this.options.set(from, options);
    return options;
  }
}
