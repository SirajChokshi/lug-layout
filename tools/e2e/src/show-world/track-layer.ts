import type { ExtensionTurn, TrackEndView } from "@brr/client";
import { UNROUNDED_TOLERANCE_LDU, ZETA16_ORDER } from "@brr/math";
import type { EditorPath } from "../held-out/editor-pairs.ts";
import type { OvalPlan, Point, TrackKit } from "./show-layout.ts";

const HALF_TURN = ZETA16_ORDER / 2;
const PROBE_RUN_LDU = 1_280;
const MAX_SIDING_STRAIGHTS = 6;
const HELD_CONNECTOR_TRIES = 4;

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
  if (Math.abs(value - rounded) > UNROUNDED_TOLERANCE_LDU) {
    throw new Error(`${what} is ${value} LDU, off the whole-LDU lattice`);
  }
  return rounded + 0;
}

export class TrackLayer {
  private switchFits: SwitchFit[] = [];

  constructor(
    private readonly path: EditorPath,
    private readonly trackItem: string,
  ) {}

  async probe(from: Point): Promise<TrackKit> {
    const { editor } = this.path;
    await this.path.hold(this.trackItem);
    const depth = editor.snapshot().history.undoDepth;
    this.path.drag(from.x, from.z, from.x + PROBE_RUN_LDU, from.z);
    const run = this.ends();
    const west = run.find((end) => end.heading === HALF_TURN);
    const east = run.find((end) => end.heading === 0);
    const pieces = editor.snapshot().track?.pieces ?? 0;
    if (!west || !east || pieces === 0) {
      throw new Error(`a probe drag east laid no straight run: ${JSON.stringify(run)}`);
    }
    let end = east;
    let reach = 0;
    let curves = 0;
    while (end.heading !== HALF_TURN) {
      if (++curves > ZETA16_ORDER)
        throw new Error("the probe's curves never turned the track around");
      end = await this.extend(end, "left");
      reach = Math.max(reach, end.xLdu - east.xLdu);
    }
    const kit: TrackKit = {
      straightLdu: exactLdu((east.xLdu - west.xLdu) / pieces, "a straight's length"),
      curvesPerHalfTurn: curves,
      halfTurnOffsetLdu: exactLdu(end.zLdu - east.zLdu, "a half turn's offset"),
      halfTurnReachLdu: Math.ceil(reach),
    };
    while (editor.snapshot().history.undoDepth > depth) editor.undo(performance.now());
    if ((editor.snapshot().track?.pieces ?? 0) !== 0) {
      throw new Error("the probe left track behind");
    }
    return kit;
  }

  async lay(plan: OvalPlan, kit: TrackKit): Promise<void> {
    await this.path.hold(this.trackItem);
    const openBefore = this.ends();
    const first = Math.max(plan.sidingStarts[0] ?? plan.eastX, plan.westX + kit.straightLdu);
    this.path.drag(plan.westX, plan.laneZ, first, plan.laneZ);
    const laid = this.newEnds(openBefore);
    const west = laid.find((end) => end.heading === HALF_TURN);
    let end = laid.find((open) => open.heading === 0);
    if (!west || !end) throw new Error(`oval ${plan.row + 1}'s first run laid no straight track`);
    for (const start of plan.sidingStarts) {
      end = await this.straights(end, (x) => x + kit.straightLdu <= start);
      end = await this.siding(end, plan);
    }
    end = await this.straights(end, (x) => x + kit.straightLdu <= plan.eastX);
    for (let curve = 0; curve < kit.curvesPerHalfTurn; curve++)
      end = await this.extend(end, "left");
    end = await this.straights(end, (x) => x - kit.straightLdu >= west.xLdu);
    for (let curve = 0; curve < kit.curvesPerHalfTurn / 2; curve++) {
      end = await this.extend(end, "left");
    }
    if (!(await this.joinSuggested(end)) || this.ends().length !== openBefore.length) {
      throw new Error(`oval ${plan.row + 1} didn't close through the join the editor suggests`);
    }
    this.path.editor.chooseItem(null);
  }

  private ends(): ReadonlyArray<TrackEndView> {
    return this.path.editor.dump().trackEnds;
  }

  private newEnds(before: ReadonlyArray<TrackEndView>): ReadonlyArray<TrackEndView> {
    return this.ends().filter((end) => !before.some((old) => sameEnd(old, end)));
  }

  private switches(): number {
    return this.path.editor.snapshot().track?.switches.length ?? 0;
  }

