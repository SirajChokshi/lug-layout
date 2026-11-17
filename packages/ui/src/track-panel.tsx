import type { EditorSnapshot, RunBlock, TrackDragView, TrackGapView, TrackView } from "@brr/client";

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
    case "limit":
      return "the search hit its time limit before finding an exact join: release lays nothing";
    case null:
      return drag.pieces === 0
        ? "drag away from the start"
        : `ends ${drag.missStuds.toFixed(1)} studs from the cursor`;
    default: {
      const unhandled: never = drag.closure;
      throw new Error(`unhandled closure ${String(unhandled)}`);
    }
  }
}

function blockText(block: RunBlock): string {
  const at = `piece ${block.piece + 1} of ${block.pieces}`;
  switch (block.kind) {
    case "off-baseplate":
      return `${at} has ${block.missing.count} cells off the baseplates (red)`;
    case "overlap":
      return `${at} would intersect a placement at the red cell`;
    case "crosses-track":
      return `${at} crosses track it doesn't join (red cells)`;
    default: {
      const unhandled: never = block;
      throw new Error(`unhandled block ${String(unhandled)}`);
    }
  }
}

function dragRows(drag: TrackDragView): ReadonlyArray<readonly [string, string]> {
  return [
    ["Drawing from", drag.fromOpenEnd ? "an open end" : "a new start on the stud grid"],
    ["Ghost run", `${drag.pieces} pieces (${drag.straights} straight, ${drag.curves} curve)`],
    ["Join", closureText(drag)],
    ["Solve", `${drag.solveMs.toFixed(2)} ms`],
    [
      "Placement rules",
      drag.blocked
        ? `${blockText(drag.blocked)}; release lays nothing`
        : "every piece sits on a baseplate, clear of everything",
    ],
  ];
}

function commitText(track: TrackView): string {
  switch (track.lastCommit) {
    case "joined":
      return "laid and joined exactly";
    case "laid":
      return "laid with an open end";
    case "refused-impossible":
      return "refused: no exact join exists";
    case "refused-limit":
      return "refused: search hit its time limit";
    case "refused-off-baseplate":
      return "refused: part of the run has no baseplate under it";
    case "refused-overlap":
      return "refused: the run would intersect a placement";
    case "refused-crosses-track":
      return "refused: the run crosses track it doesn't join";
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
    ...track.bom.map((line): readonly [string, string] => [
      `${line.piece} ${line.title}`,
      `× ${line.count}`,
    ]),
    ["Exact joins", integer.format(track.joins)],
    ["Open ends", integer.format(track.openEnds)],
    ["Coincident ends not joined", integer.format(track.coincidentEndIssues)],
    ["Near-miss gaps", integer.format(track.gaps.length)],
    ["Last release", commitText(track)],
    [
      "Selected piece",
      track.selected
        ? `${track.selected.pieceId} #${track.selected.piece + 1}; Delete removes it`
        : "none; click a laid piece to select it",
    ],
  ];
  if (track.drag) rows.push(...dragRows(track.drag));
  if (track.solve) {
    rows.push([
      "Solver per pointer move",
      `median ${track.solve.medianMs.toFixed(2)} ms, p95 ${track.solve.p95Ms.toFixed(2)} ms, max ${track.solve.maxMs.toFixed(2)} ms (${integer.format(track.solve.samples)} moves)`,
    ]);
  }
  return (
    <section
      className="inspector track-panel"
      aria-label="Track"
      data-track-pieces={track.pieces}
      data-open-ends={track.openEnds}
      data-joins={track.joins}
      data-last-commit={track.lastCommit ?? ""}
      data-closure={track.drag?.closure ?? ""}
      data-gaps={track.gaps.length}
      data-blocked={track.drag?.blocked?.kind ?? ""}
    >
      <h2>Track</h2>
      {snapshot.mode === "track" && (
        <p className="toolbar-hint">
          Drag from an open end (or from empty ground) to lay track. Release over another open end
          to join it exactly. Amber arrows mark open ends; red arrows mark two ends that nearly meet
          but don't join. Click a laid piece and press Delete to remove it.
        </p>
      )}
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
