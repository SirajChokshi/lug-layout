import {
  NOTE_TOOL_KINDS,
  STUD_LDU,
  type EditorSnapshot,
  type IEditor,
  type INoteEditSession,
  type NoteRecordV2,
  type NoteStyle,
  type NoteToolKind,
  type NoteToolView,
  type RulerEndView,
  type RulerNoteV2,
  type SelectedNoteView,
  type TextNoteV2,
  type ZoneNoteV2,
} from "@brr/client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FirstChord } from "./keys.tsx";

const QUARTER_TURNS = [0, 1, 2, 3] as const;
const DEGREES_PER_QUARTER_TURN = 90;
const TEXT_HEIGHT_MIN_STUDS = 1;
const TEXT_HEIGHT_MAX_STUDS = 256;
const SWATCHES: ReadonlyArray<string> = [
  "#d9822b",
  "#c62828",
  "#f2c230",
  "#3c9a5f",
  "#2f74e8",
  "#8e44ad",
  "#7f8c8d",
  "#16222c",
];

const TOOL_NAMES: Readonly<Record<NoteToolKind, string>> = {
  zone: "Zone",
  text: "Label",
  ruler: "Ruler",
};

const TOOL_COMMANDS = {
  zone: "zone-tool",
  text: "label-tool",
  ruler: "ruler-tool",
} as const;

function styleColor(style: NoteStyle, tool: NoteToolKind): string {
  switch (tool) {
    case "zone":
      return style.zoneColor;
    case "text":
      return style.textColor;
    case "ruler":
      return style.rulerColor;
    default: {
      const unhandled: never = tool;
      throw new Error(`unhandled note tool ${String(unhandled)}`);
    }
  }
}

function colorStyle(tool: NoteToolKind, color: string): Partial<NoteStyle> {
  switch (tool) {
    case "zone":
      return { zoneColor: color };
    case "text":
      return { textColor: color };
    case "ruler":
      return { rulerColor: color };
    default: {
      const unhandled: never = tool;
      throw new Error(`unhandled note tool ${String(unhandled)}`);
    }
  }
}

type NoteBodyOf<Note> = Omit<Note, "index">;

function bodyOf<Note extends NoteRecordV2>(note: Note): NoteBodyOf<Note> {
  const { index: _index, ...body } = note;
  return body;
}

function studsText(ldu: number): string {
  return String(Math.round((ldu / STUD_LDU) * 10) / 10);
}

function endText(end: RulerEndView): string {
  const at = `${studsText(end.x)}, ${studsText(end.z)} studs`;
  return end.model === null ? `free, at ${at}` : `on ${end.model}, at ${at}`;
}

function commitOnEnter(event: KeyboardEvent<HTMLInputElement>, revert: () => void): void {
  if (event.key === "Enter") event.currentTarget.blur();
  if (event.key === "Escape") {
    revert();
    event.currentTarget.blur();
  }
}

interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly focus: boolean;
  readonly onCommit: (value: string) => void;
}

function TextField({ label, value, focus, onCommit }: TextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focus) return;
    input.current?.focus();
    input.current?.select();
  }, [focus]);
  return (
    <label className="selection-field note-field-wide">
      <span className="selection-field-label">{label}</span>
      <input
        ref={input}
        type="text"
        value={draft ?? value}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft);
          setDraft(null);
        }}
        onKeyDown={(event) => commitOnEnter(event, () => setDraft(value))}
      />
    </label>
  );
}

interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}

function NumberField({ label, value, min, max, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="selection-field">
      <span className="selection-field-label">{label}</span>
      <input
        type="number"
        step={1}
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          const typed = draft === null ? value : Number(draft);
          setDraft(null);
          if (Number.isSafeInteger(typed) && typed >= min && typed <= max && typed !== value) {
            onCommit(typed);
          }
        }}
        onKeyDown={(event) => commitOnEnter(event, () => setDraft(null))}
      />
    </label>
  );
}

interface ColorFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (color: string) => void;
}

function ColorField({ label, value, onCommit }: ColorFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(onCommit);
  useEffect(() => {
    latest.current = onCommit;
  });
  useEffect(() => {
    if (input.current) input.current.value = value;
  }, [value]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const changed = (): void => latest.current(element.value.toLowerCase());
    element.addEventListener("change", changed);
    return () => element.removeEventListener("change", changed);
  }, []);
  return (
    <div className="note-colors" role="group" aria-label={label}>
      <span className="selection-field-label">{label}</span>
      <div className="note-swatches">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="note-swatch"
            style={{ background: swatch }}
            aria-label={swatch}
            aria-pressed={swatch === value}
            onClick={() => onCommit(swatch)}
          />
        ))}
        <input
          ref={input}
          type="color"
          className="note-color-input"
          aria-label={`${label}, any colour`}
          defaultValue={value}
        />
      </div>
    </div>
  );
}

