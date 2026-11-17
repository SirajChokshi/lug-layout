import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CATEGORY_LABEL,
  PALETTE_CATEGORIES,
  PaletteIndex,
  TRACK_ITEM_ID,
  colorDisplayName,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
  type PaletteCategory,
  type PaletteEntry,
  type PaletteFilter,
  type PaletteHit,
} from "@brr/client";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface PaletteProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

function Section({
  id,
  title,
  count,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly count: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="palette-section" data-section={id} open>
      <summary>
        <span>{title}</span>
        <span className="palette-count">{count}</span>
      </summary>
      {children}
    </details>
  );
}

function swatchTitle(item: CatalogItemView): string {
  return item.color
    ? `${colorDisplayName(item.color.name)} (LDraw ${item.color.code})`
    : item.label;
}

function Swatches({
  entry,
  items,
  editor,
  snapshot,
}: PaletteProps & {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
}) {
  return (
    <div className="palette-swatches" role="group" aria-label={entry.title}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="palette-swatch"
          data-item={item.id}
          aria-pressed={snapshot.activeItem === item.id}
          aria-label={item.label}
          title={swatchTitle(item)}
          style={{ background: item.color?.rgb ?? "transparent" }}
          onClick={() => editor.chooseItem(item.id)}
        />
      ))}
    </div>
  );
}

function SwatchRow({
  entry,
  items,
  editor,
  snapshot,
}: PaletteProps & {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
}) {
  return (
    <li className="palette-row" data-group={entry.key}>
      <div className="palette-row-label">
        <span className="palette-size">{entry.size}</span>
        <span className="palette-title">{entry.title}</span>
      </div>
      <Swatches entry={entry} items={items} editor={editor} snapshot={snapshot} />
    </li>
  );
}

function itemMeta(item: CatalogItemView): string {
  const parts = `${integer.format(item.parts)} ${item.parts === 1 ? "part" : "parts"}`;
  return item.studsWide > 0 ? `${parts} · ${item.studsWide}×${item.studsDeep} studs` : parts;
}

function ItemButton({ item, editor, snapshot }: PaletteProps & { readonly item: CatalogItemView }) {
  return (
    <li>
      <button
        type="button"
        className="catalog-item"
        data-item={item.id}
        aria-pressed={snapshot.activeItem === item.id}
        onClick={() => editor.chooseItem(item.id)}
      >
        <span className="catalog-name">{item.label}</span>
        <span className="catalog-meta">{itemMeta(item)}</span>
      </button>
    </li>
  );
}

function colorCount(entries: ReadonlyArray<PaletteEntry>): string {
  const items = entries.reduce((sum, entry) => sum + entry.items.length, 0);
  return `${entries.length} ${entries.length === 1 ? "part" : "parts"}, ${items} colours`;
}

function TrackSection({ editor, snapshot }: PaletteProps) {
  const drawing = snapshot.mode === "track";
  const kit = snapshot.track?.bom ?? [];
  const available = snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
  return (
    <Section id="track" title="Track" count={`${kit.length} drawable pieces`}>
      <button
        type="button"
        className="palette-primary"
        data-item={TRACK_ITEM_ID}
        aria-pressed={drawing}
        disabled={!available}
        onClick={() => editor.chooseItem(drawing ? null : TRACK_ITEM_ID)}
      >
        {drawing ? "Drawing track: press Esc or T to stop" : "Draw track (T)"}
      </button>
      <p className="palette-hint">
        Drag on the ground to lay a run of real pieces. Start on an open end to continue a line, and
        release on another open end to join it exactly.
      </p>
      {kit.length > 0 && (
        <ul className="palette-parts">
          {kit.map((line) => (
            <li key={line.piece}>
              <span className="palette-size">{line.piece.replace(/^[a-z]+:/u, "")}</span>
              {line.title}
            </li>
          ))}
        </ul>
      )}
      {snapshot.trackNotDrawable.length > 0 && (
        <p className="palette-note" data-not-drawable={snapshot.trackNotDrawable.length}>
          In the bundle but not drawable yet:{" "}
          {snapshot.trackNotDrawable.map((part) => `${part.id} ${part.title}`).join("; ")}.
        </p>
      )}
    </Section>
  );
}

