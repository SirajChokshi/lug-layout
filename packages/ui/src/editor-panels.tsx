import {
  TRACK_ITEM_ID,
  type EditorCredits,
  type EditorSnapshot,
  type IEditor,
  type LatencySample,
  type RoadIssueView,
} from "@brr/client";
import { CreditLinks, partsCreditText } from "./site-chrome.tsx";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DEGREES_PER_QUARTER_TURN = 90;

function ldu(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function degrees(rot: number): string {
  return `${rot * DEGREES_PER_QUARTER_TURN}°`;
}

function itemLabel(snapshot: EditorSnapshot, id: string | null): string {
  if (id === null) return "none";
  return snapshot.catalog.find((item) => item.id === id)?.label ?? id;
}

interface PanelProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

function issueText(issue: RoadIssueView): string {
  const axis = issue.side === "minX" || issue.side === "maxX" ? "x" : "z";
  const along = axis === "x" ? "z" : "x";
  return `${issue.item.replace(/^[a-z]+:/u, "")} ${issue.side} edge at ${axis} = ${issue.line}, ${along} ${issue.from}…${issue.to}, top ${issue.topLdu} LDU`;
}

export function RoadJoins({ editor, snapshot }: PanelProps) {
  const { roads } = snapshot;
  return (
    <details className="road-joins" aria-label="Road joins">
      <summary>
        <h2>Road joins</h2>
        <span className="road-joins-summary">
          {roads.joinedCells} joined · {roads.openCells} open · {roads.mismatchedCells} mismatched
        </span>
      </summary>
      <label className="road-joins-toggle">
        <input
          type="checkbox"
          checked={snapshot.showJoins}
          onChange={(event) => editor.setShowJoins(event.target.checked)}
        />
        Show join markers (green joined, amber open, red mismatch)
      </label>
      <label className="road-joins-toggle">
        <input
          type="checkbox"
          checked={snapshot.snapRoads}
          onChange={(event) => editor.setSnapRoads(event.target.checked)}
        />
        Snap road pieces to matching road edges and refuse clicks that would mismatch
      </label>
      <dl>
        <div>
          <dt>Road pieces</dt>
          <dd>{roads.placements}</dd>
        </div>
        <div>
          <dt>Last join check</dt>
          <dd data-road="check-ms">{roads.checkMs.toFixed(1)} ms</dd>
        </div>
        <div>
          <dt>Joined edge cells</dt>
          <dd data-road="joined">{roads.joinedCells}</dd>
        </div>
        <div>
          <dt>Open road edge cells</dt>
          <dd data-road="open">{roads.openCells}</dd>
        </div>
        <div>
          <dt>Mismatched edge cells</dt>
          <dd data-road="mismatch">{roads.mismatchedCells}</dd>
        </div>
        <div>
          <dt>Overlapping pieces</dt>
          <dd data-road="overlap">{roads.overlaps}</dd>
        </div>
      </dl>
      {roads.issues.length > 0 && (
        <ul className="road-issues">
          {roads.issues.map((issue) => (
            <li
              key={`${issue.item}-${issue.side}-${issue.line}-${issue.from}`}
              className={issue.status}
            >
              {issue.status === "open" ? "Open: " : "Mismatch: "}
              {issueText(issue)}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function PlacementToolbar({ editor, snapshot }: PanelProps) {
  const canRotate = snapshot.mode === "place" || snapshot.selection !== null;
  const { history } = snapshot;
  return (
    <div className="toolbar" role="toolbar" aria-label="Placement tools">
      <button
        type="button"
        aria-pressed={snapshot.mode === "select"}
        onClick={() => editor.chooseItem(null)}
      >
        Select (Esc)
      </button>
      <button
        type="button"
        data-action="draw-track"
        aria-pressed={snapshot.mode === "track"}
        onClick={() => editor.chooseItem(snapshot.mode === "track" ? null : TRACK_ITEM_ID)}
      >
        Draw track (T)
      </button>
      <button
        type="button"
        disabled={!canRotate}
        onClick={(event) => editor.rotate(event.timeStamp)}
      >
        Rotate 90° (R)
      </button>
      <button
        type="button"
        disabled={snapshot.selection === null}
        onClick={(event) => editor.deleteSelection(event.timeStamp)}
      >
        Delete (Del)
      </button>
      <button
        type="button"
        disabled={snapshot.selection === null}
        onClick={() => editor.focusSelection()}
      >
        Focus (F)
      </button>
      <button
        type="button"
        data-action="undo"
        disabled={history.undo === null}
        onClick={(event) => editor.undo(event.timeStamp)}
      >
        Undo{history.undo === null ? "" : ` ${history.undo}`} (Ctrl+Z)
      </button>
      <button
        type="button"
        data-action="redo"
        disabled={history.redo === null}
        onClick={(event) => editor.redo(event.timeStamp)}
      >
        Redo{history.redo === null ? "" : ` ${history.redo}`} (Ctrl+Shift+Z)
      </button>
      <p className="toolbar-hint">
        Click picks a model; Shift-, Ctrl- or Cmd-click adds or removes one; Ctrl+A picks all. Drag
        a model to move the selection on the grid; the arrow keys nudge it one step. Drag on empty
        ground to box-select: left to right takes models wholly inside, right to left takes anything
        the box touches, Shift adds. Right-drag orbits, middle-drag or Shift+right-drag pans, the
        wheel zooms, C centres on the cursor.
      </p>
    </div>
  );
}

export function Inspector({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const { selection } = snapshot;
  if (!selection) return null;
  return (
    <section className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      <dl>
        {selection.count > 1 && (
          <div>
            <dt>Selected</dt>
            <dd data-selection-count={selection.count}>
              {selection.count} models, {ldu(selection.bounds.maxX - selection.bounds.minX)} ×{" "}
              {ldu(selection.bounds.maxZ - selection.bounds.minZ)} LDU
            </dd>
          </div>
        )}
        <div>
          <dt>{selection.count > 1 ? "Last picked" : "Model"}</dt>
          <dd>{itemLabel(snapshot, selection.item)}</dd>
        </div>
        <div>
          <dt>x, z (LDU)</dt>
          <dd>
            {selection.x}, {selection.z}
          </dd>
        </div>
        <div>
          <dt>Height (plates)</dt>
          <dd>{selection.yPlates}</dd>
        </div>
        <div>
          <dt>Rotation</dt>
          <dd>{degrees(selection.rot)}</dd>
        </div>
        <div>
          <dt>Footprint x, z (LDU)</dt>
          <dd>
            {ldu(selection.box.minX)}…{ldu(selection.box.maxX)}, {ldu(selection.box.minZ)}…
            {ldu(selection.box.maxZ)}
          </dd>
        </div>
        {selection.baseplate && (
          <div>
            <dt>Baseplate x, z (LDU), top</dt>
            <dd data-selection-baseplate>
              {ldu(selection.baseplate.minX)}…{ldu(selection.baseplate.maxX)},{" "}
              {ldu(selection.baseplate.minZ)}…{ldu(selection.baseplate.maxZ)}, y ={" "}
              {ldu(selection.baseplate.topY)}
            </dd>
          </div>
        )}
        <div>
          <dt>Chunk key, slot</dt>
          <dd>
            {selection.chunkKey}, {selection.slot}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function seatText(snapshot: EditorSnapshot): string {
  const grid = snapshot.baseplateGridStuds;
  const item = snapshot.catalog.find((entry) => entry.id === snapshot.activeItem);
  if (!item) return grid === null ? "none" : `baseplate grid ${grid} studs`;
  if (!item.baseplate) return "no baseplate of its own, on the stud lattice";
  const { plates, studsWide, studsDeep } = item.baseplate;
  const gridText = grid === null ? "" : `, edges on the ${grid}-stud baseplate grid`;
  return `${plates} baseplate${plates === 1 ? "" : "s"}, ${studsWide}×${studsDeep} studs, top at y = 0${gridText}`;
}

function snapText(snapshot: EditorSnapshot): string {
  const { snap } = snapshot;
  if (!snap) return "none";
  switch (snap.state) {
    case "snapped":
      return `snapped, ${snap.joinedCells} edge cells join`;
    case "free":
      return snap.joinedCells > 0
        ? `exact here, ${snap.joinedCells} edge cells join`
        : "free, touches no road";
    case "refused":
      return `click refused: ${snap.mismatchedCells} mismatched, ${snap.overlappingCells} overlapping cells`;
    default: {
      const unhandled: never = snap.state;
      throw new Error(`unhandled snap state ${String(unhandled)}`);
    }
  }
}

function latencyText(sample: LatencySample | null, snapshot: EditorSnapshot): string {
  if (!sample) return "none yet";
  const action = sample.step === "do" ? sample.action : `${sample.step} ${sample.action}`;
  return `${sample.ms.toFixed(1)} ms (${action} ${itemLabel(snapshot, sample.item)}, ${degrees(sample.rot)})`;
}

function rebuildText(sample: LatencySample | null): string {
  if (!sample) return "none yet";
  return `${sample.rebuiltChunks} chunks, ${integer.format(sample.rebuiltInstances)} parts, ${integer.format(sample.rebuiltStuds)} studs`;
}

export function EditorHud({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const { backend, stats } = snapshot;
  const rows: Array<readonly [string, string]> = [];
  if (backend) {
    rows.push(
      [
        "API",
        backend.activeApi === backend.requestedApi
          ? backend.activeApi
          : `${backend.activeApi} (asked ${backend.requestedApi})`,
      ],
      ["Adapter", backend.adapter],
    );
  }
  if (snapshot.loadMs !== null) rows.push(["Load", `${integer.format(snapshot.loadMs)} ms`]);
  rows.push(
    [
      "Mode",
      snapshot.mode === "select"
        ? "select"
        : `${snapshot.mode} ${itemLabel(snapshot, snapshot.activeItem)}`,
    ],
    ["Ghost rotation", degrees(snapshot.ghostRot)],
    [
      "Moving",
      snapshot.move
        ? `${snapshot.move.models} by ${snapshot.move.dx}, ${snapshot.move.dz} LDU${snapshot.move.refusal ? `: refused, ${snapshot.move.refusal}` : ""}`
        : "no",
    ],
    ["Baseplate seat", seatText(snapshot)],
    ["Road-edge snap", snapText(snapshot)],
    [
      "Cursor on lattice (LDU)",
      snapshot.hover ? `${snapshot.hover.x}, ${snapshot.hover.z}` : "off the ground",
    ],
    [
      "Lands at (plates)",
      snapshot.hover && snapshot.mode === "place" ? String(snapshot.hover.yPlates) : "–",
    ],
    ["Placements", integer.format(snapshot.placements)],
    [
      "History (undo, redo)",
      `${integer.format(snapshot.history.undoDepth)}, ${integer.format(snapshot.history.redoDepth)}`,
    ],
    ["Last edit latency", latencyText(snapshot.lastLatency, snapshot)],
    ["Rebuilt for it", rebuildText(snapshot.lastLatency)],
  );
  if (snapshot.studs) {
    rows.push(
      ["Studs drawn", integer.format(snapshot.studs.drawn)],
      ["Studs culled inside models", integer.format(snapshot.studs.culledInsideModels)],
      ["Studs culled under footprints", integer.format(snapshot.studs.culledUnderFootprints)],
    );
  }
  if (stats) {
    rows.push(
      ["Frame rate (rAF)", `${stats.fps.toFixed(1)} fps`],
      ["Draw calls", integer.format(stats.drawCalls)],
      ["Drawn triangles", integer.format(stats.triangles)],
    );
  }
  return (
    <aside className="hud editor-hud">
      <h1>Brick Railroad</h1>
      {snapshot.status === "loading" && <p>Loading the bundle and the 10 sets…</p>}
      {snapshot.error !== null && <p className="error">{snapshot.error}</p>}
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function modelCredits(credits: EditorCredits): string {
  return credits.models
    .map((model) => {
      const authors = [...new Set(model.sections.map((s) => s.author).filter((a) => a !== ""))];
      const licenses = [...new Set(model.sections.flatMap((s) => (s.license ? [s.license] : [])))];
      return `${model.name}${authors.length > 0 ? ` by ${authors.join(", ")}` : ""}${licenses.length > 0 ? ` (${licenses.join("; ")})` : ""}`;
    })
    .join("; ");
}

export function CreditsFooter({
  snapshot,
  disclaimer,
}: {
  readonly snapshot: EditorSnapshot;
  readonly disclaimer: string;
}) {
  const { credits } = snapshot;
  return (
    <footer>
      {credits &&
        `Models from the LDraw Official Model Repository: ${modelCredits(credits)}. ${partsCreditText(credits.partFiles, credits.partFilesLod)}`}
      {disclaimer} <CreditLinks />
    </footer>
  );
}

export function PlacementRules({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const { ghost, lastRefusal } = snapshot;
  const ghostText =
    snapshot.mode !== "place" || ghost === null
      ? "no item in hand"
      : ghost.refusal
        ? `refused: ${ghost.refusal.message}`
        : `lands at ${ghost.yPlates} plates, supported${ghost.trackJoins > 0 ? `; ${ghost.trackJoins} track ${ghost.trackJoins === 1 ? "end joins" : "ends join"} exactly` : ""}${ghost.uncertifiedTrack > 0 ? `; ${ghost.uncertifiedTrack} track ${ghost.uncertifiedTrack === 1 ? "part in it isn't" : "parts in it aren't"} certified, so ${ghost.uncertifiedTrack === 1 ? "its ends don't" : "their ends don't"} join` : ""}`;
  return (
    <section
      className="inspector placement-rules"
      aria-label="Placement rules"
      data-ghost-refused={ghost?.refusal ? ghost.refusal.rule : ""}
      data-ghost-track-joins={ghost?.trackJoins ?? 0}
      data-ghost-uncertified-track={ghost?.uncertifiedTrack ?? 0}
      data-refusals={snapshot.refusals}
      data-last-refusal-rule={lastRefusal?.rule ?? ""}
    >
      <h2>Placement rules</h2>
      <p className="toolbar-hint">
        Only baseplates, road plates and models with their own baseplate rest on the table.
        Everything else rests on studs or a flat top, and track sits on a baseplate.
      </p>
      <dl>
        <div>
          <dt>Ghost</dt>
          <dd data-rule="ghost">{ghostText}</dd>
        </div>
        <div>
          <dt>Refused edits</dt>
          <dd data-rule="refusals">{snapshot.refusals}</dd>
        </div>
        {lastRefusal && (
          <div>
            <dt>Last refusal ({lastRefusal.action})</dt>
            <dd data-rule="last-refusal">{lastRefusal.message}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