interface OwnerFieldProps {
  readonly view: NoteToolView;
  readonly value: number | null;
  readonly onCommit: (owner: number | null) => void;
}

function OwnerField({ view, value, onCommit }: OwnerFieldProps) {
  if (view.owners.length === 0) return null;
  return (
    <label className="selection-field note-field-wide">
      <span className="selection-field-label">Contributor</span>
      <select
        value={value === null ? "" : String(value)}
        onChange={(event) => {
          const chosen = event.currentTarget.value;
          onCommit(chosen === "" ? null : Number(chosen));
        }}
      >
        <option value="">Nobody</option>
        {view.owners.map((owner) => (
          <option key={owner.id} value={owner.id}>
            {owner.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function withOwner<Body extends { readonly owner?: number }>(body: Body, owner: number | null) {
  const { owner: _owner, ...rest } = body;
  return owner === null ? rest : { ...rest, owner };
}

interface SelectedProps<Note> {
  readonly notes: INoteEditSession;
  readonly view: NoteToolView;
  readonly selected: SelectedNoteView;
  readonly note: Note;
}

function ZoneFields({ notes, view, selected, note }: SelectedProps<ZoneNoteV2>) {
  const body = bodyOf(note);
  return (
    <>
      <TextField
        key={`${selected.id}-name`}
        label="Name"
        value={note.name}
        focus={false}
        onCommit={(name) => notes.updateSelected({ ...body, name })}
      />
      <p className="selection-meta">{note.outline.length} corners on whole studs</p>
      <ColorField
        label="Colour"
        value={note.color}
        onCommit={(color) => notes.updateSelected({ ...body, color })}
      />
      <OwnerField
        view={view}
        value={note.owner ?? null}
        onCommit={(owner) => notes.updateSelected(withOwner(body, owner))}
      />
    </>
  );
}

function TextFields({ notes, view, selected, note }: SelectedProps<TextNoteV2>) {
  const body = bodyOf(note);
  return (
    <>
      <TextField
        key={`${selected.id}-text`}
        label="Text"
        value={note.text}
        focus={selected.fresh}
        onCommit={(text) => notes.updateSelected({ ...body, text })}
      />
      <div className="selection-fields">
        <NumberField
          label="Height, studs"
          value={note.heightStuds}
          min={TEXT_HEIGHT_MIN_STUDS}
          max={TEXT_HEIGHT_MAX_STUDS}
          onCommit={(heightStuds) => notes.updateSelected({ ...body, heightStuds })}
        />
      </div>
      <span className="selection-field-label" aria-hidden="true">
        Rotation
      </span>
      <div className="selection-segment" role="group" aria-label="Rotation">
        {QUARTER_TURNS.map((rot) => (
          <button
            key={rot}
            type="button"
            aria-pressed={note.rot === rot}
            onClick={() => notes.updateSelected({ ...body, rot })}
          >
            {rot * DEGREES_PER_QUARTER_TURN}°
          </button>
        ))}
      </div>
      <ColorField
        label="Colour"
        value={note.color}
        onCommit={(color) => notes.updateSelected({ ...body, color })}
      />
      <OwnerField
        view={view}
        value={note.owner ?? null}
        onCommit={(owner) => notes.updateSelected(withOwner(body, owner))}
      />
    </>
  );
}

function RulerFields({ notes, view, selected, note }: SelectedProps<RulerNoteV2>) {
  const body = bodyOf(note);
  return (
    <>
      <dl className="note-ruler-ends">
        <div>
          <dt>Length</dt>
          <dd data-note="length">{selected.length}</dd>
        </div>
        <div>
          <dt>From</dt>
          <dd data-note="from">{selected.ends ? endText(selected.ends.from) : ""}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd data-note="to">{selected.ends ? endText(selected.ends.to) : ""}</dd>
        </div>
      </dl>
      <ColorField
        label="Colour"
        value={note.color}
        onCommit={(color) => notes.updateSelected({ ...body, color })}
      />
      <OwnerField
        view={view}
        value={note.owner ?? null}
        onCommit={(owner) => notes.updateSelected(withOwner(body, owner))}
      />
    </>
  );
}

function SelectedFields({ notes, view, selected }: Omit<SelectedProps<NoteRecordV2>, "note">) {
  const { note } = selected;
  switch (note.kind) {
    case "zone":
      return <ZoneFields notes={notes} view={view} selected={selected} note={note} />;
    case "text":
      return <TextFields notes={notes} view={view} selected={selected} note={note} />;
    case "ruler":
      return <RulerFields notes={notes} view={view} selected={selected} note={note} />;
    case "legend":
      return null;
    default: {
      const unhandled: never = note;
      throw new Error(`unhandled note ${String(unhandled)}`);
    }
  }
}

const SELECTED_TITLES: Readonly<Record<NoteRecordV2["kind"], string>> = {
  zone: "Zone",
  text: "Label",
  ruler: "Ruler",
  legend: "Legend",
};

function NewNoteFields({
  notes,
  view,
}: {
  readonly notes: INoteEditSession;
  readonly view: NoteToolView;
}) {
  return (
    <>
      <ColorField
        label={`New ${TOOL_NAMES[view.tool].toLowerCase()} colour`}
        value={styleColor(view.style, view.tool)}
        onCommit={(color) => notes.setStyle(colorStyle(view.tool, color))}
      />
      {view.tool === "text" && (
        <div className="selection-fields">
          <NumberField
            label="New label height, studs"
            value={view.style.textHeightStuds}
            min={TEXT_HEIGHT_MIN_STUDS}
            max={TEXT_HEIGHT_MAX_STUDS}
            onCommit={(textHeightStuds) => notes.setStyle({ textHeightStuds })}
          />
        </div>
      )}
      <OwnerField
        view={view}
        value={view.style.owner}
        onCommit={(owner) => notes.setStyle({ owner })}
      />
    </>
  );
}

function LayerField({
  notes,
  view,
}: {
  readonly notes: INoteEditSession;
  readonly view: NoteToolView;
}) {
  if (view.layers.length === 0) return null;
  return (
    <label className="selection-field note-field-wide">
      <span className="selection-field-label">Notes layer</span>
      <select
        value={view.layer === null ? "" : String(view.layer)}
        onChange={(event) => notes.setLayer(Number(event.currentTarget.value))}
      >
        {view.layer === null && <option value="">None open</option>}
        {view.layers.map((layer) => (
          <option key={layer.id} value={layer.id} disabled={!layer.visible || layer.locked}>
            {layer.name}
            {layer.visible ? "" : " (hidden)"}
            {layer.locked ? " (locked)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

interface NotePanelProps {
  readonly editor: IEditor;
  readonly notes: INoteEditSession;
  readonly snapshot: EditorSnapshot;
}

export function NotePanel({ editor, notes, snapshot }: NotePanelProps) {
  const view = snapshot.noteTool;
  if (!view) return null;
  const { selected } = view;
  return (
    <section
      className="inspector selection-panel note-panel"
      aria-label="Notes"
      data-note-tool={view.tool}
      data-note-selected={selected?.id ?? ""}
      data-note-draft={view.draft ?? ""}
    >
      <h2>Notes</h2>
      <div className="selection-segment" role="group" aria-label="Note tool">
        {NOTE_TOOL_KINDS.map((tool) => (
          <button
            key={tool}
            type="button"
            data-action={TOOL_COMMANDS[tool]}
            aria-pressed={view.tool === tool}
            onClick={() => editor.setNoteTool(tool)}
          >
            {TOOL_NAMES[tool]} <FirstChord id={TOOL_COMMANDS[tool]} />
          </button>
        ))}
      </div>
      <LayerField notes={notes} view={view} />
      {view.refusal !== null && (
        <p className="note-refusal" role="alert">
          {view.refusal}
        </p>
      )}
      {selected ? (
        <div className="note-selected" data-note-kind={selected.note.kind}>
          <p className="selection-name">{SELECTED_TITLES[selected.note.kind]}</p>
          <SelectedFields notes={notes} view={view} selected={selected} />
          <div className="selection-actions">
            <button type="button" onClick={() => notes.select(null)}>
              Deselect
            </button>
            <button
              type="button"
              className="selection-delete"
              data-action="delete-note"
              onClick={(event) => editor.deleteSelection(event.timeStamp)}
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <NewNoteFields notes={notes} view={view} />
      )}
    </section>
  );
}
