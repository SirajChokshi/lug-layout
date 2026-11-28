import {
  NO_OWNER,
  counted,
  inventoryParts,
  tagTallyText,
  type Contributor,
  type IContributorService,
  type IEditor,
  type OwnedPartsRead,
  type Roster,
  type SelectionItemView,
  type TagTally,
} from "@brr/client";
import type { Issue } from "@brr/schema/decode";
import type { ContributorRecordV2 } from "@brr/schema/world";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { RenameField, freeName, refusalText, totalOf } from "./layers-panel.tsx";

const NOTHING: TagTally = { models: 0, pieces: 0 };

function useContributors(contributors: IContributorService): {
  readonly roster: Roster;
  readonly coloured: boolean;
} {
  const subscribe = useCallback(
    (listener: () => void) => contributors.subscribe(listener),
    [contributors],
  );
  const roster = useSyncExternalStore(subscribe, () => contributors.roster());
  const coloured = useSyncExternalStore(subscribe, () => contributors.coloured());
  return { roster, coloured };
}

function useCommittedValue(onCommit: (value: string) => void): RefObject<HTMLInputElement | null> {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return undefined;
    const changed = (): void => onCommit(element.value);
    element.addEventListener("change", changed);
    return () => element.removeEventListener("change", changed);
  }, [onCommit]);
  return input;
}

function ColorField({
  contributor,
  onCommit,
}: {
  readonly contributor: ContributorRecordV2;
  readonly onCommit: (color: string) => void;
}) {
  const input = useCommittedValue(onCommit);
  return (
    <input
      ref={input}
      type="color"
      className="contributor-swatch"
      aria-label={`Colour of "${contributor.name}"`}
      defaultValue={contributor.color}
      key={contributor.color}
    />
  );
}

function CountField({
  part,
  color,
  quantity,
  onCommit,
}: {
  readonly part: string;
  readonly color: number;
  readonly quantity: number;
  readonly onCommit: (quantity: number) => void;
}) {
  const input = useCommittedValue((value) => onCommit(Number(value)));
  return (
    <input
      ref={input}
      type="number"
      min={0}
      step={1}
      className="inventory-count"
      aria-label={`Count of ${part} colour ${color}`}
      defaultValue={quantity}
      key={quantity}
    />
  );
}

function collectionText(name: string, read: OwnedPartsRead): string {
  if (!read.ok) return read.problem;
  const rejected = read.owned.rejected;
  const skipped =
    rejected.length === 0
      ? ""
      : ` Rows not read, as they aren't a part id, a colour id and a whole quantity above 0: ${rejected.map((row) => `line ${row.line}`).join(", ")}.`;
  return `Read ${counted(read.owned.total, "part", "parts")} from ${name}.${skipped}`;
}

function InventoryBlock({
  editor,
  contributors,
  contributor,
  selection,
}: {
  readonly editor: IEditor;
  readonly contributors: IContributorService;
  readonly contributor: Contributor;
  readonly selection: string | null;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const { id, inventory } = contributor;
  const parts = inventory ? inventoryParts(inventory) : 0;
  const report = (issues: ReadonlyArray<Issue>): void =>
    setMessage(issues.length === 0 ? null : refusalText("The inventory", issues));
  return (
    <div
      className="contributor-inventory"
      role="group"
      aria-label={`Inventory of "${contributor.name}"`}
      data-parts={parts}
    >
      <p className="inventory-summary">
        {inventory
          ? `Brings ${counted(parts, "part", "parts")} in ${counted(inventory.rebrickable.length + inventory.ldraw.length, "lot", "lots")}: ${inventory.rebrickable.length} from a collection, ${inventory.ldraw.length} counted.`
          : "No inventory yet."}
      </p>
      <label className="inventory-import">
        Collection CSV (Rebrickable Part, Color and Quantity)
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            input.value = "";
            void contributors
              .importCollection(id, file)
              .then((read) => setMessage(collectionText(file.name, read)));
          }}
        />
      </label>
      <div className="layer-actions">
        <button
          type="button"
          disabled={selection === null}
          title={
            selection === null
              ? "Select the parts to count first"
              : `Add the parts of the selection (${selection}) to the counts`
          }
          onClick={() =>
            report(
              contributors.countParts(id, editor.bomInput({ kind: "selection" }).counter.lines()),
            )
          }
        >
          Count the selection
        </button>
        {inventory && (
          <button
            type="button"
            className="layer-remove"
            onClick={() => report(contributors.clearInventory(id))}
          >
            Clear
          </button>
        )}
      </div>
      {inventory && inventory.ldraw.length > 0 && (
        <ul className="inventory-counts" aria-label="Counted parts">
          {inventory.ldraw.map((line) => (
            <li key={`${line.part} ${line.color}`} data-part={line.part} data-color={line.color}>
              <span>
                {line.part.replace("ldraw:", "")} colour {line.color}
              </span>
              <CountField
                part={line.part}
                color={line.color}
                quantity={line.quantity}
                onCommit={(quantity) =>
                  report(contributors.setCount(id, line.part, line.color, quantity))
                }
              />
            </li>
          ))}
        </ul>
      )}
      {message !== null && <p className="layer-note">{message}</p>}
    </div>
  );
}