  private async extend(from: TrackEndView, turn: ExtensionTurn): Promise<TrackEndView> {
    const before = this.ends();
    await this.path.hoverAt(from.xLdu, from.zLdu);
    this.path.editor.extendTrack(turn, performance.now());
    this.path.editor.pointerLeave();
    const [next, ...more] = this.newEnds(before);
    if (!next || more.length > 0 || this.ends().some((end) => sameEnd(end, from))) {
      const block = this.path.editor.snapshot().track?.lastBlock ?? null;
      throw new Error(
        `extending ${turn} from (${from.xLdu}, ${from.zLdu}) didn't lay one piece: ${JSON.stringify(block)}`,
      );
    }
    return next;
  }

  private async straights(from: TrackEndView, more: (x: number) => boolean): Promise<TrackEndView> {
    let end = from;
    while (more(end.xLdu)) end = await this.extend(end, "straight");
    return end;
  }

  private async joinSuggested(from: TrackEndView): Promise<boolean> {
    const { editor } = this.path;
    const before = this.ends().length;
    await this.path.hoverAt(from.xLdu, from.zLdu);
    const extend = editor.snapshot().track?.extend ?? null;
    const suggested = extend?.choices[extend.index] ?? null;
    if (suggested?.kind === "join" && suggested.blocked === null) {
      editor.extendTrack(null, performance.now());
    }
    editor.pointerLeave();
    return this.ends().length === before - 2;
  }

  private async siding(from: TrackEndView, plan: OvalPlan): Promise<TrackEndView> {
    const inward = Math.sign(plan.returnZ - plan.laneZ);
    const along = (end: TrackEndView): number => Math.cos(end.headingRadians - from.headingRadians);
    const onLane = (through: TrackEndView, past: TrackEndView): boolean =>
      through.heading === from.heading && through.zLdu === from.zLdu && through.xLdu > past.xLdu;
    const facing = await this.placeSwitch(
      from,
      (through, branch) =>
        onLane(through, from) && Math.sign(branch.zLdu - from.zLdu) === inward && along(branch) > 0,
    );
    let main = facing.through;
    const { editor } = this.path;
    for (let straights = 1; straights <= MAX_SIDING_STRAIGHTS; straights++) {
      await this.path.hold(this.trackItem);
      const depth = editor.snapshot().history.undoDepth;
      main = await this.extend(main, "straight");
      const trailing = await this.placeSwitch(
        main,
        (through, branch) =>
          onLane(through, main) &&
          Math.sign(branch.zLdu - from.zLdu) === inward &&
          along(branch) < 0 &&
          branch.xLdu > facing.branch.xLdu,
      );
      await this.path.hold(this.trackItem);
      if (await this.joinSuggested(facing.branch)) return trailing.through;
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
    const { editor } = this.path;
    const known = this.switchFits;
    const candidates = editor
      .snapshot()
      .catalog.filter((item) => item.kind === "track" && item.id !== this.trackItem)
      .flatMap((item) =>
        Array.from({ length: HELD_CONNECTOR_TRIES }, (_, connectors) => ({
          item: item.id,
          connectors,
        })),
      )
      .filter(
        (fit) =>
          !known.some((seen) => seen.item === fit.item && seen.connectors === fit.connectors),
      );
    for (const fit of [...known, ...candidates]) {
      const before = this.ends();
      const switches = this.switches();
      await this.path.hold(fit.item);
      for (let press = 0; press < fit.connectors; press++) editor.cycleConnector();
      const depth = editor.snapshot().history.undoDepth;
      await this.path.step(onto.xLdu, onto.zLdu, true);
      const laid = editor.snapshot().history.undoDepth > depth;
      const [a, b, ...more] = this.newEnds(before);
      const switched =
        laid &&
        more.length === 0 &&
        this.switches() === switches + 1 &&
        !this.ends().some((end) => sameEnd(end, onto));
      const placed =
        !switched || !a || !b
          ? null
          : fits(a, b)
            ? { through: a, branch: b }
            : fits(b, a)
              ? { through: b, branch: a }
              : null;
      if (placed) {
        if (!known.includes(fit)) this.switchFits = [...known, fit];
        return placed;
      }
      if (laid) editor.undo(performance.now());
    }
    throw new Error(
      `no switch in the track kit fits at (${onto.xLdu}, ${onto.zLdu}) heading ${onto.heading} with its branch on the inner side`,
    );
  }
}
