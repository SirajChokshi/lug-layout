import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CATEGORY_LABEL,
  PALETTE_CATEGORIES,
  PaletteIndex,
  TRACK_ITEM_ID,
  TRACK_PIECE_PREFIX,
  colorDisplayName,
  paletteResults,
  itemInColor,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
  type PaletteCategory,
  type PaletteColorChoice,
  type PaletteEntry,
  type PaletteFilter,
  type PaletteHit,
} from "@brr/client";
import { hoverPrefetch } from "./hover-prefetch.ts";
import { paletteDragProps } from "./palette-drag.ts";
import { RoadKitList } from "./road-draw-panel.tsx";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const THUMBNAIL_SLOT_PX = 52;

const PALETTE_FIELDS = [
  "catalog",
  "catalogSkipped",
  "activeItem",
  "mode",
  "track",
  "trackNotDrawable",
  "readOnly",
  "roadKits",
  "roadKit",
  "pendingItem",
  "catalogSearch",
] as const satisfies ReadonlyArray<keyof EditorSnapshot>;

type PaletteSnapshot = Pick<EditorSnapshot, (typeof PALETTE_FIELDS)[number]>;

interface PaletteProps {
  readonly editor: IEditor;
  readonly snapshot: PaletteSnapshot;
}

function samePaletteInputs(before: PaletteProps, after: PaletteProps): boolean {
  return (
    before.editor === after.editor &&
    PALETTE_FIELDS.every((field) => before.snapshot[field] === after.snapshot[field])
  );
}

interface Paint {
  readonly current: number | null;
  readonly choose: (code: number | null) => void;
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
  if (!item.color) return item.label;
  const name = `${colorDisplayName(item.color.name)} (LDraw ${item.color.code})`;
  if (item.elements.length === 0) return name;
  return `${name}, LEGO element ${item.elements.join(" or ")}`;
}

function Thumbnail({ item }: { readonly item: CatalogItemView | undefined }) {
  if (!item?.thumbnail) return null;
  return (
    <img
      className="palette-thumb"
      src={item.thumbnail}
      alt=""
      width={THUMBNAIL_SLOT_PX}
      height={THUMBNAIL_SLOT_PX}
      loading="lazy"
      decoding="async"
      data-thumb={item.id}
    />
  );
}

function Swatches({
  entry,
  items,
  editor,
  snapshot,
  paint,
}: PaletteProps & {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
  readonly paint: Paint;
}) {
  return (
    <div className="palette-swatches" role="group" aria-label={entry.title}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="palette-swatch"
          data-item={item.id}
          data-current-color={item.color !== null && item.color.code === paint.current}
          aria-pressed={snapshot.activeItem === item.id}
          aria-label={item.label}
          title={swatchTitle(item)}
          style={{ background: item.color?.rgb ?? "transparent" }}
          disabled={snapshot.readOnly}
          onClick={() => editor.chooseItem(item.id)}
          {...paletteDragProps(editor, item)}
        />
      ))}
    </div>
  );
}

function colorName(choices: ReadonlyArray<PaletteColorChoice>, code: number): string {
  const choice = choices.find((c) => c.color.code === code);
  return choice ? colorDisplayName(choice.color.name) : `LDraw colour ${code}`;
}

function SwatchRow({
  entry,
  items,
  editor,
  snapshot,
  paint,
}: PaletteProps & {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
  readonly paint: Paint;
}) {
  const painted = paint.current === null ? entry.items[0] : itemInColor(entry, paint.current);
  const unavailable = paint.current !== null && painted === undefined;
  const shown = items.find((item) => item.id === snapshot.activeItem) ?? painted ?? items[0];
  return (
    <li className="palette-row" data-group={entry.key} data-unavailable={unavailable}>
      <Thumbnail item={shown} />
      <button
        type="button"
        className="palette-row-label"
        disabled={!painted}
        aria-pressed={painted !== undefined && snapshot.activeItem === painted.id}
        title={painted ? `Place ${painted.label}` : undefined}
        onClick={() => painted && editor.chooseItem(painted.id)}
        {...(painted ? paletteDragProps(editor, painted) : {})}
      >
        <span className="palette-size">{entry.size}</span>
        <span className="palette-title">{entry.title}</span>
      </button>
      <Swatches entry={entry} items={items} editor={editor} snapshot={snapshot} paint={paint} />
    </li>
  );
}

