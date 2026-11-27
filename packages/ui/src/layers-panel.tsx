import {
  BASE_LAYER_ID,
  OPACITY_PERCENT_MAX,
  layerTallyText,
  type IEditor,
  type ILayerService,
  type LayerTally,
  type SelectionItemView,
} from "@brr/client";
import type { Issue } from "@brr/schema/decode";
import type { LayerRecordV2 } from "@brr/schema/world";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useLayers } from "./use-layers.ts";

const NOTHING: LayerTally = { models: 0, pieces: 0 };
const WHOLE_PERCENT = /^\s*\d+\s*$/u;

function refusalText(subject: string, issues: ReadonlyArray<Issue>): string | null {
  if (issues.length === 0) return null;
  return `${subject} ${issues.map((issue) => issue.message).join("; ")}.`;
}

function totalOf(tally: LayerTally): number {
  return tally.models + tally.pieces;
}

function nextLayerName(layers: ReadonlyArray<LayerRecordV2>): string {
  const taken = new Set(layers.map((layer) => layer.name));
  let n = layers.length;
  while (taken.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

function EyeIcon({ open }: { readonly open: boolean }) {
  return (
    <svg className="layer-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 8C3 5 5.3 3.5 8 3.5S13 5 14.5 8C13 11 10.7 12.5 8 12.5S3 11 1.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {!open && <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

function LockIcon({ closed }: { readonly closed: boolean }) {
  return (
    <svg className="layer-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
      <path
        d={closed ? "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M5.5 7V5a2.5 2.5 0 0 1 5 0"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function RenameField({
  name,
  onCommit,
  onCancel,
}: {
  readonly name: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (commit && draft.trim() !== "" && draft.trim() !== name) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      ref={input}
      className="layer-rename"
      aria-label={`Rename layer "${name}"`}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
    />
  );
}

function OpacityField({
  layer,
  onCommit,
}: {
  readonly layer: LayerRecordV2;
  readonly onCommit: (percent: number) => void;
}) {
  const shown = String(layer.opacity);
  const [draft, setDraft] = useState<{ readonly layer: number; readonly text: string } | null>(
    null,
  );
  const typed = draft?.layer === layer.id ? draft.text : null;
  const commit = (): void => {
    setDraft(null);
    if (typed === null || typed === shown || !WHOLE_PERCENT.test(typed)) return;
    onCommit(Number(typed));
  };
  return (
    <label className="layer-opacity" title="The layer's opacity, saved with the world">
      <span>Opacity</span>
      <input
        type="number"
        min={0}
        max={OPACITY_PERCENT_MAX}
        step={1}
        value={typed ?? shown}
        onChange={(event) => setDraft({ layer: layer.id, text: event.currentTarget.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
      />
      <span aria-hidden="true">%</span>
    </label>
  );
}

interface LayerRowProps {
  readonly layer: LayerRecordV2;
  readonly tally: LayerTally;
  readonly active: boolean;
  readonly current: boolean;
  readonly renaming: boolean;
  readonly onPick: () => void;
  readonly onRename: () => void;
  readonly onRenamed: (name: string) => void;
  readonly onRenameCancelled: () => void;
  readonly onVisible: (visible: boolean) => void;
  readonly onLocked: (locked: boolean) => void;
}

function rowTitle(layer: LayerRecordV2, active: boolean): string {
  if (layer.kind !== "parts") {
    return `A ${layer.kind} layer: parts go on a parts layer. Double-click or F2 to rename.`;
  }
  return active
    ? "New parts go on this layer. Double-click or F2 to rename."
    : "Click to put new parts on this layer. Double-click or F2 to rename.";
}

function LayerRow({
  layer,
  tally,
  active,
  current,
  renaming,
  onPick,
  onRename,
  onRenamed,
  onRenameCancelled,
  onVisible,
  onLocked,
}: LayerRowProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "F2") return;
    event.preventDefault();
    onRename();
  };
  return (
    <li
      className="layer-row"
      data-layer={layer.id}
      data-active={active ? "" : undefined}
      data-current={current ? "" : undefined}
      data-hidden={layer.visible ? undefined : ""}
      data-locked={layer.locked ? "" : undefined}
    >
      <button
        type="button"
        className="layer-toggle layer-eye"
        aria-label={`Show "${layer.name}"`}
        aria-pressed={layer.visible}
        title={layer.visible ? "Shown: click to hide" : "Hidden: click to show"}
        onClick={() => onVisible(!layer.visible)}
      >
        <EyeIcon open={layer.visible} />
      </button>
      <button
        type="button"
        className="layer-toggle layer-lock"
        aria-label={`Lock "${layer.name}"`}
        aria-pressed={layer.locked}
        title={layer.locked ? "Locked: click to unlock" : "Unlocked: click to lock"}
        onClick={() => onLocked(!layer.locked)}
      >
        <LockIcon closed={layer.locked} />
      </button>
      {renaming ? (
        <RenameField name={layer.name} onCommit={onRenamed} onCancel={onRenameCancelled} />
      ) : (
        <button
          type="button"
          className="layer-name"
          aria-current={active ? "true" : undefined}
          title={rowTitle(layer, active)}
          onClick={onPick}
          onDoubleClick={onRename}
          onKeyDown={onKeyDown}
        >
          <span className="layer-name-text">{layer.name}</span>
          {layer.kind !== "parts" && <span className="layer-kind">{layer.kind}</span>}
        </button>
      )}
      <span className="layer-count" title={`${layerTallyText(tally)} on this layer`}>
        {totalOf(tally)}
      </span>
    </li>
  );
}

function removeTitle(layer: LayerRecordV2): string {
  if (layer.id === BASE_LAYER_ID) return "Every world keeps its base layer";
  if (layer.locked) return "Unlock this layer to remove it";
  return "Remove this layer once nothing is on it";
}

function optionText(layer: LayerRecordV2): string {
  if (layer.locked) return `${layer.name} (locked)`;
  return layer.visible ? layer.name : `${layer.name} (hidden)`;
}

export function MoveToLayerField({
  editor,
  layers,
  members,
  enabled,
}: {
  readonly editor: IEditor;
  readonly layers: ILayerService;
  readonly members: ReadonlyArray<SelectionItemView>;
  readonly enabled: boolean;
}) {
  const { table } = useLayers(layers);
  const held = [
    ...new Set(members.flatMap((member) => (member.kind === "train" ? [] : [member.layer]))),
  ];
  const [only] = held;
  const shared = held.length === 1 ? only : undefined;
  return (
    <label className="selection-field selection-layer" title="Move the selection to another layer">
      <span className="selection-field-label">Layer</span>
      <select
        value={shared === undefined ? "" : String(shared)}
        disabled={!enabled}
        onChange={(event) =>
          editor.moveSelectionToLayer(Number(event.currentTarget.value), event.timeStamp)
        }
      >
        {shared === undefined && (
          <option value="" disabled>
            {held.length} layers
          </option>
        )}
        {table.layers
          .toReversed()
          .filter((layer) => layer.kind === "parts")
          .map((layer) => (
            <option key={layer.id} value={layer.id} disabled={layer.locked}>
              {optionText(layer)}
            </option>
          ))}
      </select>
    </label>
  );
}

export function LayersPanel({
  editor,
  layers,
  contents,
}: {
  readonly editor: IEditor;
  readonly layers: ILayerService;
  readonly contents: ReadonlyMap<number, LayerTally>;
}) {
  const { table, active } = useLayers(layers);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const current = picked !== null && table.layer(picked) ? picked : active;
  const currentLayer = table.layer(current);
  const activeLayer = table.layer(active);
  const position = table.layers.findIndex((layer) => layer.id === current);
  const top = table.layers.length - 1;
  const report = (subject: string, issues: ReadonlyArray<Issue>): boolean => {
    setRefusal(refusalText(subject, issues));
    return issues.length === 0;
  };
  const pick = (layer: LayerRecordV2): void => {
    if (layer.kind !== "parts") {
      setPicked(layer.id);
      setRefusal(null);
      return;
    }
    setPicked(null);
    report(`"${layer.name}"`, layers.setActiveLayer(layer.id));
  };
  const create = (): void => {
    const created = layers.create(nextLayerName(table.layers), "parts");
    if (!created.ok) {
      report("A new layer", created.issues);
      return;
    }
    setRefusal(null);
    setPicked(null);
    setRenaming(created.value);
  };
  const reorder = (to: number): void => {
    if (currentLayer) report(`"${currentLayer.name}"`, layers.move(current, to));
  };
  const remove = (): void => {
    if (!currentLayer) return;
    if (report(`"${currentLayer.name}"`, layers.remove(current))) setPicked(null);
  };
  return (
    <details
      className="layers-panel"
      aria-label="Layers"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={open ? "Fold the layers away" : "Show, hide, lock and order the layers"}>
        <h2>Layers</h2>
        <span className="layers-glance">
          {activeLayer?.name ?? ""} · {table.layers.length}
        </span>
      </summary>
      <ul className="layer-list" aria-label="Layers, top first">
        {table.layers.toReversed().map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            tally={contents.get(layer.id) ?? NOTHING}
            active={layer.id === active}
            current={layer.id === current}
            renaming={renaming === layer.id}
            onPick={() => pick(layer)}
            onRename={() => setRenaming(layer.id)}
            onRenamed={(name) => {
              setRenaming(null);
              report("The name", layers.rename(layer.id, name));
            }}
            onRenameCancelled={() => setRenaming(null)}
            onVisible={(visible) => report(`"${layer.name}"`, layers.setVisible(layer.id, visible))}
            onLocked={(locked) => report(`"${layer.name}"`, layers.setLocked(layer.id, locked))}
          />
        ))}
      </ul>
      {currentLayer && (
        <div className="layer-actions" role="group" aria-label={`Layer "${currentLayer.name}"`}>
          <OpacityField
            layer={currentLayer}
            onCommit={(percent) => report("Opacity", layers.setOpacity(current, percent))}
          />
          <button
            type="button"
            aria-label="Move layer up"
            title="Move up: drawn above the layer over it"
            disabled={position >= top}
            onClick={() => reorder(position + 1)}
          >
            ▲
          </button>
          <button
            type="button"
            aria-label="Move layer down"
            title="Move down: drawn below the layer under it"
            disabled={position <= 0}
            onClick={() => reorder(position - 1)}
          >
            ▼
          </button>
          <button
            type="button"
            title="Select every model and track piece on this layer"
            onClick={() => editor.selectLayer(current)}
          >
            Select all
          </button>
          <button
            type="button"
            className="layer-remove"
            title={removeTitle(currentLayer)}
            disabled={currentLayer.id === BASE_LAYER_ID || currentLayer.locked}
            onClick={remove}
          >
            Remove
          </button>
        </div>
      )}
      <div className="layer-footer">
        <button type="button" data-action="new-layer" onClick={create}>
          New layer
        </button>
        <p className="layer-note">
          Hidden layers are skipped by clicks and box selection; the 3D view still draws every
          layer.
        </p>
      </div>
      {refusal !== null && (
        <p className="layer-refusal" role="alert">
          {refusal}
        </p>
      )}
    </details>
  );
}
