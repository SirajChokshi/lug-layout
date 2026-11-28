import {
  NO_OWNER,
  tagTallyText,
  type IContributorService,
  type IEditor,
  type Roster,
  type SelectionItemView,
  type TagTally,
} from "@brr/client";
import type { Issue } from "@brr/schema/decode";
import type { ContributorRecordV2 } from "@brr/schema/world";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

function ColorField({
  contributor,
  onCommit,
}: {
  readonly contributor: ContributorRecordV2;
  readonly onCommit: (color: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return undefined;
    const changed = (): void => onCommit(element.value);
    element.addEventListener("change", changed);
    return () => element.removeEventListener("change", changed);
  }, [onCommit]);
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
}: {
  readonly editor: IEditor;
  readonly contributors: IContributorService;
  readonly contents: ReadonlyMap<number, TagTally>;
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