function MilsNotes() {
  return (
    <>
      <p className="palette-note" data-mils-flag="heights">
        Every module follows MILS (HispaBrick Magazine 013–016): a 32×32 module with its surface 4
        plates above the baseplate, and a 2×2 corner then a 1×4 Technic brick at each end of every
        side. Paths (4 studs) and earth tracks (8 studs) sit at the surface, paved roads (16 studs)
        one plate above it, and rivers (8 studs) at 2 plates with banks rising a plate per stud.
        Each feature is centred on the edges it crosses, and curves are single 90° elements.
      </p>
      <p className="palette-note" data-mils-flag="track">
        The rail module is a project rule, not MILS: MILS has no train rules (HispaBrick Magazine
        026, "MILS (VII)"). It centres one pair of 9V straights on the 4-plate surface.
      </p>
    </>
  );
}

function CategorySection({
  category,
  entries,
  editor,
  snapshot,
}: PaletteProps & {
  readonly category: PaletteCategory;
  readonly entries: ReadonlyArray<PaletteEntry>;
}) {
  switch (category) {
    case "track":
      return <TrackSection editor={editor} snapshot={snapshot} />;
    case "baseplates":
    case "road":
      return (
        <Section
          id={category === "road" ? "road" : "baseplates"}
          title={CATEGORY_LABEL[category]}
          count={colorCount(entries)}
        >
          <ul className="palette-rows">
            {entries.map((entry) => (
              <SwatchRow
                key={entry.key}
                entry={entry}
                items={entry.items}
                editor={editor}
                snapshot={snapshot}
              />
            ))}
          </ul>
        </Section>
      );
    case "mils":
    case "sets": {
      const items = entries.flatMap((entry) => entry.items);
      const noun = category === "mils" ? "modules" : "sets";
      return (
        <Section id={category} title={CATEGORY_LABEL[category]} count={`${items.length} ${noun}`}>
          <ul>
            {items.map((item) => (
              <ItemButton key={item.id} item={item} editor={editor} snapshot={snapshot} />
            ))}
          </ul>
          {category === "mils" && <MilsNotes />}
        </Section>
      );
    }
    default: {
      const unhandled: never = category;
      throw new Error(`unhandled palette category ${String(unhandled)}`);
    }
  }
}

function hitItemsText(hit: PaletteHit): string {
  const colored = hit.items.filter((item) => item.color !== null);
  if (colored.length === 0) return hit.items[0] ? itemMeta(hit.items[0]) : "";
  if (colored.length === hit.entry.items.length) {
    return `${colored.length} ${colored.length === 1 ? "colour" : "colours"}`;
  }
  return `${colored.length} of ${hit.entry.items.length} colours`;
}

