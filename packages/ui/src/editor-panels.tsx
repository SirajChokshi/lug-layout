import {
  TRACK_ITEM_ID,
  type EditorCredits,
  type EditorSnapshot,
  type IEditor,
  type LatencySample,
  type RoadIssueView,
  type ShellCommandId,
} from "@brr/client";
import { shortcutText } from "./keys.tsx";
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
        <div>
          <dt>Refused clicks</dt>
          <dd data-road="refused">
            {snapshot.refusedClicks}
            {snapshot.lastRefusal &&
              ` (last: ${snapshot.lastRefusal.item.replace(/^[a-z]+:/u, "")} at ${snapshot.lastRefusal.x}, ${snapshot.lastRefusal.z}, ${snapshot.lastRefusal.mismatchedCells} mismatched, ${snapshot.lastRefusal.overlappingCells} overlapping)`}
          </dd>
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

export function PlacementToolbar({
  editor,
  snapshot,
  onShellCommand,
}: PanelProps & { readonly onShellCommand: (id: ShellCommandId) => void }) {
  const canRotate = snapshot.mode === "place" || snapshot.selection !== null;
  const { history } = snapshot;
  return (
    <div className="toolbar" role="toolbar" aria-label="Placement tools">
      <button
        type="button"
        aria-pressed={snapshot.mode === "select"}
        onClick={() => editor.chooseItem(null)}
      >
        Select ({shortcutText("select-tool")})
      </button>
      <button
        type="button"
        data-action="draw-track"
        aria-pressed={snapshot.mode === "track"}
        onClick={() => editor.chooseItem(snapshot.mode === "track" ? null : TRACK_ITEM_ID)}
      >
        Draw track ({shortcutText("draw-track")})
      </button>
      <button
        type="button"
        disabled={!canRotate}
        onClick={(event) => editor.rotate(event.timeStamp)}
      >
        Rotate 90° ({shortcutText("rotate")})
      </button>
      <button
        type="button"
        disabled={snapshot.selection === null}
        onClick={(event) => editor.deleteSelection(event.timeStamp)}
      >
        Delete ({shortcutText("delete")})
      </button>
      <button
        type="button"
        disabled={snapshot.selection === null}
        onClick={() => editor.focusSelection()}
      >
        Focus ({shortcutText("focus")})
      </button>
      <button
        type="button"
        data-action="undo"
        disabled={history.undo === null}
        onClick={(event) => editor.undo(event.timeStamp)}
      >
        Undo{history.undo === null ? "" : ` ${history.undo}`} ({shortcutText("undo")})
      </button>
      <button
        type="button"
        data-action="redo"
        disabled={history.redo === null}
        onClick={(event) => editor.redo(event.timeStamp)}
      >
        Redo{history.redo === null ? "" : ` ${history.redo}`} ({shortcutText("redo")})
      </button>
      <button
        type="button"
        data-action="open-palette"
        onClick={() => onShellCommand("open-palette")}
      >
        Find ({shortcutText("open-palette")})
      </button>
      <button
        type="button"
        data-action="show-shortcuts"
        onClick={() => onShellCommand("show-shortcuts")}
      >
        Shortcuts ({shortcutText("show-shortcuts")})
      </button>
      <p className="toolbar-hint">
        Right-drag orbits, Shift-drag pans, the wheel zooms. Arrows pan, Shift-arrows orbit.
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
        <div>
          <dt>Model</dt>
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

function snapText(snapshot: EditorSnapshot): string {
  const { snap } = snapshot;
  if (!snap) return "none";
  switch (snap.state) {
    case "snapped":
      return snap.joinedRoadCells > 0
        ? `snapped, lanes join on ${snap.joinedRoadCells} of ${snap.joinedCells} edge cells`
        : `snapped beside a sidewalk, ${snap.joinedCells} edge cells join`;
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
    ["Road-edge snap", snapText(snapshot)],
    [
      "Cursor on lattice (LDU)",
      snapshot.hover ? `${snapshot.hover.x}, ${snapshot.hover.z}` : "off the ground",
    ],
    ["Placements", integer.format(snapshot.placements)],
    [
      "History (undo, redo)",
      `${integer.format(snapshot.history.undoDepth)}, ${integer.format(snapshot.history.redoDepth)}`,
    ],
    ["Last edit latency", latencyText(snapshot.lastLatency, snapshot)],
    ["Rebuilt for it", rebuildText(snapshot.lastLatency)],
  );
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
