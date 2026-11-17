import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CATEGORY_LABEL,
  PALETTE_CATEGORIES,
  TRACK_ITEM_ID,
  TRACK_PIECE_PREFIX,
  colorDisplayName,
  itemInColor,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
  type IPaletteMemory,
  type IPaletteThumbnails,
  type PaletteCategory,
  type PaletteColorChoice,
  type PaletteEntry,
  type PaletteFilter,
  type PaletteHit,
} from "@brr/client";
import { paletteDragProps } from "./palette-drag.ts";
import { RoadKitList } from "./road-draw-panel.tsx";
import { usePaletteIndex } from "./use-palette-index.ts";
import { usePaletteMemory } from "./use-palette-memory.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const PALETTE_FIELDS = [
  "catalog",
  "catalogSkipped",
  "activeItem",
  "mode",
  "status",
  "track",
  "trackNotDrawable",
  "readOnly",
  "roadKits",
  "roadKit",
] as const satisfies ReadonlyArray<keyof EditorSnapshot>;

type PaletteSnapshot = Pick<EditorSnapshot, (typeof PALETTE_FIELDS)[number]>;

interface PaletteProps {
  readonly editor: IEditor;
  readonly snapshot: PaletteSnapshot;
}

function samePaletteInputs<P extends PaletteProps>(before: P, after: P): boolean {
  return (Object.keys(after) as Array<keyof P>).every((key) =>
    key === "snapshot"
      ? PALETTE_FIELDS.every((field) => before.snapshot[field] === after.snapshot[field])
      : before[key] === after[key],
  );
}

interface Favorites {
  readonly keys: ReadonlySet<string>;
  readonly toggle: (entryKey: string) => void;
}

const FavoritesContext = createContext<Favorites>({ keys: new Set(), toggle: () => {} });

function FavoriteStar({ entryKey, title }: { readonly entryKey: string; readonly title: string }) {
  const favorites = useContext(FavoritesContext);
  const on = favorites.keys.has(entryKey);
  return (
    <button
      type="button"
      className="palette-star"
      data-favorite={entryKey}
      aria-pressed={on}
      aria-label={on ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
      title={on ? "Remove from favourites" : "Add to favourites"}
      onClick={() => favorites.toggle(entryKey)}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

const ThumbnailsContext = createContext<IPaletteThumbnails | null>(null);

const NO_THUMBNAILS: ReadonlyMap<string, string> = new Map();

const THUMBNAIL_LOOKAHEAD = "200px";

function useScrolledIntoView(node: HTMLElement | null): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      { rootMargin: THUMBNAIL_LOOKAHEAD },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen, node]);
  return seen;
}

function Thumbnail({ item }: { readonly item: CatalogItemView | undefined }) {
  const thumbnails = useContext(ThumbnailsContext);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const seen = useScrolledIntoView(node);
  const urls = useSyncExternalStore(
    (listener) => thumbnails?.subscribe(listener) ?? (() => {}),
    () => thumbnails?.snapshot() ?? NO_THUMBNAILS,
  );
  const id = item?.kind === "track" ? undefined : item?.id;
  useEffect(() => {
    if (seen && id !== undefined) thumbnails?.request(id);
  }, [thumbnails, id, seen]);
  const url = id === undefined ? undefined : urls.get(id);
  return url ? (
    <img ref={setNode} className="palette-thumb" src={url} alt="" data-thumb={id} />
  ) : (
    <span ref={setNode} className="palette-thumb palette-thumb-empty" aria-hidden="true" />
  );
}

interface Paint {
  readonly current: number | null;
  readonly choose: (code: number | null) => void;
  readonly resolve: (
    items: ReadonlyArray<CatalogItemView>,
    current: number | null,
  ) => CatalogItemView | undefined;
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
  const painted =
    paint.current === null ? paint.resolve(entry.items, null) : itemInColor(entry, paint.current);
  const unavailable = paint.current !== null && painted === undefined;
  return (
    <li className="palette-row" data-group={entry.key} data-unavailable={unavailable}>
      <Thumbnail item={painted ?? paint.resolve(entry.items, null)} />
      <div className="palette-row-head">
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
        <FavoriteStar entryKey={entry.key} title={entry.title} />
      </div>
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
    <li className="palette-item-row">
      <Thumbnail item={item} />
      <button
        type="button"
        className="catalog-item"
        data-item={item.id}
        aria-pressed={snapshot.activeItem === item.id}
        disabled={snapshot.readOnly}
        onClick={() => editor.chooseItem(item.id)}
        {...paletteDragProps(editor, item)}
      >
        <span className="catalog-name">{item.label}</span>
        <span className="catalog-meta">{itemMeta(item)}</span>
      </button>
      <FavoriteStar entryKey={item.group} title={item.label} />
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
        its next end, R turns it 22.5° on open ground, X swaps a switch between left and right.
        Click a laid switch to throw it.
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
  const first = paint.resolve(hit.items, paint.current);
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
      <Thumbnail item={first} />
      <button
        type="button"
        className="palette-result-main"
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
      <FavoriteStar entryKey={entry.key} title={entry.title} />
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

type Tab = PaletteFilter | "favorites";

const TABS: ReadonlyArray<Tab> = ["all", "favorites", ...PALETTE_CATEGORIES];

function tabLabel(tab: Tab): string {
  if (tab === "all") return "All";
  if (tab === "favorites") return "★";
  return CATEGORY_LABEL[tab].replace(" modules", "");
}

function tabName(tab: Tab): string {
  return tab === "favorites" ? "Favourites" : tabLabel(tab);
}

function recentLabel(item: CatalogItemView): string {
  if (item.kind === "track") return "Track";
  if (item.color)
    return `${item.group.replace(/^[a-z]+:/u, "")} ${item.studsWide}×${item.studsDeep}`;
  return item.label.replace(/ \(\d{4}\)$/u, "");
}

function RecentStrip({
  editor,
  snapshot,
  recents,
  onForget,
}: PaletteProps & { readonly recents: ReadonlyArray<string>; readonly onForget: () => void }) {
  const items = recents.flatMap((id) => snapshot.catalog.find((item) => item.id === id) ?? []);
  if (items.length === 0) return null;
  return (
    <div className="palette-recents" aria-label="Recently placed">
      <span className="palette-recents-label">Recent</span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="palette-recent"
          data-recent={item.id}
          aria-pressed={snapshot.activeItem === item.id}
          title={item.label}
          onClick={() =>
            editor.chooseItem(
              snapshot.activeItem === item.id && item.kind === "track" ? null : item.id,
            )
          }
          {...paletteDragProps(editor, item)}
        >
          {item.color && <span className="palette-dot" style={{ background: item.color.rgb }} />}
          {recentLabel(item)}
        </button>
      ))}
      <button type="button" className="palette-recents-clear" onClick={onForget}>
        clear
      </button>
    </div>
  );
}

