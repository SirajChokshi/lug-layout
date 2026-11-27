import {
  DEFAULT_TABLE_HEIGHT_MM,
  type IEditor,
  type ITableLibrary,
  type TableType,
  type TableTypeInput,
  type TableTypeUsage,
} from "@brr/client";
import { useState } from "react";
import { MmField } from "./commit-input.tsx";

const NEW_TYPE_COLOR = "#b58b5a";
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  widthMm: "Width",
  depthMm: "Depth",
  heightMm: "Height",
  color: "Colour",
  owned: "Owned",
};

interface ShownIssue {
  readonly path: string;
  readonly message: string;
}

interface TypeDraft {
  readonly name: string;
  readonly widthMm: string;
  readonly depthMm: string;
  readonly heightMm: string;
  readonly color: string;
  readonly owned: string;
}

const EMPTY_DRAFT: TypeDraft = {
  name: "",
  widthMm: "",
  depthMm: "",
  heightMm: String(DEFAULT_TABLE_HEIGHT_MM),
  color: NEW_TYPE_COLOR,
  owned: "1",
};

function issuesText(issues: ReadonlyArray<ShownIssue>): string {
  return issues
    .map(
      (issue) =>
        `${FIELD_LABELS[issue.path.split(".").at(-1) ?? ""] ?? "The library"} ${issue.message}`,
    )
    .join("; ");
}

function draftNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

function draftInput(draft: TypeDraft): TableTypeInput {
  return {
    name: draft.name,
    widthMm: draftNumber(draft.widthMm),
    depthMm: draftNumber(draft.depthMm),
    heightMm: draftNumber(draft.heightMm),
    color: draft.color,
    owned: draftNumber(draft.owned),
  };
}

function placedText({ placed, short, type }: TableTypeUsage): string {
  if (short > 0) return `${placed} placed, ${short} more than the ${type.owned} owned`;
  return `${placed} of ${type.owned} owned placed in this plan`;
}

function NameField({
  name,
  value,
  onCommit,
}: {
  readonly name: string;
  readonly value: string;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className="table-type-name"
      type="text"
      name={name}
      aria-label="Table type name"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

function ColorField({
  name,
  value,
  onCommit,
}: {
  readonly name: string;
  readonly value: string;
  readonly onCommit: (color: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  return (
    <label className="mm-field">
      <span>Colour</span>
      <input
        type="color"
        name={name}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
      />
    </label>
  );
}

function TableTypeRow({
  row,
  armed,
  editor,
  library,
  onIssues,
}: {
  readonly row: TableTypeUsage;
  readonly armed: boolean;
  readonly editor: IEditor;
  readonly library: ITableLibrary;
  readonly onIssues: (issues: ReadonlyArray<ShownIssue>) => void;
}) {
  const { type, placed, short } = row;
  const update = (patch: Partial<TableTypeInput>): void => {
    onIssues(library.updateType(type.id, patch));
  };
  const field = (key: keyof TableType): string => `table-type-${type.id}-${key}`;
  return (
    <li className="table-type" data-table-type={type.id}>
      <div className="plan-item-head">
        <span className="table-swatch" style={{ background: type.color }} aria-hidden="true" />
        <NameField name={field("name")} value={type.name} onCommit={(name) => update({ name })} />
        <button
          type="button"
          data-action="place-table-type"
          aria-pressed={armed}
          title="Place tables of this type: click on the canvas, R turns them 90°, Esc puts it down"
          onClick={() => editor.armTableType(armed ? null : type.id)}
        >
          {armed ? "Placing (Esc)" : "Place"}
        </button>
      </div>
      <div className="plan-grid">
        <MmField
          name={field("widthMm")}
          label="Width mm"
          value={type.widthMm}
          onCommit={(widthMm) => update({ widthMm })}
        />
        <MmField
          name={field("depthMm")}
          label="Depth mm"
          value={type.depthMm}
          onCommit={(depthMm) => update({ depthMm })}
        />
        <MmField
          name={field("heightMm")}
          label="Height mm"
          value={type.heightMm}
          onCommit={(heightMm) => update({ heightMm })}
        />
        <MmField
          name={field("owned")}
          label="Owned"
          value={type.owned}
          onCommit={(owned) => update({ owned })}
        />
        <ColorField
          name={field("color")}
          value={type.color}
          onCommit={(color) => update({ color })}
        />
      </div>
      <div className="plan-item-head">
        <span
          className={short > 0 ? "plan-warnings" : "plan-meta"}
          data-placed={placed}
          data-short={short}
        >
          {placedText(row)}
        </span>
        <button
          type="button"
          data-action="remove-table-type"
          title="Remove this type; its placed tables stay, at their size, as plain tables"
          onClick={() => library.removeType(type.id)}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function NewTableType({
  library,
  onIssues,
}: {
  readonly library: ITableLibrary;
  readonly onIssues: (issues: ReadonlyArray<ShownIssue>) => void;
}) {
  const [draft, setDraft] = useState<TypeDraft>(EMPTY_DRAFT);
  const input = (key: keyof TypeDraft, label: string) => (
    <label className="mm-field">
      <span>{label}</span>
      <input
        type={key === "name" ? "text" : key === "color" ? "color" : "number"}
        name={`new-table-type-${key}`}
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <div className="table-type-new" aria-label="New table type">
      {input("name", "Name")}
      {input("widthMm", "Width mm")}
      {input("depthMm", "Depth mm")}
      {input("heightMm", "Height mm")}
      {input("owned", "Owned")}
      {input("color", "Colour")}
      <button
        type="button"
        data-action="add-table-type"
        onClick={() => {
          const added = library.addType(draftInput(draft));
          onIssues(added.ok ? [] : added.issues);
          if (added.ok) setDraft(EMPTY_DRAFT);
        }}
      >
        Add table type
      </button>
    </div>
  );
}

export function TableLibrarySection({
  editor,
  library,
  planId,
  armedType,
}: {
  readonly editor: IEditor;
  readonly library: ITableLibrary;
  readonly planId: string | null;
  readonly armedType: number | null;
}) {
  const [issues, setIssues] = useState<ReadonlyArray<ShownIssue>>([]);
  const usage = library.usage(planId);
  return (
    <section className="plan-section" aria-label="Table library">
      <h3>Table library</h3>
      <p className="plan-meta">
        The tables your club owns. A placed table keeps its type&apos;s size and height, lands with
        its back-left corner on the 8-stud grid and turns in quarter turns.
      </p>
      {usage.length === 0 ? (
        <p className="plan-meta">No table types yet.</p>
      ) : (
        <ul className="table-types">
          {usage.map((row) => (
            <TableTypeRow
              key={row.type.id}
              row={row}
              armed={armedType === row.type.id}
              editor={editor}
              library={library}
              onIssues={setIssues}
            />
          ))}
        </ul>
      )}
      <NewTableType library={library} onIssues={setIssues} />
      {issues.length > 0 && (
        <p className="plan-errors" role="alert" data-table-type-issues>
          {issuesText(issues)}
        </p>
      )}
    </section>
  );
}
