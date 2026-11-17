import type { EditorSnapshot, IEditor, WorldFileView } from "@brr/client";
import type { WorldIndexEntry } from "@brr/schema/world";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

interface WorldMenuProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

function plural(count: number, one: string, many: string): string {
  return `${integer.format(count)} ${count === 1 ? one : many}`;
}

function saveText(world: WorldFileView): string {
  switch (world.save) {
    case "saving":
      return "Saving…";
    case "failed":
      return "Not saved";
    case "off":
      return "Not saved: storage unavailable";
    case "saved":
      return `Saved · ${plural(world.placements, "placement", "placements")}${world.track > 0 ? ` · ${plural(world.track, "track piece", "track pieces")}` : ""} · ${plural(world.shards, "shard", "shards")}`;
    default: {
      const unhandled: never = world.save;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function downloadFile(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

function WorldRow({
  editor,
  item,
  current,
  disabled,
}: {
  readonly editor: IEditor;
  readonly item: WorldIndexEntry;
  readonly current: boolean;
  readonly disabled: boolean;
}) {
  const onDelete = (): void => {
    if (window.confirm(`Delete "${item.name}" from this browser? This can't be undone.`)) {
      void editor.deleteWorld(item.id);
    }
  };
  return (
    <li className={current ? "world-row current" : "world-row"} data-world-row={item.id}>
      <span className="world-row-name">
        {item.name} <span>({integer.format(item.placements)})</span>
      </span>
      <button
        type="button"
        disabled={disabled || current}
        onClick={() => void editor.openWorld(item.id)}
      >
        {current ? "Current" : "Open"}
      </button>
      <button type="button" disabled={disabled} onClick={onDelete}>
        Delete
      </button>
    </li>
  );
}

function useUnloadGuard(unsavedEdits: boolean): void {
  useEffect(() => {
    if (!unsavedEdits) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedEdits]);
}

export function WorldMenu({ editor, snapshot }: WorldMenuProps) {
  const [newName, setNewName] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const { world, worlds, bundleVersion, storageError, readOnly } = snapshot;
  const ready = snapshot.status === "ready" && world !== null;
  const stored = ready && storageError === null;
  const nameIssue = editor.worldNameIssue(newName);
  useUnloadGuard(snapshot.unsavedEdits);

  const onNew = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (nameIssue !== null) return;
    void editor.newWorld(newName).then((created) => {
      if (created) setNewName("");
    });
  };

  const onExport = (): void => {
    void editor.exportWorld().then(({ fileName, bytes }) => downloadFile(fileName, bytes));
  };

  const onImport = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const replacesUnsaved = storageError !== null && snapshot.placements > 0;
    if (
      replacesUnsaved &&
      !window.confirm(
        `Storage is unavailable, so importing replaces "${world?.name ?? ""}" and its ${plural(snapshot.placements, "placement", "placements")}, which aren't saved anywhere. Export it first if you want to keep it. Import anyway?`,
      )
    ) {
      input.value = "";
      return;
    }
    void file
      .arrayBuffer()
      .then((buffer) => editor.importWorld(new Uint8Array(buffer)))
      .finally(() => {
        input.value = "";
      });
  };

  return (
    <section className="world-menu" aria-label="World">
      <h2>World</h2>
      {world && (
        <p className="world-name" data-world-id={world.id ?? ""} data-save={world.save}>
          <strong>{world.name}</strong> <span>{saveText(world)}</span>
          {world.save === "failed" && (
            <button type="button" className="world-retry" onClick={() => void editor.retrySave()}>
              Retry
            </button>
          )}
        </p>
      )}
      {storageError !== null && (
        <p className="world-warning" data-storage="unavailable">
          Storage is unavailable, so nothing is saved ({storageError}). Export still works.
        </p>
      )}
      {readOnly && (
        <p className="world-warning" data-read-only="1">
          This world is open in another tab, so it is read-only here. Editing resumes when the other
          tab closes it.
        </p>
      )}
      {world && bundleVersion !== null && world.pinnedBundleVersion !== bundleVersion && (
        <p className="world-note">
          Saved with bundle {world.pinnedBundleVersion}; this app runs {bundleVersion}. The next
          save pins {bundleVersion}.
        </p>
      )}
      {stored && (
        <ul className="world-list">
          {worlds.map((item) => (
            <WorldRow
              key={item.id}
              editor={editor}
              item={item}
              current={item.id === world.id}
              disabled={!ready}
            />
          ))}
        </ul>
      )}
      <div className="world-actions">
        <form className="world-new" onSubmit={onNew}>
          <input
            type="text"
            value={newName}
            maxLength={editor.worldNameMaxLength}
            placeholder={`World ${worlds.length + 1}`}
            aria-label="New world name"
            aria-invalid={nameIssue !== null}
            disabled={!stored}
            onChange={(event) => setNewName(event.currentTarget.value)}
          />
          <button type="submit" disabled={!stored || nameIssue !== null}>
            New
          </button>
        </form>
        {nameIssue !== null && <p className="world-name-issue">The name {nameIssue}.</p>}
        <button type="button" disabled={!ready} onClick={onExport}>
          Export .brr.zip
        </button>
        <button type="button" disabled={!ready} onClick={() => importInput.current?.click()}>
          Import .brr.zip
        </button>
        <input
          ref={importInput}
          className="world-import"
          type="file"
          accept=".zip,application/zip"
          aria-label="Import a .brr.zip world"
          onChange={onImport}
        />
      </div>
      {snapshot.fileError !== null && <p className="error">{snapshot.fileError}</p>}
    </section>
  );
}