function ColorPicker({
  choices,
  paint,
  noun,
}: {
  readonly choices: ReadonlyArray<PaletteColorChoice>;
  readonly paint: Paint;
  readonly noun: string;
}) {
  const current = choices.find((choice) => choice.color.code === paint.current);
  return (
    <div className="palette-picker">
      <div className="palette-colors" role="radiogroup" aria-label={`${noun} colour`}>
        <button
          type="button"
          role="radio"
          className="palette-color-any"
          aria-checked={paint.current === null}
          onClick={() => paint.choose(null)}
        >
          Any
        </button>
        {choices.map(({ color, parts }) => (
          <button
            key={color.code}
            type="button"
            role="radio"
            className="palette-color"
            data-color={color.code}
            aria-checked={paint.current === color.code}
            aria-label={colorDisplayName(color.name)}
            title={`${colorDisplayName(color.name)} (LDraw ${color.code}): ${parts} ${noun}`}
            style={{ background: color.rgb }}
            onClick={() => paint.choose(paint.current === color.code ? null : color.code)}
          />
        ))}
      </div>
      <p className="palette-color-name" data-color-name={current ? current.color.code : ""}>
        {current
          ? `${colorDisplayName(current.color.name)}: made in ${current.parts} of these ${noun}`
          : `${choices.length} colours, each one Rebrickable lists as produced`}
      </p>
    </div>
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
        aria-busy={snapshot.pendingItem === item.id}
        disabled={snapshot.readOnly}
        onClick={() => editor.chooseItem(item.id)}
        {...hoverPrefetch(editor, item.id)}
        {...paletteDragProps(editor, item)}
      >
        <Thumbnail item={item} />
        <span className="catalog-name">{item.label}</span>
        <span className="catalog-meta">
          {snapshot.pendingItem === item.id ? "loading…" : itemMeta(item)}
        </span>
      </button>
    </li>
  );
}

function colorCount(entries: ReadonlyArray<PaletteEntry>): string {
  const items = entries.reduce((sum, entry) => sum + entry.items.length, 0);
  return `${entries.length} ${entries.length === 1 ? "part" : "parts"}, ${items} colours`;
}

