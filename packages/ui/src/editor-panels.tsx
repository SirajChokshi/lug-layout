import {
  TRACK_ITEM_ID,
  commandEnabled,
  type EditorCredits,
  type EditorSnapshot,
  type IEditor,
  type LatencySample,
  type ModuleFitView,
  type ModuleIssueView,
  type RoadIssueView,
  type ShellCommandId,
} from "@brr/client";
import { shortcutText } from "./keys.tsx";
import { CreditLinks, partsCreditText } from "./site-chrome.tsx";
import { useState, type FormEvent } from "react";

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

type EdgeKind = ModuleIssueView["kind"];

const EDGE_KIND_LABELS: Readonly<Record<EdgeKind, string>> = {
  terrain: "terrain",
  road: "paved road",
  track: "earth track",
  path: "path",
  river: "river",
  rail: "rail (project rule)",
  other: "not a MILS edge",
};

const SIDE_LABELS: Readonly<Record<ModuleIssueView["side"], string>> = {
  minX: "−x",
  maxX: "+x",
  minZ: "−z",
  maxZ: "+z",
};

function moduleIssueText(issue: ModuleIssueView): string {
  const facing = issue.facing === null ? "nothing" : EDGE_KIND_LABELS[issue.facing];
  return `${issue.item.replace(/^[a-z]+:/u, "")} at ${issue.x}, ${issue.z}: ${SIDE_LABELS[issue.side]} side is ${EDGE_KIND_LABELS[issue.kind]} but meets ${facing}`;
}

export function moduleFitText(fit: ModuleFitView | null): string {
  if (!fit) return "none";
  const sides = fit.sides
    .map(({ side, kind }) => `${SIDE_LABELS[side]} ${EDGE_KIND_LABELS[kind]}`)
    .join(", ");
  if (fit.occupied) return `module cell ${fit.column}, ${fit.row} already holds a module`;
  const verdict =
    fit.mismatched > 0
      ? `${fit.mismatched} edge${fit.mismatched === 1 ? "" : "s"} would mismatch`
      : `${fit.joined} edge${fit.joined === 1 ? "" : "s"} join`;
  return `module cell ${fit.column}, ${fit.row} at ${degrees(fit.rot)}: ${verdict} (${sides})`;
}

export function ModuleJoins({ editor, snapshot }: PanelProps) {
  const { modules } = snapshot;
  return (
    <details className="road-joins module-joins" aria-label="Module joins">
      <summary>
        <h2>Module joins</h2>
        <span className="road-joins-summary">
          {modules.joined} joined · {modules.open} open · {modules.mismatched} mismatched
        </span>
      </summary>
      <label className="road-joins-toggle">
        <input
          type="checkbox"
          checked={snapshot.snapModules}
          onChange={(event) => editor.setSnapModules(event.target.checked)}
        />
        Turn MILS modules to the quarter turn that fits their neighbours
      </label>
      <p className="palette-hint">
        MILS modules sit on the 32-stud module grid. Each side is read from the module itself: a
        path, earth track, paved road, river or rail centred on the side, or plain terrain. Sides
        join when they are the same kind. The markers are green where sides join, amber where a side
        is open and red where it meets a different kind; the tall block marks where the feature
        crosses the side. Every count is of module sides, so two modules that meet add two joined or
        two mismatched sides.
      </p>
      <dl>
        <div>
          <dt>Modules on the grid</dt>
          <dd data-module="count">{modules.modules}</dd>
        </div>
        <div>
          <dt>Joined sides</dt>
          <dd data-module="joined">{modules.joined}</dd>
        </div>
        <div>
          <dt>Open sides</dt>
          <dd data-module="open">{modules.open}</dd>
        </div>
        <div>
          <dt>Mismatched sides</dt>
          <dd data-module="mismatch">{modules.mismatched}</dd>
        </div>
        {modules.offGrid > 0 && (
          <div>
            <dt>Off the module grid</dt>
            <dd data-module="off-grid">{modules.offGrid}</dd>
          </div>
        )}
      </dl>
      {modules.issues.length > 0 && (
        <ul className="road-issues">
          {modules.issues.map((issue) => (
            <li key={`${issue.item}-${issue.x}-${issue.z}-${issue.side}`} className="mismatch">
              Mismatch: {moduleIssueText(issue)}
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
        disabled={!commandEnabled("rotate", snapshot)}
        onClick={(event) => editor.rotate(event.timeStamp)}
      >
        Rotate ({shortcutText("rotate")})
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
      <GoTo editor={editor} />
      <p className="toolbar-hint">
        Right-drag orbits (pans in the 2D plan). Middle, Space or Shift-drag pans. Pinch or the
        wheel zooms at the cursor. Arrows pan, Shift-arrows orbit, double-click frames the
        selection.
      </p>
    </div>
  );
}

function GoTo({ editor }: { readonly editor: IEditor }) {
  const [x, setX] = useState("0");
  const [z, setZ] = useState("0");
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    editor.goTo(Number(x), Number(z));
  };
  return (
    <form className="go-to" onSubmit={onSubmit}>
      <input
        type="number"
        step={20}
        value={x}
        aria-label="Go to x (LDU)"
        onChange={(event) => setX(event.currentTarget.value)}
      />
      <input
        type="number"
        step={20}
        value={z}
        aria-label="Go to z (LDU)"
        onChange={(event) => setZ(event.currentTarget.value)}
      />
      <button type="submit">Go to x, z</button>
    </form>
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
  if (snapshot.world) rows.push(["World open", `${snapshot.world.openMs.toFixed(1)} ms`]);
  if (snapshot.coldStartMs !== null) {
    rows.push(["First world frame", `${integer.format(snapshot.coldStartMs)} ms after navigation`]);
  }
  rows.push(
    [
      "Mode",
      snapshot.mode === "select"
        ? "select"
        : `${snapshot.mode} ${itemLabel(snapshot, snapshot.activeItem)}`,
    ],
    ["Ghost rotation", degrees(snapshot.ghostRot)],
    ["Road-edge snap", snapText(snapshot)],
    ["Module fit", moduleFitText(snapshot.moduleFit)],
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
      [
        "Render origin (chunks), rebases",
        `(${stats.renderOriginChunkX}, ${stats.renderOriginChunkZ}); ${stats.rebases}`,
      ],
      ["Tier (L)", snapshot.tier ?? "auto"],
      ["Chunk tiers near/mid/far", `${stats.nearChunks} / ${stats.midChunks} / ${stats.farChunks}`],
      ["Projected stud pitch, nearest chunk", `${stats.nearestStudPitchPx.toFixed(1)} px`],
    );
  }
  const measured = snapshot.measurement;
  if (snapshot.measuring) rows.push(["Frame time (M)", "measuring…"]);
  else if (measured) {
    rows.push([
      "Frame time (M), GPU-synced",
      `median ${measured.medianFrameMs.toFixed(1)} ms, p95 ${measured.p95FrameMs.toFixed(1)} ms over ${measured.frames} frames`,
    ]);
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
