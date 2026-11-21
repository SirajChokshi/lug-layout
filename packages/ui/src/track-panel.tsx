import {
  trackBlockText,
  unjoinedText,
  type EditorSnapshot,
  type IEditor,
  type TrackChoiceView,
  type TrackDragView,
  type TrackExtendView,
  type TrackGapView,
  type TrackPieceView,
  type TrackView,
} from "@brr/client";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const LISTED_GAPS = 8;

const studs = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

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

function closureText(drag: TrackDragView): string {
  switch (drag.closure) {
    case "exact":
      return "joins the open end exactly";
    case "impossible":
      return "no exact join exists with any run of 9V straights and R40 curves: release lays nothing";
    case "blocked":
      return drag.blocked
        ? `every exact join found would ${trackBlockText(drag.blocked)}: release lays nothing`
        : "every exact join found would cross placed track, a plate, a model or itself: release lays nothing";
    case "limit":
      return "the search hit its time limit before finding an exact join: release lays nothing";
    case "pending":
      return "a model under this join is still checking its studs: release lays nothing yet";
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

function commitText(track: TrackView): string {
  switch (track.lastCommit) {
    case "joined":
      return "laid and joined exactly";
    case "laid":
      return track.lastBlock
        ? `laid, stopped short: the next piece would ${trackBlockText(track.lastBlock)}`
        : "laid with an open end";
    case "refused-impossible":
      return "refused: no exact join exists";
    case "refused-blocked":
      return track.lastBlock
        ? `refused: every exact join would ${trackBlockText(track.lastBlock)}`
        : "refused: every exact join would cross track, a plate, a model or itself";
    case "refused-limit":
      return "refused: search hit its time limit";
    case "refused-pending":
      return "refused: a model under the join was still checking its studs";
    case "switch-straight":
      return "switch thrown to the straight route";
    case "switch-branching":
      return "switch thrown to the branching route";
    case null:
      return "none yet";
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
    ["Last release", commitText(track)],
  ];
  if (track.held) rows.push(...heldRows(track.held));
  if (track.drag) rows.push(...dragRows(track.drag));
  if (track.solve) {
    rows.push([
      "Solver per pointer move",
      `median ${track.solve.medianMs.toFixed(2)} ms, p95 ${track.solve.p95Ms.toFixed(2)} ms, max ${track.solve.maxMs.toFixed(2)} ms (${integer.format(track.solve.samples)} moves)`,
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
    case "join":
      return `Join: ${choice.straights + choice.curves} pieces`;
    default: {
      const unhandled: never = choice.kind;
      throw new Error(`unhandled choice ${String(unhandled)}`);
    }
  }
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function choiceDetail(choice: TrackChoiceView): string {
  const run = `${choice.straights} straight, ${choice.curves} curve`;
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
        a straight, a left curve or a right curve. Pick another choice here, or step through them
        with , and . (exact joins to nearby ends are among them).
      </p>
    </section>
  );
}
