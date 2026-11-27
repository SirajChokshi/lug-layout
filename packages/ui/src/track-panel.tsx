import {
  TOO_STEEP,
  heightText,
  libraryPieceEndText,
  lowClearanceText,
  studsText,
  trackBlockText,
  unjoinedText,
  type CrossingView,
  type EditorSnapshot,
  type IEditor,
  type LoopClosureView,
  type TrackBlockView,
  type TrackChoiceView,
  type TrackDragView,
  type TrackEndView,
  type TrackExtendView,
  type TrackGapView,
  type TrackHeightView,
  type TrackLoopsView,
  type TrackPieceView,
  type TrackView,
} from "@brr/client";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const LISTED_GAPS = 8;
const LISTED_LOOPS = 6;

const studs = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const tenths = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function offsetText(gap: TrackGapView): string {
  if (gap.gapStuds === 0) return "on the same spot";
  const ahead = `${studs.format(Math.abs(gap.aheadStuds))} ${gap.aheadStuds >= 0 ? "ahead" : "behind"}`;
  return `${studs.format(gap.gapStuds)} studs apart (${ahead}, ${studs.format(Math.abs(gap.asideStuds))} aside)`;
}

function angleText(gap: TrackGapView): string {
  if (gap.headingErrorSteps === 0) {
    return gap.aheadStuds > 0 ? "facing each other" : "in line but overlapping";
  }
  const steps = Math.abs(gap.headingErrorSteps);
  return `${Math.abs(gap.headingErrorDegrees)}° out of line (${steps} curve ${steps === 1 ? "step" : "steps"})`;
}

function gapText(gap: TrackGapView): string {
  const where = `at stud ${studs.format(gap.xStuds)}, ${studs.format(gap.zStuds)}`;
  return `Two open ends ${offsetText(gap)}, ${angleText(gap)}, ${where}. They don't join exactly.`;
}

function releaseOf(drag: TrackDragView): string {
  return drag.pieces === 0
    ? "release lays nothing"
    : "release lays the run and leaves that end open";
}

function joinBlockText(block: TrackBlockView | null): string {
  return block
    ? `every exact join found would ${trackBlockText(block)}`
    : "every exact join found would cross placed track, a plate, a model or itself";
}

function closureText(drag: TrackDragView): string {
  switch (drag.closure) {
    case "exact":
      return "joins the open end exactly";
    case "impossible":
      return "no exact join exists with any run of 9V straights and R40 curves: release lays nothing";
    case "blocked":
      if (drag.withheld) return `${joinBlockText(drag.blocked)}: ${releaseOf(drag)}`;
      return drag.blocked
        ? `every exact join found would ${trackBlockText(drag.blocked)}: release lays nothing`
        : "every exact join found would cross placed track, a plate, a model or itself: release lays nothing";
    case "limit":
      return "the search hit its time limit before finding an exact join: release lays nothing";
    case "too-steep":
      return `${TOO_STEEP}: release lays nothing`;
    case "pending":
      return `a model under this join is still checking its studs: ${releaseOf(drag)}`;
    case null:
      if (drag.blocked) return `stops short: the next piece would ${trackBlockText(drag.blocked)}`;
      return drag.pieces === 0
        ? "drag away from the start"
        : `ends ${drag.missStuds.toFixed(1)} studs from the cursor`;
    default: {
      const unhandled: never = drag.closure;
      throw new Error(`unhandled closure ${String(unhandled)}`);
    }
  }
}

function heldRows(held: TrackPieceView): ReadonlyArray<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [
    ["Holding", held.label],
    [
      "Attach",
      held.snapped
        ? `end ${held.connector + 1} of ${held.connectors} on an open end, exactly${held.joins > 1 ? ` (${held.joins} ends join)` : ""}`
        : "free on the stud grid (R turns it): move onto an open end to attach",
    ],
  ];
  if (held.misses > 0) {
    rows.push([
      "Near miss",
      `${held.misses === 1 ? "an end" : `${held.misses} ends`} would sit close to another open end without joining (red)`,
    ]);
  }
  if (held.mirror !== null) rows.push(["X swaps to", held.mirror]);
  return rows;
}

function switchText(track: TrackView): string {
  const branching = track.switches.filter((s) => s.lever === "branching").length;
  return `${integer.format(track.switches.length)} (${integer.format(branching)} set to branch)`;
}

