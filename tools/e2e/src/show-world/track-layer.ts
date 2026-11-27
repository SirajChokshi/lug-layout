import type { ExtensionTurn, TrackEndView } from "@brr/client";
import type { AimedEditor, Point } from "./aimed-editor.ts";
import type { OvalPlan, TrackKit } from "./show-layout.ts";

const HEADINGS = 16;
const HALF_TURN = HEADINGS / 2;
const PROBE_RUN_LDU = 1_280;
const MAX_CURVES_PER_HALF_TURN = HEADINGS;
const LATTICE_RESIDUAL_LDU = 1e-6;
const MAX_SIDING_STRAIGHTS = 6;
const HELD_CONNECTOR_TRIES = 4;

export interface OvalReport {
  readonly row: number;
  readonly pieces: number;
  readonly switches: number;
  readonly sidings: number;
}

interface SwitchFit {
  readonly item: string;
  readonly connectors: number;
}

interface PlacedSwitch {
  readonly through: TrackEndView;
  readonly branch: TrackEndView;
}

function sameEnd(a: TrackEndView, b: TrackEndView): boolean {
  return a.xLdu === b.xLdu && a.zLdu === b.zLdu && a.heading === b.heading;
}

function exactLdu(value: number, what: string): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > LATTICE_RESIDUAL_LDU) {
    throw new Error(`${what} is ${value} LDU, off the whole-LDU lattice`);
  }
  return rounded + 0;
}

function at(end: TrackEndView): Point {
  return { x: end.xLdu, z: end.zLdu };
}

export class TrackLayer {
  private switchFits: SwitchFit[] = [];

  constructor(
    private readonly hand: AimedEditor,
    private readonly trackItem: string,
    private readonly turn: ExtensionTurn,
  ) {}

  static async probe(hand: AimedEditor, trackItem: string, from: Point): Promise<TrackKit> {
    const { editor } = hand;
    await hand.hold(trackItem);
    const depth = editor.snapshot().history.undoDepth;
    hand.drag(from, { x: from.x + PROBE_RUN_LDU, z: from.z });
    const laid = editor.dump().trackEnds;
    const west = laid.find((end) => end.heading === HALF_TURN);
    const east = laid.find((end) => end.heading === 0);
    const pieces = editor.snapshot().track?.pieces ?? 0;
    if (!west || !east || pieces === 0) {
      throw new Error(`a probe drag east laid no straight run: ${JSON.stringify(laid)}`);
    }
    hand.leave();
    let end = east;
    let reach = 0;
    let curves = 0;
    while (end.heading !== HALF_TURN) {
      if (++curves > MAX_CURVES_PER_HALF_TURN) {
        throw new Error("the probe's curves never turned the track around");
      }
      editor.extendTrack("left", performance.now());
      const next = editor.dump().trackEnds.find((open) => !sameEnd(open, west));
      if (!next || sameEnd(next, end)) throw new Error("a probe curve laid nothing");
      end = next;
      reach = Math.max(reach, end.xLdu - east.xLdu);
    }
    const kit: TrackKit = {
      straightLdu: exactLdu((east.xLdu - west.xLdu) / pieces, "a straight's length"),
      curvesPerHalfTurn: curves,
      halfTurnOffsetLdu: exactLdu(end.zLdu - east.zLdu, "a half turn's offset"),
      halfTurnReachLdu: Math.ceil(reach),
    };
    while (editor.snapshot().history.undoDepth > depth) editor.undo(performance.now());
    if ((editor.snapshot().track?.pieces ?? 0) !== 0)
      throw new Error("the probe left track behind");
    return kit;
  }

  async lay(plan: OvalPlan, kit: TrackKit): Promise<OvalReport> {
    const { editor } = this.hand;
    await this.hand.hold(this.trackItem);
    const before = this.counts();
    const openBefore = this.ends();
    const first = plan.sidingStarts[0] ?? plan.eastX;
    this.hand.drag(
      { x: plan.westX, z: plan.laneZ },
      { x: Math.max(first, plan.westX + kit.straightLdu), z: plan.laneZ },
    );
    const west = this.newEnds(openBefore).find((end) => end.heading === HALF_TURN);
    let end = this.newEnds(openBefore).find((open) => open.heading === 0);
    if (!west || !end) throw new Error(`oval ${plan.row + 1}'s first run laid no straight track`);
    this.hand.leave();
    let sidings = 0;
    for (const start of plan.sidingStarts) {
      end = this.straightsTo(end, start, kit);
      end = await this.siding(end, plan);
      sidings++;
    }
    end = this.straightsTo(end, plan.eastX, kit);
    for (let curve = 0; curve < kit.curvesPerHalfTurn; curve++) end = this.extend(end, this.turn);
    end = this.straightsBackTo(end, west.xLdu, kit);
    for (let curve = 0; curve < kit.curvesPerHalfTurn / 2; curve++)
      end = this.extend(end, this.turn);
    this.joinFrom(end, `oval ${plan.row + 1} to close`);
    const after = this.counts();
    if (this.ends().length !== openBefore.length) {
      throw new Error(`oval ${plan.row + 1} was left with open ends`);
    }
    editor.chooseItem(null);
    return {
      row: plan.row,
      pieces: after.pieces - before.pieces,
      switches: after.switches - before.switches,
      sidings,
    };
  }

  private counts(): { readonly pieces: number; readonly switches: number } {
    const track = this.hand.snapshot().track;
    return { pieces: track?.pieces ?? 0, switches: track?.switches.length ?? 0 };
  }

  private ends(): ReadonlyArray<TrackEndView> {
    return this.hand.editor.dump().trackEnds;
  }

