import {
  BRICK_LDU,
  PLATE_LDU,
  mmFromLdu,
  type EditorSnapshot,
  type IEditor,
  type RunBlock,
  type TrackDragView,
  type TrackHeightView,
  type TrackView,
} from "@brr/client";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const gradeDigits = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PLATES_PER_BRICK = BRICK_LDU / PLATE_LDU;
const PERCENT = 100;
const HEIGHT_STEPS: ReadonlyArray<readonly [string, number, string]> = [
  ["−1 brick", -PLATES_PER_BRICK, "Lower by one brick"],
  ["−1 plate", -1, "Lower by one plate"],
  ["+1 plate", 1, "Raise by one plate"],
  ["+1 brick", PLATES_PER_BRICK, "Raise by one brick"],
];

function plates(count: number): string {
  return count === 1 ? "1 plate" : `${integer.format(count)} plates`;
}

function heightText(count: number): string {
  const bricks = Math.floor(count / PLATES_PER_BRICK);
  const rest = count % PLATES_PER_BRICK;
  const stack =
    bricks === 0
      ? ""
      : ` = ${bricks} ${bricks === 1 ? "brick" : "bricks"}${rest === 0 ? "" : ` + ${plates(rest)}`}`;
  return `${plates(count)}${stack} (${oneDecimal.format(mmFromLdu(count * PLATE_LDU))} mm)`;
}

function gradeText(risePlates: number, lengthLdu: number): string {
  return `${gradeDigits.format((risePlates * PLATE_LDU * PERCENT) / lengthLdu)}%`;
}

function clearancePlates(height: TrackHeightView): number {
  return Math.ceil((height.train.heightLdu + height.railTopLdu) / PLATE_LDU);
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
      return `${at} crosses track at its own height without joining it (red cells)`;
    case "low-clearance":
      return `${at} clears the track below by ${block.gapLdu} LDU, but ${block.gauge} needs ${oneDecimal.format(block.needLdu)} LDU (red cells)`;
    case "pier-off-baseplate":
      return `a ${plates(block.plates)} joint of ${at} has no baseplate under it (red cells)`;
    case "pier-blocked":
      return `the ${plates(block.plates)} pier at ${at} would stand on something (red cells)`;
    case "too-steep":
      return `${plates(Math.abs(block.toPlates - block.fromPlates))} is too much climb for ${integer.format(block.pieces)} pieces at ${plates(block.risePerPiece)} per piece`;
    default: {
      const unhandled: never = block;
      throw new Error(`unhandled block ${String(unhandled)}`);
    }
  }
}

function climbText(drag: TrackDragView): string {
  if (drag.fromPlates === drag.toPlates && drag.toPlates === drag.targetPlates) {
    return `level at ${heightText(drag.toPlates)}`;
  }
  const short =
    drag.toPlates === drag.targetPlates
      ? ""
      : `; ${plates(Math.abs(drag.targetPlates - drag.toPlates))} short of ${integer.format(drag.targetPlates)}: drag further`;
  const curves = drag.rampCurves === 0 ? "" : `, ${integer.format(drag.rampCurves)} on curves`;
  return `${integer.format(drag.fromPlates)} → ${integer.format(drag.toPlates)} plates over ${integer.format(drag.rampPieces)} ramp pieces${curves}${short}`;
}

