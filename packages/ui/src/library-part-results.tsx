import {
  colorDisplayName,
  type ILibraryPartPlacer,
  type LibraryPartHit,
  type LibraryPlacementView,
  type LibrarySearchView,
} from "@brr/client";
import { useState, useSyncExternalStore } from "react";

const SWATCHES_SHOWN = 16;
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

type HitColor = LibraryPartHit["colors"][number];

function useLibraryPlacement(placer: ILibraryPartPlacer): LibraryPlacementView {
  return useSyncExternalStore(
    (listener) => placer.subscribe(listener),
    () => placer.view(),
  );
}

function defaultColor(hit: LibraryPartHit, preferred: number | null): HitColor | undefined {
  return hit.colors.find((color) => color.code === preferred) ?? hit.colors[0];
}

function libraryCount({ status, total, hits, parts }: LibrarySearchView): string {
  switch (status) {
    case "loading":
      return "searching…";
    case "ready":
      return total > hits.length
        ? `${hits.length} of ${integer.format(total)}`
        : `${integer.format(total)} of ${integer.format(parts)} parts`;
    case "off":
    case "idle":
    case "unavailable":
      return "";
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled library search status ${String(unhandled)}`);
    }
  }
}

function LibraryPartRow({
  hit,
  placer,
  placement,
  preferredColor,
  readOnly,
}: {
  readonly hit: LibraryPartHit;
  readonly placer: ILibraryPartPlacer;
  readonly placement: LibraryPlacementView;
  readonly preferredColor: number | null;
  readonly readOnly: boolean;
}) {
  const [allColors, setAllColors] = useState(false);
  const { part } = hit;
  const chosen = defaultColor(hit, preferredColor);
  const shown = allColors ? hit.colors : hit.colors.slice(0, SWATCHES_SHOWN);
  const busy = placement.pending !== null;
  const pendingHere = placement.pending?.part === part.id;
  const refused = placement.refused?.part === part.id ? placement.refused : null;
  const place = (color: HitColor | undefined): void => {
    if (color) void placer.place(part, color);
  };
  return (
    <li className="palette-result library-part" data-library-part={part.id}>
      <button
        type="button"
        className="palette-result-main"
        disabled={readOnly || busy || chosen === undefined}
        aria-busy={pendingHere}
        title={chosen ? `Place ${part.title} in ${colorDisplayName(chosen.name)}` : undefined}
        onClick={() => place(chosen)}
      >
        <span className="palette-result-title">
          <span className="palette-number">{part.id}</span>
          {part.title}
        </span>
        <span className="palette-result-meta">
          <span className="palette-tag">{part.category}</span>
          {part.rebrickable !== part.id && (
            <span className="palette-alias" title="Rebrickable part number">
              {part.rebrickable}
            </span>
          )}
          <span>
            {pendingHere
              ? "loading…"
              : `${hit.colors.length} ${hit.colors.length === 1 ? "colour" : "colours"}`}
          </span>
        </span>
      </button>
      <div className="palette-swatches" role="group" aria-label={`${part.title} colours`}>
        {shown.map((color) => (
          <button
            key={color.code}
            type="button"
            className="palette-swatch"
            data-library-item={`${part.id}@${color.code}`}
            aria-label={`${part.title} in ${colorDisplayName(color.name)}`}
            title={`${colorDisplayName(color.name)} (LDraw ${color.code})`}
            style={{ background: color.rgb }}
            disabled={readOnly || busy}
            onClick={() => place(color)}
          />
        ))}
        {hit.colors.length > shown.length && (
          <button type="button" className="palette-more-colors" onClick={() => setAllColors(true)}>
            +{hit.colors.length - shown.length}
          </button>
        )}
      </div>
      {refused && (
        <p
          className="palette-hint library-refused"
          data-library-refused={`${refused.part}@${refused.color}`}
        >
          Not placeable: {refused.reason}
        </p>
      )}
    </li>
  );
}

export function LibraryPartResults({
  library,
  placer,
  preferredColor,
  readOnly,
}: {
  readonly library: LibrarySearchView;
  readonly placer: ILibraryPartPlacer;
  readonly preferredColor: number | null;
  readonly readOnly: boolean;
}) {
  const placement = useLibraryPlacement(placer);
  if (library.status === "off" || library.status === "idle") return null;
  return (
    <section
      className="palette-library"
      aria-label="Parts library"
      data-library-status={library.status}
      data-library-total={library.total}
    >
      <h3 className="palette-library-head">
        <span>Parts library</span>
        <span className="palette-count">{libraryCount(library)}</span>
      </h3>
      {library.status === "unavailable" && (
        <p className="palette-hint" data-library-error>
          The parts library can't be loaded: {library.error}
        </p>
      )}
      {library.status === "ready" && library.hits.length === 0 && (
        <p className="palette-hint" data-library-empty>
          No single part matches “{library.query}”.
        </p>
      )}
      {library.hits.length > 0 && (
        <ul className="palette-results library-results" aria-label="Single parts">
          {library.hits.map((hit) => (
            <LibraryPartRow
              key={hit.part.id}
              hit={hit}
              placer={placer}
              placement={placement}
              preferredColor={preferredColor}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
