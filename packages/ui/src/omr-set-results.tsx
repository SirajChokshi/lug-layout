import type {
  IEditor,
  IOmrSetPlacer,
  OmrModelView,
  OmrPlacementView,
  OmrSetSearchView,
  OmrSetView,
} from "@brr/client";
import { useRef, useSyncExternalStore } from "react";
import { importModelFiles, MODEL_FILE_ACCEPT } from "./model-files.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const KB = 1024;
const MB = KB * KB;

function downloadSize(bytes: number): string {
  return bytes < MB
    ? `${integer.format(Math.ceil(bytes / KB))} KB`
    : `${(bytes / MB).toFixed(1)} MB`;
}

function modelLabel(model: OmrModelView): string {
  return `${model.variant ?? "LDraw model"} · ${downloadSize(model.bytes)}`;
}

function setsCount({ status, total, hits, sets }: OmrSetSearchView): string {
  switch (status) {
    case "loading":
      return "searching…";
    case "ready":
      return total > hits.length
        ? `${hits.length} of ${integer.format(total)}`
        : `${integer.format(total)} of ${integer.format(sets)} sets`;
    case "off":
    case "idle":
    case "unavailable":
      return "";
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled set search status ${String(unhandled)}`);
    }
  }
}

function ImportOwnFile({
  editor,
  disabled,
}: {
  readonly editor: IEditor;
  readonly disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <p className="palette-hint" data-omr-unmodelled>
      No LDraw model of this set yet.{" "}
      <button type="button" disabled={disabled} onClick={() => input.current?.click()}>
        Import your own file
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept={MODEL_FILE_ACCEPT}
        aria-label="Import your own file of this set (.io, .ldr, .mpd)"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          void importModelFiles(editor, files);
        }}
      />
    </p>
  );
}

function OmrSetRow({
  set,
  placer,
  placement,
  editor,
  readOnly,
}: {
  readonly set: OmrSetView;
  readonly placer: IOmrSetPlacer;
  readonly placement: OmrPlacementView;
  readonly editor: IEditor;
  readonly readOnly: boolean;
}) {
  const [main, ...variants] = set.models;
  const busy = readOnly || placement.pending !== null;
  const refused = set.models.some((model) => model.file === placement.refused?.file)
    ? placement.refused
    : null;
  const place = (model: OmrModelView): void => void placer.place(set, model);
  const loading = (model: OmrModelView): string =>
    placement.pending === model.file ? "loading…" : modelLabel(model);
  const heading = (
    <>
      <span className="palette-result-title">
        <span className="palette-number">{set.number}</span>
        {set.name}
      </span>
      <span className="palette-result-meta">
        <span className="palette-tag">{set.theme.at(-1)}</span>
        <span>{set.year}</span>
        <span>{integer.format(set.parts)} parts</span>
        {main && <span>{loading(main)}</span>}
      </span>
    </>
  );
  return (
    <li className="palette-result library-part" data-omr-set={set.number}>
      {main ? (
        <button
          type="button"
          className="palette-result-main"
          data-omr-model={main.file}
          disabled={busy}
          aria-busy={placement.pending === main.file}
          title={`Download the LDraw model of ${set.name} and place it`}
          onClick={() => place(main)}
        >
          {heading}
        </button>
      ) : (
        <div className="palette-result-main">{heading}</div>
      )}
      {variants.length > 0 && (
        <div className="palette-swatches" role="group" aria-label={`${set.name} models`}>
          {variants.map((model) => (
            <button
              key={model.file}
              type="button"
              className="palette-more-colors"
              data-omr-model={model.file}
              disabled={busy}
              aria-busy={placement.pending === model.file}
              onClick={() => place(model)}
            >
              {loading(model)}
            </button>
          ))}
        </div>
      )}
      {!main && <ImportOwnFile editor={editor} disabled={readOnly} />}
      {refused && (
        <p className="palette-hint library-refused" data-omr-refused={refused.file}>
          Not placeable: {refused.reason}
        </p>
      )}
    </li>
  );
}

export function OmrSetResults({
  sets,
  placer,
  editor,
  readOnly,
}: {
  readonly sets: OmrSetSearchView;
  readonly placer: IOmrSetPlacer;
  readonly editor: IEditor;
  readonly readOnly: boolean;
}) {
  const placement = useSyncExternalStore(
    (listener) => placer.subscribe(listener),
    () => placer.view(),
  );
  if (sets.status === "off" || sets.status === "idle") return null;
  return (
    <section
      className="palette-more-sets"
      aria-label="More sets"
      data-omr-status={sets.status}
      data-omr-total={sets.total}
    >
      <h3 className="palette-library-head">
        <span>More sets</span>
        <span className="palette-count">{setsCount(sets)}</span>
      </h3>
      {sets.status === "unavailable" && (
        <p className="palette-hint" data-omr-error>
          The set list can't be loaded: {sets.error}
        </p>
      )}
      {sets.status === "ready" && sets.hits.length === 0 && (
        <p className="palette-hint">No set matches “{sets.query}”.</p>
      )}
      {sets.hits.length > 0 && (
        <>
          <p className="palette-hint">
            {integer.format(sets.modelled)} sets have an LDraw model in the Official Model
            Repository, downloaded when you pick it.
          </p>
          <ul className="palette-results library-results" aria-label="Sets">
            {sets.hits.map((set) => (
              <OmrSetRow
                key={set.number}
                set={set}
                placer={placer}
                placement={placement}
                editor={editor}
                readOnly={readOnly}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