  private newEnds(before: ReadonlyArray<TrackEndView>): ReadonlyArray<TrackEndView> {
    return this.ends().filter((end) => !before.some((old) => sameEnd(old, end)));
  }

  private extend(from: TrackEndView, turn: ExtensionTurn): TrackEndView {
    const before = this.ends();
    this.hand.hover(at(from));
    this.hand.editor.extendTrack(turn, performance.now());
    this.hand.leave();
    const added = this.newEnds(before);
    const [next] = added;
    const stillOpen = this.ends().some((end) => sameEnd(end, from));
    if (!next || added.length > 1 || stillOpen) {
      const block = this.hand.snapshot().track?.lastBlock ?? null;
      throw new Error(
        `extending ${turn} from (${from.xLdu}, ${from.zLdu}) didn't lay one piece${block ? `: ${JSON.stringify(block)}` : ""}`,
      );
    }
    return next;
  }

  private straightsTo(from: TrackEndView, x: number, kit: TrackKit): TrackEndView {
    let end = from;
    while (end.xLdu + kit.straightLdu <= x) end = this.extend(end, "straight");
    return end;
  }

  private straightsBackTo(from: TrackEndView, x: number, kit: TrackKit): TrackEndView {
    let end = from;
    while (end.xLdu - kit.straightLdu >= x) end = this.extend(end, "straight");
    return end;
  }

  private joinFrom(from: TrackEndView, what: string): void {
    if (!this.tryJoin(from)) {
      const choices = this.hand.snapshot().track?.extend?.choices ?? [];
      throw new Error(`no exact join closes ${what}: ${JSON.stringify(choices)}`);
    }
  }

  private tryJoin(from: TrackEndView): boolean {
    const { editor } = this.hand;
    const before = this.ends().length;
    this.hand.hover(at(from));
    const extend = editor.snapshot().track?.extend ?? null;
    const suggested = extend?.choices[extend.index] ?? null;
    if (suggested?.kind !== "join" || suggested.blocked !== null) {
      this.hand.leave();
      return false;
    }
    editor.extendTrack(null, performance.now());
    this.hand.leave();
    return this.ends().length === before - 2;
  }

  private async siding(from: TrackEndView, plan: OvalPlan): Promise<TrackEndView> {
    const inward = Math.sign(plan.returnZ - plan.laneZ);
    const along = (end: TrackEndView): number => Math.cos(end.headingRadians - from.headingRadians);
    const facing = await this.placeSwitch(
      from,
      (through, branch) =>
        through.heading === from.heading &&
        through.zLdu === from.zLdu &&
        through.xLdu > from.xLdu &&
        Math.sign(branch.zLdu - from.zLdu) === inward &&
        along(branch) > 0,
    );
    let main = facing.through;
    const { editor } = this.hand;
    for (let straights = 1; straights <= MAX_SIDING_STRAIGHTS; straights++) {
      await this.hand.hold(this.trackItem);
      const depth = editor.snapshot().history.undoDepth;
      main = this.extend(main, "straight");
      const trailing = await this.placeSwitch(
        main,
        (through, branch) =>
          through.heading === from.heading &&
          through.zLdu === from.zLdu &&
          through.xLdu > main.xLdu &&
          Math.sign(branch.zLdu - from.zLdu) === inward &&
          along(branch) < 0 &&
          branch.xLdu > facing.branch.xLdu,
      );
      await this.hand.hold(this.trackItem);
      if (this.tryJoin(facing.branch)) return trailing.through;
      while (editor.snapshot().history.undoDepth > depth + 1) editor.undo(performance.now());
    }
    throw new Error(
      `no passing siding of up to ${MAX_SIDING_STRAIGHTS} straights closes exactly at (${from.xLdu}, ${from.zLdu})`,
    );
  }

  private async placeSwitch(
    onto: TrackEndView,
    fits: (through: TrackEndView, branch: TrackEndView) => boolean,
  ): Promise<PlacedSwitch> {
    const { editor } = this.hand;
    const known = this.switchFits;
    const tries = [
      ...known,
      ...this.candidateFits().filter(
        (fit) =>
          !known.some((seen) => seen.item === fit.item && seen.connectors === fit.connectors),
      ),
    ];
    for (const fit of tries) {
      const before = this.ends();
      const switches = this.counts().switches;
      await this.hand.hold(fit.item);
      for (let press = 0; press < fit.connectors; press++) editor.cycleConnector();
      const depth = editor.snapshot().history.undoDepth;
      this.hand.click(at(onto));
      const laid = editor.snapshot().history.undoDepth > depth;
      const added = this.newEnds(before);
      const [a, b] = added;
      const consumed = !this.ends().some((end) => sameEnd(end, onto));
      if (
        laid &&
        consumed &&
        added.length === 2 &&
        a &&
        b &&
        this.counts().switches === switches + 1
      ) {
        const placed = fits(a, b)
          ? { through: a, branch: b }
          : fits(b, a)
            ? { through: b, branch: a }
            : null;
        if (placed) {
          if (!known.includes(fit)) this.switchFits = [...known, fit];
          return placed;
        }
      }
      if (laid) editor.undo(performance.now());
    }
    throw new Error(
      `no switch in the track kit fits at (${onto.xLdu}, ${onto.zLdu}) heading ${onto.heading} with its branch on the inner side`,
    );
  }

  private candidateFits(): SwitchFit[] {
    const pieces = this.hand
      .snapshot()
      .catalog.filter((item) => item.kind === "track" && item.id !== this.trackItem);
    return pieces.flatMap((item) =>
      Array.from({ length: HELD_CONNECTOR_TRIES }, (_, connectors) => ({
        item: item.id,
        connectors,
      })),
    );
  }
}
