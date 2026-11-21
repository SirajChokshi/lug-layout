import {
  STUD_LDU,
  commandActive,
  commandEnabled,
  type EditorActionId,
  type EditorSnapshot,
  type IEditor,
  type IPanelLayout,
  type LatencySample,
  type MeshCounts,
  type MeshProgress,
  type PlaySnapshot,
  type RoadIssueView,
  type ShellCommandId,
  type RollingDiagnosticsPanel,
  type UndrawnPart,
} from "@brr/client";
import { shortcutText } from "./keys.tsx";
import { CreditLinks } from "./site-chrome.tsx";
import { useState, type FormEvent } from "react";
import { TrackPanel } from "./track-panel.tsx";
import { isCompactLayout } from "./use-compact-layout.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DEGREES_PER_QUARTER_TURN = 90;

function connectorGapsText(snapshot: EditorSnapshot): string {
  if (snapshot.mode !== "place") return "–";
  const gaps = snapshot.connectorGaps;
  if (gaps.length === 0) return "every part has one";
  return `${gaps.length} parts have none: ${gaps.map((gap) => `${gap.partId} (${gap.reason})`).join("; ")}`;
}

function countText(count: number, label: string): string {
  return count > 0 ? `, ${integer.format(count)} ${label}` : "";
}

function meshCountsText(counts: MeshCounts, meshes: string, unloaded: string): string {
  const note = counts.loaded < counts.wanted ? ` (${unloaded})` : "";
  return `${integer.format(counts.loaded)} of ${integer.format(counts.wanted)} ${meshes}loaded${countText(counts.failed, "failed")}${countText(counts.absent, "absent")}${note}`;
}

function partMeshesText(meshes: MeshProgress): string {
  return [
    meshCountsText(
      meshes.detailedPartMeshes,
      "detailed-level meshes ",
      "parts without one aren't drawn",
    ),
    meshCountsText(
      meshes.farPartMeshes,
      "far-level meshes ",
      "detailed-level meshes are drawn instead",
    ),
  ].join(", ");
}

function undrawnReasonText(reason: UndrawnPart["reason"]): string {
  switch (reason) {
    case "absent":
      return "the bundle has no mesh for it";
    case "failed":
      return "its mesh failed to load";
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled undrawn reason ${String(unhandled)}`);
    }
  }
}

function undrawnPartsText(parts: ReadonlyArray<UndrawnPart>): string {
  if (parts.length === 0) return "none";
  return parts
    .map(({ part, reason }) => `${part.replace(/^[a-z]+:/u, "")} (${undrawnReasonText(reason)})`)
    .join(", ");
}

function undrawnGlance(count: number): string {
  return `${integer.format(count)} ${count === 1 ? "part" : "parts"} not drawn`;
}

function ldu(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function degrees(rot: number): string {
  return `${rot * DEGREES_PER_QUARTER_TURN}°`;
}

function itemLabel(snapshot: EditorSnapshot, id: string | null): string {
  if (id === null) return "none";
  return (
    snapshot.catalog.find((item) => item.id === id)?.label ??
    snapshot.roadKits.find((kit) => kit.id === id)?.label ??
    id
  );
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

function RoadJoins({ editor, snapshot }: PanelProps) {
  const { roads } = snapshot;
  return (
    <details className="stats-section road-joins" aria-label="Road joins">
      <summary>
        <h3>Road joins</h3>
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
  play,
  onEditorAction,
  onShellCommand,
}: PanelProps & {
  readonly play: PlaySnapshot;
  readonly onEditorAction: (id: EditorActionId, eventTimeMs: number) => void;
  readonly onShellCommand: (id: ShellCommandId) => void;
}) {
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
        aria-pressed={commandActive("draw-track", snapshot)}
        disabled={!commandEnabled("draw-track", snapshot, play)}
        onClick={(event) => onEditorAction("draw-track", event.timeStamp)}
      >
        Draw track ({shortcutText("draw-track")})
      </button>
      <button
        type="button"
        data-action="draw-road-tool"
        aria-pressed={commandActive("draw-road", snapshot)}
        disabled={!commandEnabled("draw-road", snapshot, play)}
        onClick={(event) => onEditorAction("draw-road", event.timeStamp)}
      >
        Draw road ({shortcutText("draw-road")})
      </button>
      <button
        type="button"
        disabled={!commandEnabled("rotate", snapshot, play)}
        title={`Shift-click or ${shortcutText("rotate-back")} turns the other way`}
        onClick={(event) => editor.rotate(event.timeStamp, event.shiftKey ? -1 : 1)}
      >
        Rotate ({shortcutText("rotate")})
      </button>
      <button
        type="button"
        disabled={!commandEnabled("delete", snapshot, play)}
        onClick={(event) => editor.deleteSelection(event.timeStamp)}
      >
        Delete ({shortcutText("delete")})
      </button>
      <button
        type="button"
        data-action="undo"
        disabled={!commandEnabled("undo", snapshot, play)}
        onClick={(event) => editor.undo(event.timeStamp)}
      >
        Undo{history.undoLabel === null ? "" : ` ${history.undoLabel}`} ({shortcutText("undo")})
      </button>
      <button
        type="button"
        data-action="redo"
        disabled={!commandEnabled("redo", snapshot, play)}
        onClick={(event) => editor.redo(event.timeStamp)}
      >
        Redo{history.redoLabel === null ? "" : ` ${history.redoLabel}`} ({shortcutText("redo")})
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

type RollingDiagnosticsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly panel: RollingDiagnosticsPanel | null }
  | { readonly kind: "failed"; readonly message: string };

function RollingDiagnostics({ editor, item }: { readonly editor: IEditor; readonly item: string }) {
  const [state, setState] = useState<RollingDiagnosticsState>({ kind: "idle" });
  const load = (): void => {
    setState({ kind: "loading" });
    editor.rollingDiagnostics(item).then(
      (panel) => setState({ kind: "loaded", panel }),
      (error: unknown) =>
        setState({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  switch (state.kind) {
    case "idle":
      return (
        <button type="button" className="rolling-diagnostics-load" onClick={load}>
          Show unread rolling bands
        </button>
      );
    case "loading":
      return <p>Loading unread rolling bands…</p>;
    case "failed":
      return <p role="alert">Unread rolling bands failed to load: {state.message}</p>;
    case "loaded": {
      const parts = state.panel?.parts ?? [];
      if (parts.length === 0) return <p>No part of this model serves unread rolling bands.</p>;
      return (
        <div className="rolling-diagnostics" aria-label="Unread rolling bands">
          {parts.map((part) => (
            <div key={part.partId} className="rolling-diagnostics-part">
              <p>{part.message}</p>
              {part.rows.length > 0 && (
                <ol>
                  {part.rows.map((row, index) => (
                    <li key={index} title={row.exact}>
                      <strong>{row.reason}</strong>: {row.identified}
                      <br />
                      raw {row.raw}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      );
    }
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled rolling diagnostics state ${JSON.stringify(unhandled)}`);
    }
  }
}

