import type { EditorSnapshot, IEditor } from "@brr/client";
import type { KitIndexEntry, KitLibrary as KitLibraryName } from "@brr/schema/world";
import { memo, useRef, type ChangeEvent } from "react";
import { downloadBlob } from "./download.ts";

const KIT_FIELDS = ["kits", "readOnly", "status", "storageError"] as const satisfies ReadonlyArray<
  keyof EditorSnapshot
>;

type KitSnapshot = Pick<EditorSnapshot, (typeof KIT_FIELDS)[number]>;

interface KitLibraryProps {
  readonly editor: IEditor;
  readonly snapshot: KitSnapshot;
}

const SHELVES: ReadonlyArray<readonly [KitLibraryName, string]> = [
  ["personal", "Personal"],
  ["club", "Club"],
];

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function countText(count: number, one: string, many: string): string {
  return `${integer.format(count)} ${count === 1 ? one : many}`;
}

function kitContents({ placements, track }: KitIndexEntry): string {
  const parts = placements > 0 ? [countText(placements, "part", "parts")] : [];
  const pieces = track > 0 ? [countText(track, "track piece", "track pieces")] : [];
  return [...parts, ...pieces].join(", ");
}

function sameKitInputs(before: KitLibraryProps, after: KitLibraryProps): boolean {
  return (
    before.editor === after.editor &&
    KIT_FIELDS.every((field) => before.snapshot[field] === after.snapshot[field])
  );
}

export const KitLibrary = memo(function KitLibrary({ editor, snapshot }: KitLibraryProps) {
  const input = useRef<HTMLInputElement>(null);
  const { kits, readOnly } = snapshot;
  const stored = snapshot.status === "ready" && snapshot.storageError === null;
  const onAdd = (event: ChangeEvent<HTMLInputElement>): void => {
    const field = event.currentTarget;
    const file = field.files?.[0];
    if (!file) return;
    void file
      .arrayBuffer()
      .then((buffer) => editor.addKitFile(new Uint8Array(buffer)))
      .finally(() => {
        field.value = "";
      });
  };
  const onDownload = (kit: KitIndexEntry): void => {
    void editor.exportKit(kit.id).then((file) => {
      if (file) {
        downloadBlob(file.fileName, new Blob([file.bytes.slice()], { type: "application/zip" }));
      }
    });
  };
  const onRemove = (kit: KitIndexEntry): void => {
    if (window.confirm(`Remove the kit "${kit.name}" from this browser? This can't be undone.`)) {
      void editor.removeKit(kit.id);
    }
  };
  return (
    <details className="kit-library" aria-label="Kits">
      <summary>
        <span>Kits</span>
        <span className="palette-count">{countText(kits.length, "kit", "kits")}</span>
      </summary>
      {SHELVES.map(([library, title]) => {
        const shelved = kits.filter((kit) => kit.library === library);
        if (shelved.length === 0) return null;
        return (
          <div key={library} className="kit-shelf" data-library={library}>
            <h3>{title}</h3>
            <ul>
              {shelved.map((kit) => (
                <li key={kit.id} className="kit-row">
                  <button
                    type="button"
                    className="palette-kit"
                    data-kit={kit.id}
                    disabled={readOnly}
                    title="Hold this kit, then click the layout to set it down"
                    onClick={() => void editor.placeKit(kit.id)}
                  >
                    <span className="palette-kit-name">{kit.name}</span>
                    <span className="palette-kit-meta">{kitContents(kit)}</span>
                  </button>
                  <button
                    type="button"
                    title="Download the kit file to share it"
                    onClick={() => onDownload(kit)}
                  >
                    File
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${kit.name}`}
                    title="Remove from this browser"
                    onClick={() => onRemove(kit)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="palette-hint">
        Select parts and track, then Save selection as kit. A kit places as one group, and each part
        joins by its own studs and track ends.
      </p>
      <button
        type="button"
        className="kit-add"
        data-action="add-kit-file"
        disabled={!stored}
        onClick={() => input.current?.click()}
      >
        Add club kit file
      </button>
      <input
        ref={input}
        className="world-import"
        type="file"
        accept=".zip,application/zip"
        aria-label="Add a club kit file (.brr.zip)"
        onChange={onAdd}
      />
    </details>
  );
}, sameKitInputs);
