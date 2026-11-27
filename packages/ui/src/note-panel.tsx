import {
  STUD_LDU,
  type EditorSnapshot,
  type IEditor,
  type INoteEditSession,
  type NoteToolView,
  type RulerEndView,
  type SelectedNoteView,
} from "@brr/client";
import type { NoteRecordV2 } from "@brr/schema/world";
import { useEffect, useRef, useState } from "react";
import { StudField } from "./editor-panels.tsx";

const QUARTER_TURNS = [0, 1, 2, 3] as const;
const DEGREES_PER_QUARTER_TURN = 90;

const TITLES: Readonly<Record<NoteRecordV2["kind"], string>> = {
  zone: "Zone",
  text: "Label",
  ruler: "Ruler",
  legend: "Legend",
};

function endText({ x, z, model }: RulerEndView): string {
  const at = `${x / STUD_LDU}, ${z / STUD_LDU} studs`;
  return model === null ? `free, at ${at}` : `on ${model}, at ${at}`;
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
    <label className="selection-field">
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
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(value);
          if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

interface ColorFieldProps {
  readonly value: string;
  readonly onCommit: (color: string) => void;
}

function ColorField({ value, onCommit }: ColorFieldProps) {
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
    <label className="selection-field">
      <span className="selection-field-label">Colour</span>
      <input ref={input} type="color" defaultValue={value} />
    </label>
  );
}

interface SelectedFieldsProps {
  readonly notes: INoteEditSession;
  readonly selected: SelectedNoteView;
}

function SelectedFields({ notes, selected }: SelectedFieldsProps) {
  const { id, note } = selected;
  switch (note.kind) {
    case "zone": {
      const { index: _index, ...zone } = note;
      return (
        <>
          <TextField
            key={id}
            label="Name"
            value={zone.name}
            focus={false}
            onCommit={(name) => notes.updateSelected({ ...zone, name })}
          />
          <div className="selection-fields">
            <ColorField
              value={zone.color}
              onCommit={(color) => notes.updateSelected({ ...zone, color })}
            />
          </div>
        </>
      );
    }
    case "text": {
      const { index: _index, ...text } = note;
      return (
        <>
          <TextField
            key={id}
            label="Text"
            value={text.text}
            focus={selected.fresh}
            onCommit={(value) => notes.updateSelected({ ...text, text: value })}
          />
          <div className="selection-fields">
            <StudField
              label="Height, studs"
              value={text.heightStuds}
              owner={id}
              disabled={false}
              onCommit={(heightStuds) => notes.updateSelected({ ...text, heightStuds })}
            />
            <ColorField
              value={text.color}
              onCommit={(color) => notes.updateSelected({ ...text, color })}
            />
          </div>
          <div className="selection-segment" role="group" aria-label="Rotation">
            {QUARTER_TURNS.map((rot) => (
              <button
                key={rot}
                type="button"
                aria-pressed={text.rot === rot}
                onClick={() => notes.updateSelected({ ...text, rot })}
              >
                {rot * DEGREES_PER_QUARTER_TURN}°
              </button>
            ))}
          </div>
        </>
      );
    }
    case "ruler": {
      const { index: _index, ...ruler } = note;
      return (
        <>
          <dl>
            <div>
              <dt>Length</dt>
              <dd>{selected.length}</dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>{selected.ends && endText(selected.ends.from)}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{selected.ends && endText(selected.ends.to)}</dd>
            </div>
          </dl>
          <div className="selection-fields">
            <ColorField
              value={ruler.color}
              onCommit={(color) => notes.updateSelected({ ...ruler, color })}
            />
          </div>
        </>
      );
    }
    case "legend":
      return null;
    default: {
      const unhandled: never = note;
      throw new Error(`unhandled note ${String(unhandled)}`);
    }
  }
}

interface NewNoteFieldsProps {
  readonly notes: INoteEditSession;
  readonly view: NoteToolView;
}

function NewNoteFields({ notes, view }: NewNoteFieldsProps) {
  const { style, tool } = view;
  return (
    <div className="selection-fields">
      {tool === "zone" && (
        <ColorField
          value={style.zoneColor}
          onCommit={(zoneColor) => notes.setStyle({ zoneColor })}
        />
      )}
      {tool === "text" && (
        <>
          <ColorField
            value={style.textColor}
            onCommit={(textColor) => notes.setStyle({ textColor })}
          />
          <StudField
            label="Height, studs"
            value={style.textHeightStuds}
            owner="new-label"
            disabled={false}
            onCommit={(textHeightStuds) => notes.setStyle({ textHeightStuds })}
          />
        </>
      )}
      {tool === "ruler" && (
        <ColorField
          value={style.rulerColor}
          onCommit={(rulerColor) => notes.setStyle({ rulerColor })}
        />
      )}
    </div>
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
  const title = selected ? TITLES[selected.note.kind] : `New ${TITLES[view.tool].toLowerCase()}`;
  return (
    <section
      className="inspector selection-panel note-panel"
      aria-label="Notes"
      data-note-tool={view.tool}
    >
      <h2>{title}</h2>
      {view.layers.length > 1 && (
        <label className="selection-field">
          <span className="selection-field-label">Notes layer</span>
          <select
            value={view.layer ?? ""}
            onChange={(event) => notes.setLayer(Number(event.currentTarget.value))}
          >
            {view.layers.map((layer) => (
              <option key={layer.id} value={layer.id} disabled={!layer.visible || layer.locked}>
                {layer.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {view.refusal !== null && <p role="alert">{view.refusal}</p>}
      {selected ? (
        <>
          <SelectedFields notes={notes} selected={selected} />
          <div className="selection-actions">
            <button
              type="button"
              className="selection-delete"
              onClick={(event) => editor.deleteSelection(event.timeStamp)}
            >
              Delete
            </button>
          </div>
        </>
      ) : (
        <NewNoteFields notes={notes} view={view} />
      )}
    </section>
  );
}