function dragRows(drag: TrackDragView): ReadonlyArray<readonly [string, string]> {
  return [
    ["Drawing from", drag.fromOpenEnd ? "an open end" : "a new start on the stud grid"],
    ["Ghost run", `${drag.pieces} pieces (${drag.straights} straight, ${drag.curves} curve)`],
    ["Height", climbText(drag)],
    ["New piers", integer.format(drag.newPiers)],
    ["Join", closureText(drag)],
    ["Solve", `${drag.solveMs.toFixed(2)} ms`],
    [
      "Placement rules",
      drag.blocked
        ? `${blockText(drag.blocked)}; release lays nothing`
        : "every piece and pier stands on a baseplate, clear of everything",
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
      return "refused: the run crosses track at its own height";
    case "refused-low-clearance":
      return "refused: too little clearance over the track below";
    case "refused-pier-off-baseplate":
      return "refused: a raised joint has no baseplate under it";
    case "refused-pier-blocked":
      return "refused: a pier would stand on something";
    case "refused-too-steep":
      return "refused: too steep to reach the end it joins";
    case null:
      return "none yet";
    default: {
      const unhandled: never = track.lastCommit;
      throw new Error(`unhandled commit ${String(unhandled)}`);
    }
  }
}

function heightRows(track: TrackView): ReadonlyArray<readonly [string, string]> {
  const { height } = track;
  const gaps = track.crossings.map((c) => c.gapLdu);
  return [
    [
      "Clearance over track",
      `${oneDecimal.format(height.train.heightLdu)} LDU above the lower rails for ${height.train.model}, the tallest bundled train: draw at least ${heightText(clearancePlates(height))} over ground-level track`,
    ],
    [
      "Minifig headroom",
      height.minifig
        ? `${oneDecimal.format(height.minifig.heightLdu)} LDU (${heightText(Math.ceil(height.minifig.heightLdu / PLATE_LDU))}) head to feet, measured on ${height.minifig.model}; hats and hair add more`
        : "no minifig found in the bundled sets",
    ],
    ["Piers", integer.format(track.piers)],
    ...track.pierBom.map((line): readonly [string, string] => [
      `${line.partId} ${line.title} (Light Bluish Gray)`,
      `× ${line.count}`,
    ]),
    [
      "Over/under crossings",
      gaps.length === 0
        ? "none"
        : `${integer.format(gaps.length)}, tightest ${integer.format(Math.min(...gaps))} LDU clear`,
    ],
  ];
}

function HeightControls({
  editor,
  height,
}: {
  readonly editor: IEditor;
  readonly height: TrackHeightView;
}) {
  const rates = Array.from({ length: height.maxRampRate }, (_v, i) => i + 1);
  return (
    <div
      className="track-height"
      data-draw-plates={height.drawPlates}
      data-ramp-rate={height.rampRate}
    >
      <div className="track-height-level">
        <span>Draw at</span>
        <strong>{heightText(height.drawPlates)}</strong>
      </div>
      <div className="track-height-steps">
        {HEIGHT_STEPS.map(([label, step, title]) => (
          <button
            key={label}
            type="button"
            title={title}
            disabled={height.drawPlates + step < 0}
            onClick={() => editor.setTrackHeight(height.drawPlates + step)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          title="Back to the baseplate"
          disabled={height.drawPlates === 0}
          onClick={() => editor.setTrackHeight(0)}
        >
          Ground
        </button>
      </div>
      <label className="track-height-rate">
        Ramp
        <select
          value={height.rampRate}
          onChange={(event) => editor.setRampRate(Number(event.target.value))}
        >
          {rates.map((rate) => (
            <option key={rate} value={rate}>
              {`${plates(rate)} per piece (${gradeText(rate, height.straightLdu)})`}
            </option>
          ))}
        </select>
      </label>
      <span className="track-height-note">
        {height.rampRate === 1
          ? `${gradeText(1, height.straightLdu)} on straights and ${gradeText(1, height.curveLdu)} on curves: the club convention of 1 plate per 16 studs.`
          : `${gradeText(height.rampRate, height.straightLdu)} on straights and ${gradeText(height.rampRate, height.curveLdu)} on curves: steeper than the 1 plate per 16 studs convention, and no source verifies a limit. Test it with your heaviest train.`}
      </span>
    </div>
  );
}

export function TrackPanel({
  editor,
  snapshot,
}: {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}) {
  const { track } = snapshot;
  if (!track || (snapshot.mode !== "track" && track.pieces === 0)) return null;
  const rows: Array<readonly [string, string]> = [
    ["Pieces laid", integer.format(track.pieces)],
    ...track.bom.map((line): readonly [string, string] => [
      `${line.piece} ${line.title}`,
      `× ${line.count}`,
    ]),
    ...heightRows(track),
    ["Exact joins", integer.format(track.joins)],
    ["Open ends", integer.format(track.openEnds)],
    ["Coincident ends not joined", integer.format(track.coincidentEndIssues)],
    ["Last release", commitText(track)],
    [
      "Selected piece",
      track.selected
        ? `${track.selected.pieceId} #${track.selected.piece + 1}, ${track.selected.fromPlates === track.selected.toPlates ? `level at ${plates(track.selected.fromPlates)}` : `${integer.format(track.selected.fromPlates)} → ${integer.format(track.selected.toPlates)} plates`}; Delete removes it`
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
      data-blocked={track.drag?.blocked?.kind ?? ""}
      data-piers={track.piers}
      data-crossings={track.crossings.length}
    >
      <h2>Track</h2>
      {snapshot.mode === "track" && (
        <p className="toolbar-hint">
          Drag from an open end (or from empty ground) to lay track. Release over another open end
          to join it exactly. Click a laid piece and press Delete to remove it. Page Up and Page
          Down raise or lower the drawing height by a plate (Shift: a brick); a run from an open end
          ramps toward it and stands on real-brick piers.
        </p>
      )}
      <HeightControls editor={editor} height={track.height} />
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