function dragRows(drag: TrackDragView): ReadonlyArray<readonly [string, string]> {
  return [
    ["Drawing from", drag.fromOpenEnd ? "an open end" : "a new start on the stud grid"],
    ["Ghost run", `${drag.pieces} pieces (${drag.straights} straight, ${drag.curves} curve)`],
    ["Join", closureText(drag)],
    ["Solve", `${drag.solveMs.toFixed(2)} ms`],
  ];
}

function withheldText(track: TrackView): string | null {
  const outcome = track.lastCommit === null ? "nothing laid" : "laid, end left open";
  switch (track.lastWithheld) {
    case "unsupported":
      return `${outcome}: ${joinBlockText(track.lastBlock)}`;
    case "pending":
      return `${outcome}: a model under the join was still checking its studs`;
    case null:
      return null;
    default: {
      const unhandled: never = track.lastWithheld;
      throw new Error(`unhandled withheld join ${String(unhandled)}`);
    }
  }
}

function laidText(track: TrackView): string {
  const withheld = withheldText(track);
  if (withheld) return withheld;
  if (track.lastCommit === "joined") return "laid and joined exactly";
  return track.lastBlock
    ? `laid, stopped short: the next piece would ${trackBlockText(track.lastBlock)}`
    : "laid with an open end";
}

function unsupportedText(track: TrackView): string {
  if (track.unsupported === null) return "not checked yet";
  if (track.unsupported === 0) return "none";
  const { lastUnsupported } = track;
  const where =
    lastUnsupported?.block?.kind === "model"
      ? ` (last laid: on ${lastUnsupported.block.label})`
      : "";
  const tilted = lastUnsupported?.tilted ?? 0;
  const ramp =
    tilted > 0
      ? `; ${integer.format(tilted)} of the last laid on a ramp with an end resting on nothing`
      : "";
  return `${integer.format(track.unsupported)} with no anti-stud exactly on a stud${where}${ramp}`;
}

function lowBridgesText(track: TrackView): string {
  if (track.lowClearance === null) return "not checked until a train is measured";
  if (track.lowClearance === 0) return "none";
  const last = track.lastLowClearance;
  const lastLaid = last ? ` (last laid: ${lowClearanceText(last)})` : "";
  return `${integer.format(track.lowClearance)} too low for the tallest train${lastLaid}`;
}

function crossingText(crossing: CrossingView, index: number): string {
  const where = `Level crossing ${index + 1}: ${integer.format(crossing.tracks)} ${crossing.tracks === 1 ? "piece" : "pieces"} over ${integer.format(crossing.roadwayCells)} roadway studs`;
  if (crossing.ramps.length === 0) {
    return `${where}. No ramp part seats flush here: a ramp must reach the rail top, sit against the track and grip at least one road stud.`;
  }
  const ramps = crossing.ramps
    .map((ramp) => `${ramp.count} × ${ramp.part} ${ramp.title}`)
    .join(", ");
  return `${where}. Suggested ramps: ${ramps}.`;
}

function commitText(track: TrackView): string {
  switch (track.lastCommit) {
    case "joined":
    case "laid":
      return laidText(track);
    case "refused-impossible":
      return "refused: no exact join exists";
    case "refused-blocked":
      return track.lastBlock
        ? `refused: every exact join would ${trackBlockText(track.lastBlock)}`
        : "refused: every exact join would cross track, a plate, a model or itself";
    case "refused-limit":
      return "refused: search hit its time limit";
    case "refused-too-steep":
      return `refused: ${TOO_STEEP}`;
    case "refused-changed":
      return "refused: the layout changed while the run's piers were being built";
    case "switch-straight":
      return "switch thrown to the straight route";
    case "switch-branching":
      return "switch thrown to the branching route";
    case null:
      return withheldText(track) ?? "none yet";
    default: {
      const unhandled: never = track.lastCommit;
      throw new Error(`unhandled commit ${String(unhandled)}`);
    }
  }
}

