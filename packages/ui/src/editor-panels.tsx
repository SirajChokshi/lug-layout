import {
  STUD_LDU,
  ZETA16_ORDER,
  altKeyName,
  effectivePlacementMode,
  commandActive,
  commandEnabled,
  commandSpec,
  placementModeSwitchEnabled,
  tallyText,
  type CommandId,
  type EditorActionId,
  type EditorSnapshot,
  type IEditor,
  type IPanelLayout,
  type IPlanService,
  type LatencySample,
  type MeshCounts,
  type MeshProgress,
  type PlaySnapshot,
  type RoadIssueView,
  type SelectionItemView,
  type SelectionView,
  type ShellCommandId,
  type RollingDiagnosticsPanel,
  type TrainSelectionView,
  type UndrawnPart,
} from "@brr/client";
import type { IconName } from "./icons/glyphs.ts";
import { Icon } from "./icons/icon.tsx";
import { PLATFORM, shortcutText } from "./keys.tsx";
import { CreditLinks } from "./site-chrome.tsx";
import { useId, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { TrackPanel } from "./track-panel.tsx";
import { isCompactLayout } from "./use-compact-layout.ts";
import { useActivePlan } from "./use-plan-version.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DEGREES_PER_QUARTER_TURN = 90;
const FULL_TURN_DEGREES = 360;

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
        Snap road pieces to matching road edges and refuse clicks that would put road in placed road
        at the same height
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

function ToolButton({
  icon,
  label,
  command,
  hint,
  labelled = false,
  ...button
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly command: CommandId;
  readonly hint?: string;
  readonly labelled?: boolean;
} & Omit<ComponentProps<"button">, "children" | "title" | "type">) {
  const keys = shortcutText(command);
  return (
    <button
      type="button"
      className="tool-button"
      title={`${label} (${keys})${hint === undefined ? "" : `. ${hint}`}`}
      aria-keyshortcuts={keys}
      {...button}
    >
      <Icon name={icon} />
      <span className={labelled ? "tool-label" : "visually-hidden"}>{label}</span>
    </button>
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
      <ToolButton
        icon="select"
        label="Select"
        command="select-tool"
        labelled
        aria-pressed={snapshot.mode === "select"}
        onClick={() => editor.chooseItem(null)}
      />
      <ToolButton
        icon="track"
        label="Draw track"
        command="draw-track"
        labelled
        data-action="draw-track"
        aria-pressed={commandActive("draw-track", snapshot)}
        disabled={!commandEnabled("draw-track", snapshot, play)}
        onClick={(event) => onEditorAction("draw-track", event.timeStamp)}
      />
      <ToolButton
        icon="road"
        label="Draw road"
        command="draw-road"
        labelled
        data-action="draw-road-tool"
        aria-pressed={commandActive("draw-road", snapshot)}
        disabled={!commandEnabled("draw-road", snapshot, play)}
        onClick={(event) => onEditorAction("draw-road", event.timeStamp)}
      />
      <ToolButton
        icon="measure"
        label="Measure"
        command="measure"
        labelled
        data-action="measure"
        aria-pressed={commandActive("measure", snapshot)}
        disabled={!commandEnabled("measure", snapshot, play)}
        onClick={(event) => onEditorAction("measure", event.timeStamp)}
      />
      {snapshot.rulers > 0 && (
        <button
          type="button"
          className="tool-button"
          data-action="clear-rulers"
          onClick={() => editor.clearRulers()}
        >
          <Icon name="ruler" />
          <span className="tool-label">
            Clear {snapshot.rulers} {snapshot.rulers === 1 ? "ruler" : "rulers"}
          </span>
        </button>
      )}
      <span className="toolbar-divider" />
      <ToolButton
        icon="rotate"
        label="Rotate"
        command="rotate"
        hint={`Shift-click or ${shortcutText("rotate-back")} turns the other way`}
        disabled={!commandEnabled("rotate", snapshot, play)}
        onClick={(event) => editor.rotate(event.timeStamp, event.shiftKey ? -1 : 1)}
      />
      <PlacementModeSwitch
        snapshot={snapshot}
        enabled={placementModeSwitchEnabled(snapshot, play)}
        onEditorAction={onEditorAction}
      />
      <span className="toolbar-divider" />
      <ToolButton
        icon="delete"
        label="Delete"
        command="delete"
        disabled={!commandEnabled("delete", snapshot, play)}
        onClick={(event) => editor.deleteSelection(event.timeStamp)}
      />
      <ToolButton
        icon="undo"
        label={history.undoLabel === null ? "Undo" : `Undo ${history.undoLabel}`}
        command="undo"
        data-action="undo"
        disabled={!commandEnabled("undo", snapshot, play)}
        onClick={(event) => editor.undo(event.timeStamp)}
      />
      <ToolButton
        icon="redo"
        label={history.redoLabel === null ? "Redo" : `Redo ${history.redoLabel}`}
        command="redo"
        data-action="redo"
        disabled={!commandEnabled("redo", snapshot, play)}
        onClick={(event) => editor.redo(event.timeStamp)}
      />
      <span className="toolbar-divider" />
      <ToolButton
        icon="find"
        label="Find"
        command="open-palette"
        data-action="open-palette"
        onClick={() => onShellCommand("open-palette")}
      />
      <ToolButton
        icon="keyboard"
        label="Shortcuts"
        command="show-shortcuts"
        data-action="show-shortcuts"
        onClick={() => onShellCommand("show-shortcuts")}
      />
    </div>
  );
}

function switchState(precise: boolean, held: boolean, alt: string): string {
  if (held) return `${precise ? "On" : "Off"} while ${alt} held`;
  return precise ? "On" : "Off, magnetic";
}

function PlacementModeSwitch({
  snapshot,
  enabled,
  onEditorAction,
}: {
  readonly snapshot: EditorSnapshot;
  readonly enabled: boolean;
  readonly onEditorAction: (id: EditorActionId, eventTimeMs: number) => void;
}) {
  const precise = snapshot.placementMode === "precise";
  const effective = effectivePlacementMode(snapshot.placementMode, snapshot.placementModeOverride);
  const held = effective !== snapshot.placementMode;
  const heldId = useId();
  const alt = altKeyName(PLATFORM);
  const [chord] = commandSpec("toggle-placement-mode").keys;
  return (
    <button
      type="button"
      role="switch"
      className="tool-button placement-mode"
      aria-checked={precise}
      aria-describedby={held ? heldId : undefined}
      aria-keyshortcuts={chord?.key}
      disabled={!enabled}
      data-action="placement-mode"
      data-placement-mode={snapshot.placementMode}
      data-effective-mode={effective}
      data-held={held ? "" : undefined}
      title={`Press ${shortcutText("toggle-placement-mode")} or click to switch. Magnetic placement snaps a held model onto connectors near the cursor; precise placement puts it exactly at the cursor. Hold ${alt} to switch while held (${alt} with a two-finger scroll still orbits).`}
      onClick={(event) => onEditorAction("toggle-placement-mode", event.timeStamp)}
    >
      <Icon name="precise" />
      <span className="tool-label">Precise placement</span>
      <span className="placement-mode-state" aria-hidden="true">
        {switchState(effective === "precise", held, alt)} ({shortcutText("toggle-placement-mode")})
      </span>
      {held && (
        <span id={heldId} hidden>
          {effective === "precise" ? "Temporarily on" : "Temporarily off, magnetic"} while {alt} is
          held
        </span>
      )}
    </button>
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

const WHOLE_STUDS = /^\s*-?\d+\s*$/u;

interface StudDraft {
  readonly text: string;
  readonly owner: string;
}

function StudField({
  label,
  value,
  owner,
  disabled,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly owner: string;
  readonly disabled: boolean;
  readonly onCommit: (value: number, eventTimeMs: number) => void;
}) {
  const [draft, setDraft] = useState<StudDraft | null>(null);
  const discarding = useRef(false);
  const typed = draft?.owner === owner ? draft.text : null;
  const commit = (input: HTMLInputElement, eventTimeMs: number): void => {
    const discarded = discarding.current || !input.isConnected;
    discarding.current = false;
    setDraft(null);
    if (discarded || typed === null || !WHOLE_STUDS.test(typed)) return;
    const whole = Number(typed);
    if (Number.isSafeInteger(whole) && whole !== value) onCommit(whole, eventTimeMs);
  };
  return (
    <label className="selection-field">
      <span className="selection-field-label">{label}</span>
      <input
        type="number"
        step={1}
        value={typed ?? String(value)}
        disabled={disabled}
        onChange={(event) => setDraft({ text: event.currentTarget.value, owner })}
        onWheel={(event) => {
          if (!event.currentTarget.matches(":focus")) return;
          discarding.current = true;
          event.currentTarget.blur();
        }}
        onBlur={(event) => commit(event.currentTarget, event.timeStamp)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget, event.timeStamp);
          if (event.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}

const QUARTER_TURNS = [0, 1, 2, 3] as const;
const LISTED_ITEMS = 3;

function studs(ldu: number): string {
  return integer.format(ldu / STUD_LDU);
}

function itemsText(snapshot: EditorSnapshot, items: ReadonlyArray<string>): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  const listed = [...counts]
    .toSorted(([, a], [, b]) => b - a)
    .map(([item, count]) => `${count > 1 ? `${count} × ` : ""}${itemLabel(snapshot, item)}`);
  const more = listed.length - LISTED_ITEMS;
  return [...listed.slice(0, LISTED_ITEMS), ...(more > 0 ? [`${more} more`] : [])].join(", ");
}

function lowestPlates(members: ReadonlyArray<SelectionItemView>): number {
  return Math.min(
    ...members.flatMap((member) => (member.kind === "train" ? [] : [member.yPlates])),
  );
}

function TrainFacts({
  snapshot,
  train,
}: {
  readonly snapshot: EditorSnapshot;
  readonly train: TrainSelectionView;
}) {
  return (
    <dl>
      <div>
        <dt>Train</dt>
        <dd>{itemLabel(snapshot, train.item)}</dd>
      </div>
      <div>
        <dt>Stands</dt>
        <dd>on the rails</dd>
      </div>
      <div>
        <dt>Vehicles</dt>
        <dd>{train.vehicles}</dd>
      </div>
      <div>
        <dt>Length (studs)</dt>
        <dd>{Math.round(train.lengthLdu / STUD_LDU)}</dd>
      </div>
    </dl>
  );
}

function selectionMeta(selection: SelectionView, size: string, items: string): string {
  const { primary, members } = selection;
  if (members.length > 1) return `${size} · ${items}`;
  if (primary.kind !== "track") return size;
  return `Track piece · heading ${(primary.heading * FULL_TURN_DEGREES) / ZETA16_ORDER}° · ${size}`;
}

export function SelectionPanel({
  editor,
  snapshot,
  play,
  onEditorAction,
}: PanelProps & {
  readonly play: PlaySnapshot;
  readonly onEditorAction: (id: EditorActionId, eventTimeMs: number) => void;
}) {
  const { selection } = snapshot;
  if (!selection) return null;
  const { primary, members, box, tally, movable, pivotStuds } = selection;
  const single = members.length === 1;
  const poseEditable = commandEnabled("nudge-right", snapshot, play);
  const height = lowestPlates(members);
  const action = (id: EditorActionId, enabled = commandEnabled(id, snapshot, play)) => ({
    disabled: !enabled,
    onClick: (event: { readonly timeStamp: number }) => onEditorAction(id, event.timeStamp),
  });
  const size = `${studs(box.maxX - box.minX)} × ${studs(box.maxZ - box.minZ)} studs`;
  const items = itemsText(
    snapshot,
    members.map((member) => member.item),
  );
  const owner = pivotStuds
    ? `${primary.item} ${members.length} ${pivotStuds.x} ${pivotStuds.z}`
    : primary.item;
  return (
    <section className="inspector selection-panel" aria-label="Selection">
      <h2>Selection</h2>
      {primary.kind === "train" ? (
        <TrainFacts snapshot={snapshot} train={primary} />
      ) : (
        <>
          <p className="selection-name">{single ? items : tallyText(tally)}</p>
          <p className="selection-meta">{selectionMeta(selection, size, items)}</p>
        </>
      )}
      {movable && pivotStuds && (
        <>
          <div className="selection-fields">
            <StudField
              label="X studs"
              value={pivotStuds.x}
              owner={owner}
              disabled={!poseEditable}
              onCommit={(x, time) => editor.moveSelectionTo(x, pivotStuds.z, time)}
            />
            <StudField
              label="Z studs"
              value={pivotStuds.z}
              owner={owner}
              disabled={!poseEditable}
              onCommit={(z, time) => editor.moveSelectionTo(pivotStuds.x, z, time)}
            />
            <label className="selection-field">
              <span className="selection-field-label">Height</span>
              <output>
                {height} plate{height === 1 ? "" : "s"}
              </output>
            </label>
          </div>
          <span className="selection-field-label" aria-hidden="true">
            Rotation
          </span>
          <div className="selection-segment" role="group" aria-label="Rotation">
            {single && primary.kind === "model" ? (
              QUARTER_TURNS.map((rot) => (
                <button
                  key={rot}
                  type="button"
                  aria-pressed={primary.rot === rot}
                  disabled={!poseEditable}
                  onClick={(event) => editor.turnSelectedModelTo(rot, event.timeStamp)}
                >
                  {degrees(rot)}
                </button>
              ))
            ) : (
              <>
                <button type="button" {...action("rotate-back", poseEditable)}>
                  Turn back <kbd>{shortcutText("rotate-back")}</kbd>
                </button>
                <button type="button" {...action("rotate", poseEditable)}>
                  Turn <kbd>{shortcutText("rotate")}</kbd>
                </button>
              </>
            )}
          </div>
        </>
      )}
      <div className="selection-actions">
        {movable && (
          <button type="button" {...action("copy")}>
            Copy <kbd>{shortcutText("copy")}</kbd>
          </button>
        )}
        <button type="button" {...action("focus")}>
          Frame <kbd>{shortcutText("focus")}</kbd>
        </button>
        <button type="button" className="selection-delete" {...action("delete")}>
          Delete
        </button>
      </div>
    </section>
  );
}

function SelectionRollingBands({ editor, snapshot }: PanelProps) {
  const { selection } = snapshot;
  if (!selection || selection.members.length !== 1 || selection.primary.kind === "track") {
    return null;
  }
  const { item } = selection.primary;
  return (
    <section className="stats-section" aria-label="Selection rolling bands">
      <h3>Rolling bands of {itemLabel(snapshot, item)}</h3>
      <RollingDiagnostics key={item} editor={editor} item={item} />
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
        : `snapped beside a sidewalk, ${snap.metCells} edge cells meet`;
    case "free":
      if (snap.joinedCells > 0) return `exact here, ${snap.joinedCells} edge cells join`;
      return snap.metCells > 0
        ? `exact here, ${snap.metCells} edge cells meet`
        : "free, touches no road";
    case "refused":
      return `click refused: ${snap.overlappingCells} road cells would lie in placed road at the same height`;
    case "mismatched":
      return `${snap.mismatchedCells} edge cells would mismatch; the plan reports them`;
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

function splitText(sample: LatencySample | null): string {
  if (!sample) return "none yet";
  return `${sample.rebuildMs.toFixed(1)} ms rebuild, ${sample.queueMs.toFixed(1)} ms to the frame, ${sample.submitMs.toFixed(1)} ms submit, ${sample.gpuWaitMs.toFixed(1)} ms GPU wait`;
}

export function EditorHud({
  editor,
  snapshot,
  panels,
  plans,
}: PanelProps & { readonly panels: IPanelLayout; readonly plans: IPlanService }) {
  const [open, setOpen] = useState(() => !isCompactLayout() && panels.snapshot().stats);
  const plan = useActivePlan(plans);
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
    ["Plan origin (chunks)", plan ? `${plan.originChunkX}, ${plan.originChunkZ}` : "no plan"],
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
    ["Last edit split", splitText(snapshot.lastLatency)],
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
      <section className="stats-section" aria-label="Go to">
        <h3>Go to a lattice point</h3>
        <GoTo editor={editor} />
      </section>
      <SelectionRollingBands editor={editor} snapshot={snapshot} />
      <TrackPanel snapshot={snapshot} />
      <RoadJoins editor={editor} snapshot={snapshot} />
    </details>
  );
}

const MOUSE_HINT =
  "Right-drag orbits (pans in the 2D plan). Middle, Space or Shift-drag pans. Pinch or the wheel zooms at the cursor. Arrows nudge selected models and track pieces one stud, otherwise pan; Shift-arrows orbit. Double-click selects a track run (Shift: all joined track).";

export function EditorFooter({ disclaimer }: { readonly disclaimer: string }) {
  return (
    <footer className="editor-footer">
      <p className="status-hint" title={MOUSE_HINT}>
        {MOUSE_HINT}
      </p>
      <p className="status-legal">
        {disclaimer} <CreditLinks />
      </p>
    </footer>
  );
}
