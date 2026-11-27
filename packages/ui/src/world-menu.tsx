import type {
  EditorSnapshot,
  ICloudWorlds,
  IEditor,
  IStarterWorlds,
  ModelImportView,
  WorldFileView,
} from "@brr/client";
import type { WorldIndexEntry } from "@brr/schema/world";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { CloudAccount, useCloudView } from "./cloud-account.tsx";
import { downloadBlob } from "./download.ts";
import { ImportReportDetails } from "./import-report.tsx";
import { MODEL_FILE_ACCEPT, importModelFiles } from "./model-files.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface WorldMenuProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
  readonly starters: IStarterWorlds;
  readonly cloud: ICloudWorlds | null;
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

function saveGlance(save: WorldFileView["save"]): string {
  switch (save) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "failed":
    case "off":
      return "Not saved";
    default: {
      const unhandled: never = save;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function WorldRow({
  editor,
  item,
  current,
  disabled,
  keptInAccount,
}: {
  readonly editor: IEditor;
  readonly item: WorldIndexEntry;
  readonly current: boolean;
  readonly disabled: boolean;
  readonly keptInAccount: boolean;
}) {
  const onDelete = (): void => {
    const kept = keptInAccount ? "Your account keeps its synced copy." : "This can't be undone.";
    if (window.confirm(`Delete "${item.name}" from this browser? ${kept}`)) {
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

function modelImportText(view: ModelImportView): string {
  switch (view.status) {
    case "importing":
      return `Importing ${view.file}: reading, compiling and baking its parts…`;
    case "checking":
      return `${view.file} is in the palette, checking studs. Click the layout to place it.`;
    case "placeable":
      return `${view.file} is in the palette. Click the layout to place it.`;
    case "check-failed":
      return `${view.file} is in the palette, but its ${view.reason ?? "stud check failed"}. Its studs stay unchecked.`;
    case "refused":
      return `${view.file} can't be placed: ${view.reason ?? "no stud lattice from the bake"}.`;
    default: {
      const unhandled: never = view.status;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function ModelImportStatus({ view }: { readonly view: ModelImportView }) {
  return (
    <section
      className="model-import"
      data-file={view.file}
      data-status={view.status}
      data-item={view.item ?? ""}
    >
      <p
        className={
          view.status === "refused" || view.status === "check-failed"
            ? "world-warning"
            : "world-note"
        }
      >
        {modelImportText(view)}
      </p>
      {view.report && (
        <details className="model-import-report">
          <summary>Import report</summary>
          <ImportReportDetails report={view.report} studio={view.studio} />
        </details>
      )}
    </section>
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

export function WorldMenu({ editor, snapshot, starters, cloud }: WorldMenuProps) {
  const cloudView = useCloudView(cloud);
  const [newName, setNewName] = useState("");
  const [open, setOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const { world, worlds, bundleVersion, storageError, readOnly } = snapshot;
  const ready = snapshot.status === "ready" && world !== null;
  const stored = ready && storageError === null;
  const nameIssue = editor.worldNameIssue(newName);
  const modelImport = snapshot.modelImport;
  const needsAttention =
    storageError !== null ||
    readOnly ||
    world?.save === "failed" ||
    snapshot.fileError !== null ||
    snapshot.catalogError !== null ||
    modelImport?.status === "importing" ||
    modelImport?.status === "checking" ||
    modelImport?.status === "check-failed" ||
    modelImport?.status === "refused";
  useUnloadGuard(snapshot.unsavedEdits);

  const onNew = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (nameIssue !== null) return;
    void editor.newWorld(newName).then((created) => {
      if (created) setNewName("");
    });
  };

  const onExport = (): void => {
    void editor
      .exportWorld()
      .then(({ fileName, bytes }) =>
        downloadBlob(fileName, new Blob([bytes.slice()], { type: "application/zip" })),
      );
  };

  const onImportModel = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    void importModelFiles(editor, input.files ?? []).finally(() => {
      input.value = "";
    });
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
    <details
      className="world-menu"
      aria-label="World"
      open={open || needsAttention}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={open ? "Fold the world menu" : "Open, create, export or import worlds"}>
        <h2>World</h2>
        {world && (
          <span className="world-glance">
            <strong>{world.name}</strong>
            <span className="world-status" data-save={world.save}>
              {saveGlance(world.save)}
            </span>
          </span>
        )}
      </summary>
      {world && (
        <p className="world-name" data-world-id={world.id ?? ""} data-save={world.save}>
          <span>{saveText(world)}</span>
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
              keptInAccount={cloudView?.signIn === "signed-in"}
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
        <button
          type="button"
          data-action="show-starters"
          disabled={!ready}
          onClick={() => starters.show()}
        >
          Starter worlds
        </button>
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
        <button
          type="button"
          disabled={!ready || readOnly || modelImport?.status === "importing"}
          onClick={() => modelInput.current?.click()}
        >
          Import model
        </button>
        <input
          ref={modelInput}
          className="world-import model-file-import"
          type="file"
          accept={MODEL_FILE_ACCEPT}
          multiple
          aria-label="Import a model file (.io, .ldr, .mpd)"
          onChange={onImportModel}
        />
      </div>
      {cloud !== null && cloudView !== null && (
        <CloudAccount cloud={cloud} view={cloudView} editor={editor} snapshot={snapshot} />
      )}
      {modelImport && <ModelImportStatus view={modelImport} />}
      {snapshot.fileError !== null && <p className="error">{snapshot.fileError}</p>}
      {snapshot.catalogError !== null && <p className="error">{snapshot.catalogError}</p>}
    </details>
  );
}