export const PalettePanel = memo(function PalettePanel({
  editor,
  snapshot,
  memory,
  thumbnails,
}: PaletteProps & { readonly memory: IPaletteMemory; readonly thumbnails: IPaletteThumbnails }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [highlight, setHighlight] = useState(0);
  const [color, setColor] = useState<number | null>(null);
  const remembered = usePaletteMemory(memory);
  const favorites = useMemo<Favorites>(
    () => ({
      keys: new Set(remembered.favorites),
      toggle: (entryKey) => memory.toggleFavorite(entryKey),
    }),
    [remembered.favorites, memory],
  );
  const { catalog } = snapshot;
  const index = usePaletteIndex(catalog, snapshot.track);
  const paint: Paint = {
    current: color,
    choose: setColor,
    resolve: (items, current) => index.defaultItem(items, current),
  };
  const searching = query.trim() !== "";
  const listing = searching || tab === "favorites";
  const hits = useMemo(() => {
    if (!listing) return [];
    const found = index.search(query, tab === "favorites" ? "all" : tab);
    return tab === "favorites" ? found.filter((hit) => favorites.keys.has(hit.entry.key)) : found;
  }, [index, query, tab, listing, favorites]);
  const counts = useMemo(() => {
    const all = index.search(query, "all");
    return new Map<Tab, number>([
      ["all", all.length],
      ["favorites", all.filter((hit) => favorites.keys.has(hit.entry.key)).length],
      ...PALETTE_CATEGORIES.map(
        (category) =>
          [category, all.filter((hit) => hit.entry.category === category).length] as const,
      ),
    ]);
  }, [index, query, favorites]);
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
        const item = paint.resolve(hits[shownHighlight]?.items ?? [], color);
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

  const sections = PALETTE_CATEGORIES.filter((category) => tab === "all" || tab === category);
  return (
    <FavoritesContext value={favorites}>
      <ThumbnailsContext value={snapshot.status === "ready" ? thumbnails : null}>
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
              {TABS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  className="palette-tab"
                  data-filter={option}
                  aria-selected={tab === option}
                  aria-label={option === "favorites" ? "Favourites" : undefined}
                  onClick={() => {
                    setTab(option);
                    setHighlight(0);
                  }}
                >
                  {tabLabel(option)}
                  <span className="palette-tab-count">{counts.get(option) ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
          <RecentStrip
            editor={editor}
            snapshot={snapshot}
            recents={remembered.recents}
            onForget={() => memory.forgetRecents()}
          />
          <p className="palette-hint palette-how">
            Click a part and then the ground to place copies, or drag it straight onto the layout.
          </p>
          {listing ? (
            <ul
              id="palette-results"
              className="palette-results"
              role="listbox"
              aria-label={searching ? "Search results" : "Favourites"}
              data-results={hits.length}
            >
              {hits.map((hit, i) => (
                <ResultRow
                  key={hit.entry.key}
                  hit={hit}
                  highlighted={searching && i === shownHighlight}
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
          {searching && hits.length === 0 && (
            <p className="palette-hint" data-no-results>
              Nothing matches “{query}”{tab === "all" ? "" : ` in ${tabName(tab)}`}. Try a part
              number like 3811, a size like 16x16, or a colour like tan.
            </p>
          )}
          {!searching && tab === "favorites" && hits.length === 0 && (
            <p className="palette-hint" data-no-favorites>
              No favourites yet. Star a part with ☆ to keep it here.
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
      </ThumbnailsContext>
    </FavoritesContext>
  );
}, samePaletteInputs);

function skippedText(snapshot: PaletteSnapshot): string {
  const byReason = new Map<string, string[]>();
  for (const model of snapshot.catalogSkipped) {
    byReason.set(model.reason, [...(byReason.get(model.reason) ?? []), model.name]);
  }
  return [...byReason].map(([reason, names]) => `${names.join(", ")} (${reason})`).join("; ");
}