export function TrackPanel({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const { track } = snapshot;
  if (!track || (snapshot.mode !== "track" && track.pieces === 0)) return null;
  const rows: Array<readonly [string, string]> = [
    ["Pieces laid", integer.format(track.pieces)],
    ["Model pieces on the ζ₁₆ field", integer.format(track.modelPieces)],
    ["Model pieces in a run frame, joined only inside it", integer.format(track.runFramePieces)],
    [
      "Model pieces off the field or unanchored, not joined",
      integer.format(track.offField + track.unanchored),
    ],
    ...track.bom.map((line): readonly [string, string] => [
      `${line.piece} ${line.title}`,
      `× ${line.count}`,
    ]),
    ["Exact joins", integer.format(track.joins)],
    ["Open ends", integer.format(track.openEnds)],
    ["Coincident ends not joined", integer.format(track.coincidentEndIssues)],
    ["Near-miss gaps", integer.format(track.gaps.length)],
    ["Switches", switchText(track)],
    ["Unsupported pieces", unsupportedText(track)],
    ["Low bridges", lowBridgesText(track)],
    ["Level crossings", integer.format(track.crossings.length)],
    ["Last release", commitText(track)],
  ];
  if (track.held) rows.push(...heldRows(track.held));
  if (track.drag) rows.push(...dragRows(track.drag));
  if (track.solve) {
    rows.push([
      "Solver per pointer move",
      `median ${track.solve.medianMs.toFixed(2)} ms, p95 ${track.solve.p95Ms.toFixed(2)} ms, max ${track.solve.maxMs.toFixed(2)} ms (last ${integer.format(track.solve.samples)} moves)`,
    ]);
  }
  return (
    <section
      className="stats-section track-panel"
      aria-label="Track"
      data-track-pieces={track.pieces}
      data-model-pieces={track.modelPieces}
      data-run-frame-pieces={track.runFramePieces}
      data-off-field={track.offField}
      data-unanchored={track.unanchored}
      data-open-ends={track.openEnds}
      data-joins={track.joins}
      data-last-commit={track.lastCommit ?? ""}
      data-closure={track.drag?.closure ?? ""}
      data-gaps={track.gaps.length}
      data-switches={track.switches.map((s) => s.lever).join(",")}
      data-held={track.held?.item ?? ""}
      data-snapped={track.held?.snapped ? "1" : ""}
      data-held-misses={track.held?.misses ?? 0}
      data-withheld={track.lastWithheld ?? ""}
      data-unsupported={track.unsupported ?? ""}
      data-low-clearance={track.lowClearance ?? ""}
      data-last-unsupported={track.lastUnsupported?.pieces ?? 0}
      data-crossings={track.crossings.length}
      data-crossing-ramps={track.crossings.reduce(
        (sum, crossing) => sum + crossing.ramps.reduce((count, ramp) => count + ramp.count, 0),
        0,
      )}
    >
      <h3>Track</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {track.crossings.length > 0 && (
        <ul className="track-crossings" aria-label="Level crossings">
          {track.crossings.map((crossing, index) => (
            <li key={`${index}-${crossing.roadwayCells}`}>{crossingText(crossing, index)}</li>
          ))}
        </ul>
      )}
      {track.gaps.length > 0 && (
        <ul className="track-gaps" aria-label="Near-miss gaps">
          {track.gaps.slice(0, LISTED_GAPS).map((gap) => (
            <li
              key={`${gap.a.xLdu},${gap.a.zLdu},${gap.b.xLdu},${gap.b.zLdu}`}
              className="mismatch"
            >
              {gapText(gap)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function choiceLabel(choice: TrackChoiceView): string {
  switch (choice.kind) {
    case "straight":
      return "Straight";
    case "left":
      return "Curve left";
    case "right":
      return "Curve right";
    case "piece":
      return choice.piece.label;
    case "join":
      return `Join: ${choice.straights + choice.curves} pieces`;
    default: {
      const unhandled: never = choice;
      throw new Error(`unhandled choice ${String(unhandled)}`);
    }
  }
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function choiceDetail(choice: TrackChoiceView): string {
  const run =
    choice.kind === "piece"
      ? libraryPieceEndText(choice.piece)
      : `${choice.straights} straight, ${choice.curves} curve`;
  if (choice.blocked) return `${run}; it would ${trackBlockText(choice.blocked)}`;
  return choice.joinsEnd ? `${run}; joins an open end exactly` : run;
}

interface ExtendStripProps {
  readonly editor: IEditor;
  readonly extend: TrackExtendView;
}

function ExtendStrip({ editor, extend }: ExtendStripProps) {
  const current = extend.choices[extend.index];
  return (
    <div
      className="track-extend"
      data-choice={current?.kind ?? ""}
      data-choice-index={extend.index}
      data-choice-pieces={current ? current.straights + current.curves : 0}
      data-choice-joins={current?.joinsEnd ? "true" : "false"}
      data-choice-blocked={current?.blocked ? "true" : "false"}
      data-unjoined={extend.unjoined?.refusal ?? ""}
    >
      <p>{extend.continuing ? "From the last end laid" : "On the open end pointed at"}</p>
      <ol aria-label="Choices for the next piece">
        {extend.choices.map((choice, index) => (
          <li key={`${choice.kind}-${index}`}>
            <button
              type="button"
              aria-pressed={index === extend.index}
              className={choice.blocked ? "blocked" : choice.joinsEnd ? "joins" : undefined}
              title={choiceDetail(choice)}
              onClick={() => editor.selectTrackChoice(index)}
            >
              {choiceLabel(choice)}
            </button>
          </li>
        ))}
      </ol>
      {current && <p>{sentence(choiceDetail(current))}</p>}
      {extend.unjoined && <p>{sentence(unjoinedText(extend.unjoined))}</p>}
    </div>
  );
}

function clearanceText(height: TrackHeightView): string {
  const train = height.tallestTrain;
  if (!train)
    return "Bridges over track are checked once the bundled and imported trains are measured.";
  return `Track over other track should leave ${heightText(train.heightLdu)} above the lower rails, the height of the tallest train, ${train.model}. A lower bridge is laid and reported.`;
}

export function TrackHeightPanel({
  editor,
  snapshot,
}: {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}) {
  const height = snapshot.track?.height ?? null;
  if (snapshot.mode !== "track" || !height) return null;
  const { drawingPlates, rampPlates } = height;
  return (
    <section
      className="inspector track-height-panel"
      aria-label="Track height"
      data-drawing-plates={drawingPlates}
      data-ramp-plates={rampPlates}
      data-tallest-train-ldu={height.tallestTrain?.heightLdu ?? ""}
      data-placing-piers={snapshot.track?.placingPiers ? "true" : "false"}
    >
      <h2>Track height</h2>
      <div className="track-height-row">
        <button
          type="button"
          aria-label="Draw one plate lower"
          disabled={drawingPlates === 0 || snapshot.readOnly}
          onClick={() => editor.raiseTrack(-1)}
        >
          −
        </button>
        <output aria-label="Drawing height">{heightText(height.drawingLdu)}</output>
        <button
          type="button"
          aria-label="Draw one plate higher"
          disabled={snapshot.readOnly}
          onClick={() => editor.raiseTrack(1)}
        >
          +
        </button>
      </div>
      <div className="track-height-row" role="group" aria-label="Ramp rise per piece">
        {height.rampRates.map((rate) => (
          <button
            key={rate}
            type="button"
            aria-pressed={rate === rampPlates}
            disabled={snapshot.readOnly}
            onClick={() => editor.setTrackRampPlates(rate)}
          >
            {`${rate} ${rate === 1 ? "plate" : "plates"} a piece`}
          </button>
        ))}
      </div>
      <p>
        {`Ramps climb ${rampPlates} ${rampPlates === 1 ? "plate" : "plates"} per straight (${tenths.format(height.gradePercent)} % grade). `}
        <strong className="unverified">Unverified:</strong>
        {
          " no source gives a maximum grade for LEGO trains; 1 plate per 16 studs is one club's convention. A ramp piece is supported when each end rests on a pier's studs at that end's height or joins supported level track; new ramps get piers under their raised ends."
        }
      </p>
      <p>{clearanceText(height)}</p>
      {snapshot.track?.placingPiers && <p role="status">Building the run's piers…</p>}
      <p className="toolbar-hint">
        Page Up and Page Down change the height (Shift for a brick). New runs start at this height;
        runs from an open end ramp toward it. Raised pieces get brick piers where their anti-studs
        meet studs.
      </p>
    </section>
  );
}

function piecesText(count: number): string {
  return `${integer.format(count)} ${count === 1 ? "piece" : "pieces"}`;
}

function endAt(end: TrackEndView): string {
  return `${studsText(end.xLdu)}, ${studsText(end.zLdu)}`;
}

function climbText(closure: LoopClosureView): string | null {
  const rise = closure.to.yPlates - closure.from.yPlates;
  if (rise === 0) return null;
  const plates = Math.abs(rise);
  return `${rise > 0 ? "climbs" : "drops"} ${plates} ${plates === 1 ? "plate" : "plates"} on the way`;
}

function loopText(closure: LoopClosureView): string {
  const parts = closure.parts
    .map((line) => `${integer.format(line.count)} × ${line.part} ${line.title}`)
    .join(", ");
  const ends = `joins the open ends at studs ${endAt(closure.from)} and ${endAt(closure.to)}, ${studsText(closure.gapLdu)} studs apart`;
  const climb = climbText(closure);
  return `${sentence(parts)} It ${ends}${climb === null ? "" : `, and ${climb}`}.`;
}

function checkingText(loops: TrackLoopsView): string {
  if (loops.pairs === null) return "Looking for open ends that face each other…";
  return `Checking pairs of open ends: ${integer.format(loops.checked)} of ${integer.format(loops.pairs)}…`;
}

export function TrackLoopsPanel({
  editor,
  snapshot,
}: {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}) {
  const track = snapshot.track;
  if (snapshot.mode !== "track" || snapshot.readOnly || !track || track.openEnds < 2) return null;
  const { loops } = track;
  const scanning = loops.pairs === null || loops.checked < loops.pairs;
  const closable = track.held === null && track.drag === null;
  const unlisted = loops.closures.length - LISTED_LOOPS;
  return (
    <section
      className="inspector track-loops-panel"
      aria-label="Close gaps"
      data-closures={loops.closures.length}
      data-scanning={scanning ? "true" : "false"}
      data-waiting={loops.waiting}
      data-previewed={loops.previewed ?? ""}
    >
      <h2>Close gaps</h2>
      {loops.closures.length > 0 && (
        <ol aria-label="Gaps that close exactly">
          {loops.closures.slice(0, LISTED_LOOPS).map((closure) => (
            <li
              key={closure.key}
              data-pieces={closure.pieces}
              data-previewed={closure.key === loops.previewed ? "true" : "false"}
            >
              <button
                type="button"
                disabled={!closable}
                onPointerEnter={() => editor.previewTrackLoop(closure.key)}
                onPointerLeave={() => editor.previewTrackLoop(null)}
                onFocus={() => editor.previewTrackLoop(closure.key)}
                onBlur={() => editor.previewTrackLoop(null)}
                onClick={(event) => editor.closeTrackLoop(closure.key, event.timeStamp)}
              >
                {`Close with ${piecesText(closure.pieces)}`}
              </button>
              <p>{loopText(closure)}</p>
            </li>
          ))}
        </ol>
      )}
      {unlisted > 0 && (
        <p>{`${integer.format(unlisted)} more ${unlisted === 1 ? "gap closes" : "gaps close"} farther apart.`}</p>
      )}
      {scanning && <p role="status">{checkingText(loops)}</p>}
      {!scanning && loops.waiting > 0 && (
        <p role="status">{`${integer.format(loops.waiting)} ${loops.waiting === 1 ? "pair waits" : "pairs wait"} for a model's studs to be checked, and ${loops.waiting === 1 ? "is" : "are"} checked again once they are.`}</p>
      )}
      {!scanning && loops.waiting === 0 && loops.closures.length === 0 && (
        <p>
          No pair of open ends facing each other nearby closes exactly with this kit's straights and
          curves without crossing track, a model or itself.
        </p>
      )}
      <p className="toolbar-hint">
        Point at a Close button to preview its run. O closes the nearest gap. Each close is one undo
        step.
      </p>
    </section>
  );
}

export function TrackExtendPanel({
  editor,
  snapshot,
}: {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}) {
  const extend = snapshot.track?.extend ?? null;
  if (snapshot.mode !== "track" || !extend) return null;
  return (
    <section className="inspector track-extend-panel" aria-label="Next piece">
      <h2>Next piece</h2>
      <ExtendStrip editor={editor} extend={extend} />
      <p className="toolbar-hint">
        Click the preview or press Enter to lay it, and keep going from its far end. W, A and D lay
        a straight, a left curve or a right curve. Click a track piece in the library to lay it on
        the last end laid; it stays previewed on its far end, Enter lays another, and Q turns it to
        attach by its next end. Pick another choice here, or step through them with , and . (exact
        joins to nearby ends are among them).
      </p>
    </section>
  );
}