function ResultRow({
  hit,
  highlighted,
  editor,
  snapshot,
  onPick,
}: PaletteProps & {
  readonly hit: PaletteHit;
  readonly highlighted: boolean;
  readonly onPick: (item: CatalogItemView) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const { entry } = hit;
  const first = hit.items[0];
  const colored = first?.color !== null && first !== undefined;
  return (
    <li
      ref={rowRef}
      className="palette-result"
      data-group={entry.key}
      data-highlighted={highlighted}
      aria-selected={highlighted}
      role="option"
    >
      <button
        type="button"
        className="palette-result-main"
        aria-pressed={hit.items.some((item) => item.id === snapshot.activeItem)}
        onClick={() => first && onPick(first)}
      >
        <span className="palette-result-title">
          {entry.partNumber && <span className="palette-number">{entry.partNumber}</span>}
          {entry.partNumber ? entry.title.replace(`${entry.partNumber} `, "") : entry.title}
        </span>
        <span className="palette-result-meta">
          <span className="palette-tag">{CATEGORY_LABEL[entry.category]}</span>
          {entry.size !== "" && entry.category !== "track" && <span>{entry.size}</span>}
          <span>{hitItemsText(hit)}</span>
        </span>
      </button>
      {colored && <Swatches entry={entry} items={hit.items} editor={editor} snapshot={snapshot} />}
    </li>
  );
}

function trackTerms(track: EditorSnapshot["track"]): ReadonlyArray<string> {
  return (track?.bom ?? []).flatMap((line) => [line.piece.replace(/^[a-z]+:/u, ""), line.title]);
}

const FILTERS: ReadonlyArray<PaletteFilter> = ["all", ...PALETTE_CATEGORIES];

function filterLabel(filter: PaletteFilter): string {
  return filter === "all" ? "All" : CATEGORY_LABEL[filter].replace(" modules", "");
}

export function PalettePanel({ editor, snapshot }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteFilter>("all");
  const [highlight, setHighlight] = useState(0);
  const { catalog } = snapshot;
  const trackKey = trackTerms(snapshot.track).join("\n");
  const index = useMemo(
    () =>
      new PaletteIndex(catalog, [
        { entryKey: TRACK_ITEM_ID, terms: trackKey === "" ? [] : trackKey.split("\n") },
      ]),
    [catalog, trackKey],
  );
  const searching = query.trim() !== "";
  const hits = useMemo(
    () => (searching ? index.search(query, filter) : []),
    [index, query, filter, searching],
  );
  const counts = useMemo(() => {
    const all = index.search(query, "all");
    return new Map<PaletteFilter, number>([
      ["all", all.length],
      ...PALETTE_CATEGORIES.map(
        (category) =>
          [category, all.filter((hit) => hit.entry.category === category).length] as const,
      ),
    ]);
  }, [index, query]);
  const shownHighlight = Math.min(highlight, Math.max(hits.length - 1, 0));

  const pick = (item: CatalogItemView): void => {
    editor.chooseItem(snapshot.activeItem === item.id && item.kind === "track" ? null : item.id);
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        setHighlight(Math.min(shownHighlight + 1, hits.length - 1));
        break;
      case "ArrowUp":
        setHighlight(Math.max(shownHighlight - 1, 0));
        break;
      case "Enter": {
        const item = hits[shownHighlight]?.items[0];
        if (!item) return;
        pick(item);
        event.currentTarget.blur();
        break;
      }
      case "Escape":
        if (query === "") event.currentTarget.blur();
        setQuery("");
        setHighlight(0);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const sections = PALETTE_CATEGORIES.filter((category) => filter === "all" || filter === category);
  return (
    <nav className="catalog palette" aria-label="Palette">
      <div className="palette-head">
        <h2>Palette</h2>
        <input
          type="search"
          className="palette-search"
          placeholder="Search: 3811, tan 16x16, crossroads, -sand"
          title='Words must all match. "Quote a phrase", -word excludes, #3811 matches numbers only.'
          aria-label="Search the palette"
          aria-controls="palette-results"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onSearchKey}
        />
        <div className="palette-tabs" role="tablist" aria-label="Palette categories">
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              className="palette-tab"
              data-filter={option}
              aria-selected={filter === option}
              onClick={() => {
                setFilter(option);
                setHighlight(0);
              }}
            >
              {filterLabel(option)}
              <span className="palette-tab-count">{counts.get(option) ?? 0}</span>
            </button>
          ))}
        </div>
      </div>
      {searching ? (
        <ul
          id="palette-results"
          className="palette-results"
          role="listbox"
          aria-label="Search results"
          data-results={hits.length}
        >
          {hits.map((hit, i) => (
            <ResultRow
              key={hit.entry.key}
              hit={hit}
              highlighted={i === shownHighlight}
              editor={editor}
              snapshot={snapshot}
              onPick={pick}
            />
          ))}
        </ul>
      ) : (
        sections.map((category) => (
          <CategorySection
            key={category}
            category={category}
            entries={index.entries(category)}
            editor={editor}
            snapshot={snapshot}
          />
        ))
      )}
      {searching && hits.length === 0 && (
        <p className="palette-hint" data-no-results>
          Nothing matches “{query}”{filter === "all" ? "" : ` in ${CATEGORY_LABEL[filter]}`}. Try a
          part number like 3811, a size like 16x16, or a colour like tan.
        </p>
      )}
      {snapshot.catalogSkipped.length > 0 && (
        <p
          className="catalog-skipped"
          data-catalog-skipped={snapshot.catalogSkipped.map((model) => model.name).join(",")}
        >
          Not placeable: {skippedText(snapshot)}
        </p>
      )}
    </nav>
  );
}

function skippedText(snapshot: EditorSnapshot): string {
  const byReason = new Map<string, string[]>();
  for (const model of snapshot.catalogSkipped) {
    byReason.set(model.reason, [...(byReason.get(model.reason) ?? []), model.name]);
  }
  return [...byReason].map(([reason, names]) => `${names.join(", ")} (${reason})`).join("; ");
}