export function ContributorField({
  editor,
  contributors,
  members,
  enabled,
}: {
  readonly editor: IEditor;
  readonly contributors: IContributorService;
  readonly members: ReadonlyArray<SelectionItemView>;
  readonly enabled: boolean;
}) {
  const { roster } = useContributors(contributors);
  const held = [
    ...new Set(members.flatMap((member) => (member.kind === "train" ? [] : [member.owner]))),
  ];
  const [only] = held;
  const shared = held.length === 1 ? only : undefined;
  return (
    <label className="selection-field" title="Who brings the selection to the show">
      <span className="selection-field-label">Contributor</span>
      <select
        value={shared === undefined ? "" : String(shared)}
        disabled={!enabled}
        onChange={(event) =>
          editor.assignSelection(Number(event.currentTarget.value), event.timeStamp)
        }
      >
        {shared === undefined && (
          <option value="" disabled>
            {held.length} contributors
          </option>
        )}
        <option value={NO_OWNER}>Nobody</option>
        {roster.map((contributor) => (
          <option key={contributor.id} value={contributor.id}>
            {contributor.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ContributorsPanel({
  editor,
  contributors,
  contents,
  selection,
}: {
  readonly editor: IEditor;
  readonly contributors: IContributorService;
  readonly contents: ReadonlyMap<number, TagTally>;
  readonly selection: string | null;
}) {
  const { roster, coloured } = useContributors(contributors);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const current = roster.find((contributor) => contributor.id === picked) ?? null;
  const report = (subject: string, issues: ReadonlyArray<Issue>): boolean => {
    setRefusal(refusalText(subject, issues));
    return issues.length === 0;
  };
  const create = (): void => {
    const created = contributors.create(freeName("Contributor", roster, roster.length + 1));
    if (!created.ok) {
      report("A new contributor", created.issues);
      return;
    }
    setRefusal(null);
    setPicked(created.value);
    setRenaming(created.value);
  };
  return (
    <details
      className="contributors-panel"
      aria-label="Contributors"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={open ? "Fold the contributors away" : "Who brings what to the show"}>
        <h2>Contributors</h2>
        <span className="layers-glance">{roster.length}</span>
      </summary>
      <ul className="layer-list" aria-label="Contributors">
        {roster.map((contributor) => {
          const tally = contents.get(contributor.id) ?? NOTHING;
          return (
            <li
              key={contributor.id}
              className="layer-row contributor-row"
              data-contributor={contributor.id}
              data-current={contributor.id === picked ? "" : undefined}
            >
              <ColorField
                contributor={contributor}
                onCommit={(color) =>
                  report(`"${contributor.name}"`, contributors.recolour(contributor.id, color))
                }
              />
              {renaming === contributor.id ? (
                <RenameField
                  name={contributor.name}
                  label={`Rename contributor "${contributor.name}"`}
                  onCommit={(name) => {
                    setRenaming(null);
                    report("The name", contributors.rename(contributor.id, name));
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  className="layer-name"
                  title="Click to pick, double-click to rename"
                  onClick={() => setPicked(contributor.id)}
                  onDoubleClick={() => setRenaming(contributor.id)}
                >
                  <span className="layer-name-text">{contributor.name}</span>
                </button>
              )}
              <span className="layer-count" title={`${tagTallyText(tally)} assigned`}>
                {totalOf(tally)}
              </span>
            </li>
          );
        })}
      </ul>
      {current && (
        <div className="layer-actions" role="group" aria-label={`Contributor "${current.name}"`}>
          <button
            type="button"
            title="Select everything assigned to this contributor"
            onClick={() => editor.selectOwner(current.id)}
          >
            Select all
          </button>
          <button
            type="button"
            title="Move everything assigned to this contributor onto a parts layer named after them, made if missing"
            onClick={(event) => editor.moveOwnerToOwnLayer(current.id, event.timeStamp)}
          >
            Own layer
          </button>
          <button
            type="button"
            className="layer-remove"
            title="Remove this contributor once nothing is assigned to them"
            onClick={() => {
              if (report(`"${current.name}"`, contributors.remove(current.id))) setPicked(null);
            }}
          >
            Remove
          </button>
        </div>
      )}
      {current && (
        <InventoryBlock
          key={current.id}
          editor={editor}
          contributors={contributors}
          contributor={current}
          selection={selection}
        />
      )}
      <div className="layer-footer">
        <button type="button" data-action="new-contributor" onClick={create}>
          New contributor
        </button>
        <label className="contributor-coloured">
          <input
            type="checkbox"
            checked={coloured}
            onChange={(event) => contributors.setColoured(event.currentTarget.checked)}
          />
          Colour by contributor
        </label>
      </div>
      {refusal !== null && (
        <p className="layer-refusal" role="alert">
          {refusal}
        </p>
      )}
    </details>
  );
}
