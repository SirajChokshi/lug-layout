import {
  commandActive,
  commandEnabled,
  isPlayCommand,
  isShellCommand,
  runEditorAction,
  runPlayAction,
  searchPalette,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
  type IEditorCamera,
  type ITrainPlay,
  type PaletteResult,
  type ShellCommandId,
} from "@brr/client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CommandKeys } from "./keys.tsx";

interface CommandPaletteProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly play: ITrainPlay;
  readonly snapshot: EditorSnapshot;
  readonly recent: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onShellCommand: (id: ShellCommandId) => void;
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const KIND_LABELS: Readonly<Record<CatalogItemView["kind"], string>> = {
  baseplate: "Baseplate",
  "road-plate": "Road",
  "mils-module": "MILS module",
  model: "Set",
  track: "Track",
};

function displayName(text: string): string {
  return text.replaceAll("_", " ");
}

function resultKey(result: PaletteResult): string {
  return result.kind === "item" ? `item:${result.item.id}` : `command:${result.spec.id}`;
}

function ItemRow({ item, recent }: { readonly item: CatalogItemView; readonly recent: boolean }) {
  const parts = `${integer.format(item.parts)} ${item.parts === 1 ? "part" : "parts"}`;
  return (
    <>
      <span
        className={item.color ? "cmdk-glyph swatch" : "cmdk-glyph"}
        style={item.color ? { background: item.color.rgb } : undefined}
        aria-hidden="true"
      >
        {item.color ? "" : KIND_LABELS[item.kind].charAt(0)}
      </span>
      <span className="cmdk-result-text">
        <span className="cmdk-result-title">{displayName(item.label)}</span>
        <span className="cmdk-result-meta">
          {KIND_LABELS[item.kind]} · {item.studsWide}×{item.studsDeep} studs · {parts}
        </span>
      </span>
      <span className="cmdk-result-side">{recent && <span className="tag">Recent</span>}</span>
    </>
  );
}

function CommandRow({
  result,
  snapshot,
}: {
  readonly result: Extract<PaletteResult, { kind: "command" }>;
  readonly snapshot: EditorSnapshot;
}) {
  const { spec, enabled } = result;
  const on = commandActive(spec.id, snapshot);
  return (
    <>
      <span className="cmdk-glyph command" aria-hidden="true">
        ›
      </span>
      <span className="cmdk-result-text">
        <span className="cmdk-result-title">{spec.title}</span>
        <span className="cmdk-result-meta">
          {spec.group}
          {on ? " · on" : ""}
          {enabled ? "" : " · not available right now"}
        </span>
      </span>
      <span className="cmdk-result-side">
        <CommandKeys id={spec.id} />
      </span>
    </>
  );
}

export function CommandPalette({
  editor,
  camera,
  play,
  snapshot,
  recent,
  onClose,
  onShellCommand,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(
    () =>
      searchPalette(query, {
        catalog: snapshot.catalog,
        recent,
        enabled: (id) => commandEnabled(id, snapshot),
      }),
    [query, snapshot, recent],
  );
  const active = Math.min(cursor, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (result: PaletteResult | undefined, eventTimeMs: number): void => {
    if (!result) return;
    if (result.kind === "item") {
      editor.chooseItem(result.item.id);
      onClose();
      return;
    }
    if (!result.enabled) return;
    const { id } = result.spec;
    if (isShellCommand(id)) {
      onShellCommand(id);
      return;
    }
    onClose();
    if (isPlayCommand(id)) runPlayAction(editor, play, id);
    else runEditorAction(editor, camera, id, eventTimeMs);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = results.length;
    switch (event.key) {
      case "ArrowDown":
        setCursor(count === 0 ? 0 : (active + 1) % count);
        break;
      case "ArrowUp":
        setCursor(count === 0 ? 0 : (active - 1 + count) % count);
        break;
      case "Enter":
        run(results[active], event.timeStamp);
        break;
      case "Escape":
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      className="overlay cmdk-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="cmdk" role="dialog" aria-modal="true" aria-label="Find">
        <input
          type="search"
          className="cmdk-input"
          placeholder="Find a part or command: green 32x32, crossroads, rotate…"
          aria-label="Find a part or command"
          aria-controls="cmdk-results"
          aria-activedescendant={results.length > 0 ? `cmdk-result-${active}` : undefined}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul
          ref={listRef}
          id="cmdk-results"
          className="cmdk-results"
          role="listbox"
          data-results={results.length}
        >
          {results.map((result, index) => (
            <li
              key={resultKey(result)}
              id={`cmdk-result-${index}`}
              data-index={index}
              data-result={resultKey(result)}
              role="option"
              aria-selected={index === active}
              aria-disabled={result.kind === "command" && !result.enabled}
              className="cmdk-result"
              onPointerMove={() => index !== active && setCursor(index)}
              onClick={(event) => run(result, event.timeStamp)}
            >
              {result.kind === "item" ? (
                <ItemRow item={result.item} recent={result.recent} />
              ) : (
                <CommandRow result={result} snapshot={snapshot} />
              )}
            </li>
          ))}
          {results.length === 0 && <li className="cmdk-empty">Nothing matches “{query}”.</li>}
        </ul>
        <div className="cmdk-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> pick up the part or run the command
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </section>
    </div>
  );
}