export function Inspector({
  editor,
  snapshot,
}: {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}) {
  const { selection } = snapshot;
  if (!selection) return null;
  if (selection.kind === "train") {
    return (
      <section className="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <dl>
          <div>
            <dt>Train</dt>
            <dd>{itemLabel(snapshot, selection.item)}</dd>
          </div>
          <div>
            <dt>Stands</dt>
            <dd>on the rails</dd>
          </div>
          <div>
            <dt>Vehicles</dt>
            <dd>{selection.vehicles}</dd>
          </div>
          <div>
            <dt>Length (studs)</dt>
            <dd>{Math.round(selection.lengthLdu / STUD_LDU)}</dd>
          </div>
        </dl>
        <RollingDiagnostics key={selection.item} editor={editor} item={selection.item} />
      </section>
    );
  }
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
      <RollingDiagnostics key={selection.item} editor={editor} item={selection.item} />
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

export function EditorHud({
  editor,
  snapshot,
  panels,
}: PanelProps & { readonly panels: IPanelLayout }) {
  const [open, setOpen] = useState(() => !isCompactLayout() && panels.snapshot().stats);
  const { backend, stats } = snapshot;
  const glance = [
    ...(stats ? [`${stats.fps.toFixed(0)} fps`] : []),
    `${integer.format(snapshot.placements)} placed`,
  ].join(" · ");
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
    ["Connector records", connectorGapsText(snapshot)],
    ["Ghost rotation", degrees(snapshot.ghostRot)],
    ["Road-edge snap", snapText(snapshot)],
    [
      "Cursor on lattice (LDU)",
      snapshot.hover ? `${snapshot.hover.x}, ${snapshot.hover.z}` : "off the ground",
    ],
    [
      "Lands at (plates)",
      snapshot.hover && snapshot.mode === "place" ? String(snapshot.hover.yPlates) : "–",
    ],
    [
      "Placement refused",
      snapshot.hover?.refusal && snapshot.mode === "place" ? snapshot.hover.refusal : "–",
    ],
    ["Last refusal", snapshot.lastRefusal?.reason ?? "none"],
    ["Stud check", snapshot.studChecks > 0 ? `Checking (${snapshot.studChecks})` : "done"],
    ["Placements", integer.format(snapshot.placements)],
    [
      "History (undo, redo)",
      `${integer.format(snapshot.history.undoDepth)}, ${integer.format(snapshot.history.redoDepth)}`,
    ],
    ["Part meshes", partMeshesText(snapshot.meshes)],
    ["Parts not drawn", undrawnPartsText(snapshot.meshes.undrawnParts)],
    [
      "Far model meshes",
      meshCountsText(snapshot.meshes.farModelMeshes, "", "far-level part meshes are drawn instead"),
    ],
    ["Last edit latency", latencyText(snapshot.lastLatency, snapshot)],
    ["Rebuilt for it", rebuildText(snapshot.lastLatency)],
  );
  if (snapshot.studs) {
    rows.push(
      ["Studs drawn", integer.format(snapshot.studs.drawn)],
      [
        "Studs culled inside models",
        snapshot.studs.culledInsideModels === null
          ? "Checking"
          : integer.format(snapshot.studs.culledInsideModels),
      ],
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
      ...(snapshot.farTierError === null
        ? []
        : [["Far tier", `unavailable: ${snapshot.farTierError}`] as const]),
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
    <details
      className="editor-hud"
      open={open || snapshot.error !== null}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        panels.setOpen("stats", event.currentTarget.open);
      }}
    >
      <summary title={open ? "Fold the stats away" : "Show the editor's stats and readouts"}>
        <h2>Stats</h2>
        <span className="hud-glance">{glance}</span>
        {snapshot.meshes.undrawnParts.length > 0 && (
          <span className="hud-glance hud-glance-warning">
            {undrawnGlance(snapshot.meshes.undrawnParts.length)}
          </span>
        )}
      </summary>
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
      <TrackPanel snapshot={snapshot} />
      <RoadJoins editor={editor} snapshot={snapshot} />
    </details>
  );
}

export function EditorFooter({ disclaimer }: { readonly disclaimer: string }) {
  return (
    <footer className="editor-footer">
      {disclaimer} <CreditLinks />
    </footer>
  );
}