function TrackSection({ editor, snapshot }: PaletteProps) {
  const drawing = snapshot.mode === "track" && snapshot.activeItem === TRACK_ITEM_ID;
  const pieces = snapshot.catalog.filter((item) => item.id.startsWith(TRACK_PIECE_PREFIX));
  const available = snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
  const held = snapshot.track?.held ?? null;
  return (
    <Section id="track" title="Track" count={`${pieces.length} real pieces`}>
      <button
        type="button"
        className="palette-primary"
        data-item={TRACK_ITEM_ID}
        aria-pressed={drawing}
        disabled={!available || snapshot.readOnly}
        onClick={() => editor.chooseItem(drawing ? null : TRACK_ITEM_ID)}
      >
        {drawing ? "Drawing track: press Esc or T to stop" : "Draw track (T)"}
      </button>
      <p className="palette-hint">
        Drag on the ground to lay a run of real pieces. Start on an open end to continue a line, and
        release on another open end to join it exactly.
      </p>
      <ul className="palette-pieces" aria-label="Single track pieces">
        {pieces.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="catalog-item"
              data-item={item.id}
              aria-pressed={
                snapshot.activeItem === item.id ||
                (held !== null && item.id === `${TRACK_PIECE_PREFIX}${held.item}`)
              }
              onClick={() => editor.chooseItem(snapshot.activeItem === item.id ? null : item.id)}
            >
              <span className="catalog-name">{item.label}</span>
              <span className="catalog-meta">
                {item.studsWide}×{item.studsDeep} studs
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="palette-hint">
        Pick a piece, then click to lay it. Near an open end it attaches exactly. Q swings it onto
        its next end, R turns it a quarter turn on the studs of open ground, X swaps a switch
        between left and right. Click a laid switch to throw it.
      </p>
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

function PaintedSection({
  category,
  entries,
  choices,
  editor,
  snapshot,
  paint,
}: PaletteProps & {
  readonly category: "baseplates" | "road";
  readonly entries: ReadonlyArray<PaletteEntry>;
  readonly choices: ReadonlyArray<PaletteColorChoice>;
  readonly paint: Paint;
}) {
  const noun = category === "road" ? "road plates" : "baseplates";
  const offered = choices.some((choice) => choice.color.code === paint.current);
  const sectionPaint = offered ? paint : { ...paint, current: null };
  const current = sectionPaint.current;
  const made = current === null ? entries : entries.filter((entry) => itemInColor(entry, current));
  const unmade = current === null ? [] : entries.filter((entry) => !itemInColor(entry, current));
  const row = (entry: PaletteEntry) => (
    <SwatchRow
      key={entry.key}
      entry={entry}
      items={entry.items}
      editor={editor}
      snapshot={snapshot}
      paint={sectionPaint}
    />
  );
  return (
    <Section id={category} title={CATEGORY_LABEL[category]} count={colorCount(entries)}>
      {category === "road" && (
        <RoadKitList editor={editor} snapshot={snapshot} kits={snapshot.roadKits} />
      )}
      <ColorPicker choices={choices} paint={sectionPaint} noun={noun} />
      {!offered && paint.current !== null && (
        <p className="palette-hint" data-not-offered={paint.current}>
          No {noun.replace(/s$/u, "")} is made in the current colour, so these show every colour.
        </p>
      )}
      <ul className="palette-rows">{made.map((entry) => row(entry))}</ul>
      {current !== null && unmade.length > 0 && (
        <details className="palette-unmade" data-unmade={unmade.length}>
          <summary>
            {unmade.length} more {unmade.length === 1 ? noun.replace(/s$/u, "") : noun} not made in{" "}
            {colorName(choices, current)}
          </summary>
          <ul className="palette-rows">{unmade.map((entry) => row(entry))}</ul>
        </details>
      )}
    </Section>
  );
}

function CategorySection({
  category,
  entries,
  choices,
  editor,
  snapshot,
  paint,
}: PaletteProps & {
  readonly category: PaletteCategory;
  readonly entries: ReadonlyArray<PaletteEntry>;
  readonly choices: ReadonlyArray<PaletteColorChoice>;
  readonly paint: Paint;
}) {
  switch (category) {
    case "track":
      return <TrackSection editor={editor} snapshot={snapshot} />;
    case "baseplates":
    case "road":
      return (
        <PaintedSection
          category={category}
          entries={entries}
          choices={choices}
          editor={editor}
          snapshot={snapshot}
          paint={paint}
        />
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

function paintedItem(
  items: ReadonlyArray<CatalogItemView>,
  current: number | null,
): CatalogItemView | undefined {
  return items.find((item) => item.color?.code === current) ?? items[0];
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
  paint,
  onPick,
}: PaletteProps & {
  readonly hit: PaletteHit;
  readonly highlighted: boolean;
  readonly paint: Paint;
  readonly onPick: (item: CatalogItemView) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const { entry } = hit;
  const first = paintedItem(hit.items, paint.current);
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
        {...(first ? hoverPrefetch(editor, first.id) : {})}
        aria-pressed={hit.items.some((item) => item.id === snapshot.activeItem)}
        onClick={() => first && onPick(first)}
        {...(first ? paletteDragProps(editor, first) : {})}
      >
        <span className="palette-result-title">
          {entry.partNumber && <span className="palette-number">{entry.partNumber}</span>}
          {entry.partNumber ? entry.title.replace(`${entry.partNumber} `, "") : entry.title}
        </span>
        <span className="palette-result-meta">
          <span className="palette-tag">{CATEGORY_LABEL[entry.category]}</span>
          {first?.aliases.map((alias) => (
            <span key={alias} className="palette-alias" title="Rebrickable part number">
              {alias}
            </span>
          ))}
          {entry.size !== "" && entry.category !== "track" && <span>{entry.size}</span>}
          <span>{hitItemsText(hit)}</span>
        </span>
      </button>
      {colored && (
        <Swatches
          entry={entry}
          items={hit.items}
          editor={editor}
          snapshot={snapshot}
          paint={paint}
        />
      )}
    </li>
  );
}

function trackTerms(track: PaletteSnapshot["track"]): ReadonlyArray<string> {
  return (track?.bom ?? []).flatMap((line) => [line.piece.replace(/^[a-z]+:/u, ""), line.title]);
}

const FILTERS: ReadonlyArray<PaletteFilter> = ["all", ...PALETTE_CATEGORIES];

function filterLabel(filter: PaletteFilter): string {
  return filter === "all" ? "All" : CATEGORY_LABEL[filter].replace(" modules", "");
}

export const PalettePanel = memo(function PalettePanel({ editor, snapshot }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteFilter>("all");
  const [highlight, setHighlight] = useState(0);
  const [color, setColor] = useState<number | null>(null);
  const paint: Paint = { current: color, choose: setColor };
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
  useEffect(() => editor.searchCatalog(query), [editor, query]);
  const results = useMemo(
    () => paletteResults(index, query, filter, snapshot.catalogSearch),
    [index, query, filter, snapshot.catalogSearch],
  );
  const hits = searching ? results.hits : [];
  const { counts } = results;
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
        const item = paintedItem(hits[shownHighlight]?.items ?? [], color);
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
      <p className="palette-hint palette-how">
        Click a part and then the ground to place copies, or drag it straight onto the layout.
      </p>
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
              paint={paint}
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
            choices={index.colorChoices(category)}
            editor={editor}
            snapshot={snapshot}
            paint={paint}
          />
        ))
      )}
      {searching && results.status === "offline" && (
        <p className="palette-hint" data-search-offline>
          Search offline: showing palette matches only.
        </p>
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
}, samePaletteInputs);

function skippedText(snapshot: PaletteSnapshot): string {
  const byReason = new Map<string, string[]>();
  for (const model of snapshot.catalogSkipped) {
    byReason.set(model.reason, [...(byReason.get(model.reason) ?? []), model.name]);
  }
  return [...byReason].map(([reason, names]) => `${names.join(", ")} (${reason})`).join("; ");
}
