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
  PALETTE_TABS,
  colorDisplayName,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
  type IPalette,
  type IPaletteDrag,
  type IPaletteMemory,
  type IPalettePrefetch,
  type IPaletteThumbnails,
  type IPaletteSearch,
  type LibraryFilterScope,
  type PaletteColorChoice,
  type PaletteColors,
  type PaletteEntry,
  type PaletteRow,
  type PaletteSection,
  type PaletteTab,
  type SkippedCatalogModel,
} from "@brr/client";
import type { IconName } from "./icons/glyphs.ts";
import { Icon } from "./icons/icon.tsx";
import { FirstChord } from "./keys.tsx";
import { LibraryPartResults } from "./library-part-results.tsx";
import { paletteDragProps } from "./palette-drag.ts";
import { RoadKitList } from "./road-draw-panel.tsx";
import { usePaletteSearchSnapshot } from "./use-palette-search.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const THUMBNAIL_SLOT_PX = 52;

const PALETTE_FIELDS = [
  "catalog",
  "catalogSkipped",
  "activeItem",
  "mode",
  "status",
  "trackNotDrawable",
  "trackTools",
  "readOnly",
  "roadKits",
  "roadKit",
  "pendingItem",
] as const satisfies ReadonlyArray<keyof EditorSnapshot>;

type PaletteSnapshot = Pick<EditorSnapshot, (typeof PALETTE_FIELDS)[number]>;

interface PaletteProps {
  readonly editor: IEditor;
  readonly snapshot: PaletteSnapshot;
  readonly drag: IPaletteDrag;
  readonly prefetch: IPalettePrefetch;
}

interface PalettePanelProps {
  readonly editor: IEditor;
  readonly snapshot: PaletteSnapshot;
  readonly palette: IPalette;
}

function samePaletteInputs(before: PalettePanelProps, after: PalettePanelProps): boolean {
  return (Object.keys(after) as Array<keyof PalettePanelProps>).every((key) =>
    key === "snapshot"
      ? PALETTE_FIELDS.every((field) => before.snapshot[field] === after.snapshot[field])
      : before[key] === after[key],
  );
}

function choosePaletteItem(
  editor: IEditor,
  snapshot: PaletteSnapshot,
  item: CatalogItemView,
): void {
  editor.chooseItem(snapshot.activeItem === item.id && item.toggleable ? null : item.id);
}

function prefetchProps(prefetch: IPalettePrefetch, id: string) {
  return {
    onPointerEnter: () => prefetch.pointerEnter(id),
    onPointerLeave: () => prefetch.pointerLeave(),
    onFocus: () => prefetch.focus(id),
  };
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
      <Icon name={on ? "favorite" : "favorite-off"} />
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

function RenderedThumbnail({ item }: { readonly item: CatalogItemView | undefined }) {
  const thumbnails = useContext(ThumbnailsContext);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const seen = useScrolledIntoView(node);
  const urls = useSyncExternalStore(
    (listener) => thumbnails?.subscribe(listener) ?? (() => {}),
    () => thumbnails?.snapshot() ?? NO_THUMBNAILS,
  );
  const id = item?.id;
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
  if (!item?.thumbnail) return <RenderedThumbnail item={item} />;
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
  current,
  editor,
  snapshot,
  drag,
}: PaletteProps & {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
  readonly current: number | null;
}) {
  return (
    <div className="palette-swatches" role="group" aria-label={entry.title}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="palette-swatch"
          data-item={item.id}
          data-current-color={item.color !== null && item.color.code === current}
          aria-pressed={snapshot.activeItem === item.id}
          aria-busy={snapshot.pendingItem === item.id}
          aria-label={item.label}
          title={swatchTitle(item)}
          style={{ background: item.color?.rgb ?? "transparent" }}
          disabled={snapshot.readOnly}
          onClick={() => choosePaletteItem(editor, snapshot, item)}
          {...paletteDragProps(drag, item)}
        />
      ))}
    </div>
  );
}

function colorName(choices: ReadonlyArray<PaletteColorChoice>, code: number): string {
  const option = choices.find((c) => c.color.code === code);
  return option ? colorDisplayName(option.color.name) : `LDraw colour ${code}`;
}

function SwatchRow({
  row,
  current,
  ...props
}: PaletteProps & { readonly row: PaletteRow; readonly current: number | null }) {
  const { editor, snapshot, drag } = props;
  const { entry, chosen } = row;
  const shown = row.items.find((item) => item.id === snapshot.activeItem) ?? row.preview;
  return (
    <li className="palette-row" data-group={entry.key} data-unavailable={chosen === undefined}>
      <Thumbnail item={shown} />
      <div className="palette-row-head">
        <button
          type="button"
          className="palette-row-label"
          disabled={!chosen}
          aria-pressed={chosen !== undefined && snapshot.activeItem === chosen.id}
          title={chosen ? `Place ${chosen.label}` : undefined}
          onClick={() => chosen && choosePaletteItem(editor, snapshot, chosen)}
          {...(chosen ? paletteDragProps(drag, chosen) : {})}
        >
          <span className="palette-size">{entry.size}</span>
          <span className="palette-title">{entry.title}</span>
        </button>
        <FavoriteStar entryKey={entry.key} title={entry.title} />
      </div>
      <Swatches {...props} entry={entry} items={row.items} current={current} />
    </li>
  );
}

function ColorPicker({
  colors,
  noun,
  onChoose,
}: {
  readonly colors: PaletteColors;
  readonly noun: string;
  readonly onChoose: (code: number | null) => void;
}) {
  const { choices } = colors;
  const current = choices.find((option) => option.color.code === colors.current);
  return (
    <div className="palette-picker">
      <div className="palette-colors" role="radiogroup" aria-label={`${noun} colour`}>
        <button
          type="button"
          role="radio"
          className="palette-color-any"
          aria-checked={colors.current === null}
          onClick={() => onChoose(null)}
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
            aria-checked={colors.current === color.code}
            aria-label={colorDisplayName(color.name)}
            title={`${colorDisplayName(color.name)} (LDraw ${color.code}): ${parts} ${noun}`}
            style={{ background: color.rgb }}
            onClick={() => onChoose(colors.current === color.code ? null : color.code)}
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
  const counted = `${integer.format(item.parts)} ${item.parts === 1 ? "part" : "parts"}`;
  const parts =
    item.customParts > 0 ? `${counted} (${integer.format(item.customParts)} custom)` : counted;
  return item.studsWide > 0 ? `${parts} · ${item.studsWide}×${item.studsDeep} studs` : parts;
}

function CustomBadge({ item }: { readonly item: CatalogItemView }) {
  if (item.customParts === 0) return null;
  return (
    <span
      className="part-badge"
      data-badge="custom"
      title={`${item.customParts} custom ${item.customParts === 1 ? "part" : "parts"} from the file: drawn on this device only, connectors read at import and flagged unverified, never counted as buyable`}
    >
      custom
    </span>
  );
}

function ItemButton({
  item,
  editor,
  snapshot,
  drag,
  prefetch,
}: PaletteProps & { readonly item: CatalogItemView }) {
  return (
    <li className="palette-item-row">
      <Thumbnail item={item} />
      <button
        type="button"
        className="catalog-item"
        data-item={item.id}
        aria-pressed={snapshot.activeItem === item.id}
        aria-busy={snapshot.pendingItem === item.id}
        disabled={snapshot.readOnly}
        onClick={() => choosePaletteItem(editor, snapshot, item)}
        {...prefetchProps(prefetch, item.id)}
        {...paletteDragProps(drag, item)}
      >
        <span className="catalog-name">
          {item.label} <CustomBadge item={item} />
        </span>
        <span className="catalog-meta">
          {snapshot.pendingItem === item.id ? "loading…" : itemMeta(item)}
        </span>
      </button>
      <FavoriteStar entryKey={item.group} title={item.label} />
    </li>
  );
}

function UnplaceableItem({ model: { item, reason } }: { readonly model: SkippedCatalogModel }) {
  return (
    <li className="palette-item-row" data-unplaceable={item.id}>
      <span className="palette-thumb palette-thumb-empty" aria-hidden="true" />
      <button type="button" className="catalog-item" disabled>
        <span className="catalog-name">{item.label}</span>
      </button>
      <span className="palette-item-side">
        <span
          className="part-badge"
          data-badge="not-placeable"
          title={`Can't be placed yet: ${reason}`}
        >
          not placeable
        </span>
        <FavoriteStar entryKey={item.group} title={item.label} />
      </span>
    </li>
  );
}

function colorCount(entries: ReadonlyArray<PaletteEntry>): string {
  const items = entries.reduce((sum, entry) => sum + entry.items.length, 0);
  return `${entries.length} ${entries.length === 1 ? "part" : "parts"}, ${items} colours`;
}

function TrackSection({
  rows,
  editor,
  snapshot,
}: Pick<PaletteProps, "editor" | "snapshot"> & { readonly rows: ReadonlyArray<PaletteRow> }) {
  const items = rows.flatMap((row) => row.items);
  const tools = items.filter((item) => item.listedUnder === null);
  const pieces = items.filter((item) => item.listedUnder !== null);
  return (
    <Section id="track" title="Track" count={`${pieces.length} real pieces`}>
      {tools.map((tool) => {
        const drawing = snapshot.activeItem === tool.id;
        const state = snapshot.trackTools.find((candidate) => candidate.item === tool.id);
        return (
          <button
            key={tool.id}
            type="button"
            className="palette-primary"
            data-item={tool.id}
            aria-pressed={drawing}
            disabled={snapshot.readOnly}
            title={tool.label}
            onClick={() => choosePaletteItem(editor, snapshot, tool)}
          >
            {tool.shortLabel} {state?.active === true && <FirstChord id="draw-track" />}
            {state?.status === "unverified" && (
              <span
                className="part-badge"
                data-badge="unverified"
                title="Its curves' connector poses come from the part file but aren't certified, so its joins are only as exact as those poses."
              >
                unverified
              </span>
            )}
          </button>
        );
      })}
      <p className="palette-hint">
        Drag on the ground to lay a run. Start or release on an open end (amber arrow) to join it
        exactly; red arrows mark ends that nearly meet but don't join.
      </p>
      <ul className="palette-pieces" aria-label="Single track pieces">
        {pieces.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="catalog-item"
              data-item={item.id}
              aria-pressed={snapshot.activeItem === item.id}
              onClick={() => choosePaletteItem(editor, snapshot, item)}
            >
              <span className="catalog-name">{item.label}</span>
              <span className="catalog-meta">
                {item.studsWide}×{item.studsDeep} studs
              </span>
            </button>
            <FavoriteStar entryKey={item.id} title={item.label} />
          </li>
        ))}
      </ul>
      <p className="palette-hint">
        While you draw from an end, clicking a piece lays it there exactly and Enter lays another.
        Otherwise pick one piece and click to lay it: near an open end it attaches exactly. Click a
        laid switch to throw it.
      </p>
      <ul className="palette-keys" aria-label="Keys while holding a piece">
        <li>
          <FirstChord id="next-connector" /> next end
        </li>
        <li>
          <FirstChord id="rotate" /> quarter turn
        </li>
        <li>
          <FirstChord id="flip-switch" /> swap a switch
        </li>
      </ul>
      {snapshot.trackNotDrawable.length > 0 && (
        <p className="palette-note" data-not-drawable={snapshot.trackNotDrawable.length}>
          In the bundle but not drawable yet:{" "}
          {snapshot.trackNotDrawable.map((part) => `${part.id} ${part.title}`).join("; ")}.
        </p>
      )}
    </Section>
  );
}

function PaintedSection({
  section,
  color,
  onChooseColor,
  ...props
}: PaletteProps & {
  readonly section: PaletteSection & { readonly category: "baseplates" | "road" };
  readonly color: number | null;
  readonly onChooseColor: (code: number | null) => void;
}) {
  const { editor, snapshot } = props;
  const { category, colors, rows, unmade } = section;
  const noun = category === "road" ? "road plates" : "baseplates";
  const row = (shown: PaletteRow) => (
    <SwatchRow key={shown.entry.key} {...props} row={shown} current={colors.current} />
  );
  return (
    <Section
      id={category}
      title={CATEGORY_LABEL[category]}
      count={colorCount([...rows, ...unmade].map((shown) => shown.entry))}
    >
      {category === "road" && (
        <RoadKitList editor={editor} snapshot={snapshot} kits={snapshot.roadKits} />
      )}
      <ColorPicker colors={colors} noun={noun} onChoose={onChooseColor} />
      {colors.current === null && color !== null && (
        <p className="palette-hint" data-not-offered={color}>
          No {noun.replace(/s$/u, "")} is made in the current colour, so these show every colour.
        </p>
      )}
      <ul className="palette-rows">{rows.map((shown) => row(shown))}</ul>
      {colors.current !== null && unmade.length > 0 && (
        <details className="palette-unmade" data-unmade={unmade.length}>
          <summary>
            {unmade.length} more {unmade.length === 1 ? noun.replace(/s$/u, "") : noun} not made in{" "}
            {colorName(colors.choices, colors.current)}
          </summary>
          <ul className="palette-rows">{unmade.map((shown) => row(shown))}</ul>
        </details>
      )}
    </Section>
  );
}

function CategorySection({
  section,
  color,
  onChooseColor,
  ...props
}: PaletteProps & {
  readonly section: PaletteSection;
  readonly color: number | null;
  readonly onChooseColor: (code: number | null) => void;
}) {
  const { editor, snapshot } = props;
  const { category } = section;
  switch (category) {
    case "track":
      return <TrackSection rows={section.rows} editor={editor} snapshot={snapshot} />;
    case "baseplates":
    case "road":
      return (
        <PaintedSection
          {...props}
          section={{ ...section, category }}
          color={color}
          onChooseColor={onChooseColor}
        />
      );
    case "sets": {
      const items = section.rows.flatMap((row) => row.items);
      return (
        <Section id={category} title={CATEGORY_LABEL[category]} count={`${items.length} sets`}>
          <ul>
            {items.map((item) => (
              <ItemButton key={item.id} {...props} item={item} />
            ))}
            {snapshot.catalogSkipped.map((model) => (
              <UnplaceableItem key={model.item.id} model={model} />
            ))}
          </ul>
        </Section>
      );
    }
    default: {
      const unhandled: never = category;
      throw new Error(`unhandled palette category ${String(unhandled)}`);
    }
  }
}

function hitItemsText(row: PaletteRow): string {
  const colored = row.items.filter((item) => item.color !== null);
  if (colored.length === 0) return row.items[0] ? itemMeta(row.items[0]) : "";
  if (colored.length === row.entry.items.length) {
    return `${colored.length} ${colored.length === 1 ? "colour" : "colours"}`;
  }
  return `${colored.length} of ${row.entry.items.length} colours`;
}

function ResultRow({
  row,
  highlighted,
  color,
  ...props
}: PaletteProps & {
  readonly row: PaletteRow;
  readonly highlighted: boolean;
  readonly color: number | null;
}) {
  const { editor, snapshot, drag, prefetch } = props;
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const { entry, chosen } = row;
  const colored = chosen?.color !== null && chosen !== undefined;
  return (
    <li
      ref={rowRef}
      className="palette-result"
      data-group={entry.key}
      data-highlighted={highlighted}
      aria-selected={highlighted}
      role="option"
    >
      <Thumbnail item={row.preview} />
      <button
        type="button"
        className="palette-result-main"
        {...(chosen ? prefetchProps(prefetch, chosen.id) : {})}
        aria-pressed={row.items.some((item) => item.id === snapshot.activeItem)}
        onClick={() => chosen && choosePaletteItem(editor, snapshot, chosen)}
        {...(chosen ? paletteDragProps(drag, chosen) : {})}
      >
        <span className="palette-result-title">
          {entry.partNumber && <span className="palette-number">{entry.partNumber}</span>}
          {entry.partNumber ? entry.title.replace(`${entry.partNumber} `, "") : entry.title}
        </span>
        <span className="palette-result-meta">
          <span className="palette-tag">{CATEGORY_LABEL[entry.category]}</span>
          {chosen?.aliases.map((alias) => (
            <span key={alias} className="palette-alias" title="Rebrickable part number">
              {alias}
            </span>
          ))}
          {entry.size !== "" && entry.category !== "track" && <span>{entry.size}</span>}
          <span>{hitItemsText(row)}</span>
        </span>
      </button>
      <FavoriteStar entryKey={entry.key} title={entry.title} />
      {colored && <Swatches {...props} entry={entry} items={row.items} current={color} />}
    </li>
  );
}

const TAB_ICONS: Readonly<Record<PaletteTab, IconName>> = {
  all: "all",
  favorites: "favorite",
  track: "track-straight",
  baseplates: "baseplate",
  road: "road",
  sets: "set",
};

function tabName(tab: PaletteTab): string {
  if (tab === "all") return "All";
  if (tab === "favorites") return "Favourites";
  return CATEGORY_LABEL[tab];
}

const SHARED_PLACEHOLDER = "Search: 3811, tan 16x16, crossroads";
const SEARCH_SYNTAX =
  'Words must all match. "Quote a phrase", -word excludes, #3811 matches numbers only, and a colour name narrows the colours.';

function searchPlaceholder(scope: LibraryFilterScope, tab: PaletteTab): string {
  return scope === "per-tab" ? `Search ${tabName(tab)}` : SHARED_PLACEHOLDER;
}

function ScopeToggle({
  search,
  scope,
}: {
  readonly search: IPaletteSearch;
  readonly scope: LibraryFilterScope;
}) {
  const perTab = scope === "per-tab";
  return (
    <button
      type="button"
      className="palette-scope"
      data-action="search-per-tab"
      aria-pressed={perTab}
      title={
        perTab
          ? "Each tab keeps its own search and colour, remembered across visits. Click to use one search for every tab."
          : "One search for every tab. Click to give each tab its own search and colour, remembered across visits."
      }
      onClick={() => search.setScope(perTab ? "shared" : "per-tab")}
    >
      Search per tab
    </button>
  );
}

function usePaletteMemory(memory: IPaletteMemory) {
  return useSyncExternalStore(
    (listener) => memory.subscribe(listener),
    () => memory.snapshot(),
  );
}

function RecentStrip({
  recents,
  onForget,
  editor,
  snapshot,
  drag,
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
          onClick={() => choosePaletteItem(editor, snapshot, item)}
          {...paletteDragProps(drag, item)}
        >
          {item.color && <span className="palette-dot" style={{ background: item.color.rgb }} />}
          {item.shortLabel}
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
  palette,
}: PalettePanelProps) {
  const { search, memory, thumbnails, libraryPlacer } = palette;
  const props: PaletteProps = {
    editor,
    snapshot,
    drag: palette.drag,
    prefetch: palette.prefetch,
  };
  const {
    query,
    searching,
    tab,
    scope,
    filteredTabs,
    color,
    sections,
    hits,
    unplaceable,
    counts,
    status,
    library,
  } = usePaletteSearchSnapshot(search);
  const nothingListed = hits.length === 0 && unplaceable.length === 0;
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const remembered = usePaletteMemory(memory);
  const favorites = useMemo<Favorites>(
    () => ({
      keys: new Set(remembered.favorites),
      toggle: (entryKey) => memory.toggleFavorite(entryKey),
    }),
    [remembered.favorites, memory],
  );
  const listing = searching || tab === "favorites";
  const shownHighlight = Math.min(highlight, Math.max(hits.length - 1, 0));

  const showFromTop = (): void => {
    setHighlight(0);
    listRef.current?.scrollTo({ top: 0 });
  };
  const setQuery = (next: string): void => {
    search.setQuery(next);
    showFromTop();
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
        const item = hits[shownHighlight]?.chosen;
        if (!item) return;
        choosePaletteItem(editor, snapshot, item);
        event.currentTarget.blur();
        break;
      }
      case "Escape":
        if (query === "") event.currentTarget.blur();
        setQuery("");
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <FavoritesContext value={favorites}>
      <ThumbnailsContext value={snapshot.status === "ready" ? thumbnails : null}>
        <nav className="palette" aria-label="Parts and sets">
          <div className="palette-head">
            <div className="palette-title-row">
              <h2>Library</h2>
              <ScopeToggle search={search} scope={scope} />
            </div>
            <div className="palette-search-field">
              <span className="palette-search-icon">
                <Icon name="find" />
              </span>
              <input
                type="search"
                className="palette-search"
                placeholder={searchPlaceholder(scope, tab)}
                title={SEARCH_SYNTAX}
                aria-label="Search parts and sets"
                aria-controls="palette-results"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKey}
              />
              {query !== "" && (
                <button
                  type="button"
                  className="palette-search-clear"
                  aria-label="Clear the search"
                  title="Clear the search (Esc)"
                  onClick={() => setQuery("")}
                >
                  ×
                </button>
              )}
            </div>
            <div className="palette-tabs" role="tablist" aria-label="Categories">
              {PALETTE_TABS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  className="palette-tab"
                  data-filter={option}
                  data-filtered={filteredTabs.has(option)}
                  aria-selected={tab === option}
                  aria-label={
                    option === "favorites"
                      ? `Favourites${filteredTabs.has(option) ? ", filtered" : ""}`
                      : undefined
                  }
                  onClick={() => {
                    search.setTab(option);
                    showFromTop();
                  }}
                >
                  <Icon name={TAB_ICONS[option]} />
                  {option === "favorites" ? null : tabName(option)}
                  <span className="palette-tab-count">{counts.get(option) ?? 0}</span>
                  {filteredTabs.has(option) && <span className="visually-hidden">, filtered</span>}
                </button>
              ))}
            </div>
            <RecentStrip
              {...props}
              recents={remembered.recents}
              onForget={() => memory.forgetRecents()}
            />
          </div>
          <div className="palette-list" ref={listRef}>
            <p className="palette-hint palette-how">
              Click a part, then the ground to place copies, or drag it straight onto the layout.
            </p>
            {listing ? (
              <>
                <ul
                  id="palette-results"
                  className="palette-results"
                  role="listbox"
                  aria-label={searching ? "Search results" : "Favourites"}
                  data-results={hits.length}
                >
                  {hits.map((row, i) => (
                    <ResultRow
                      key={row.entry.key}
                      {...props}
                      row={row}
                      color={color}
                      highlighted={searching && i === shownHighlight}
                    />
                  ))}
                </ul>
                {unplaceable.length > 0 && (
                  <ul className="palette-results" aria-label="Not placeable">
                    {unplaceable.map((model) => (
                      <UnplaceableItem key={model.item.id} model={model} />
                    ))}
                  </ul>
                )}
              </>
            ) : (
              sections.map((section) => (
                <CategorySection
                  key={section.category}
                  {...props}
                  section={section}
                  color={color}
                  onChooseColor={(code) => search.chooseColor(code)}
                />
              ))
            )}
            {searching && library !== null && (
              <LibraryPartResults
                library={library}
                placer={libraryPlacer}
                preferredColor={color}
                readOnly={snapshot.readOnly}
              />
            )}
            {searching && status === "offline" && (
              <p className="palette-hint" data-search-offline>
                Search offline: showing palette matches only.
              </p>
            )}
            {searching && nothingListed && (library?.hits.length ?? 0) === 0 && (
              <p className="palette-empty" data-no-results>
                Nothing matches “{query}”{tab === "all" ? "" : ` in ${tabName(tab)}`}. Try a part
                number like 3811, a size like 16x16, or a colour like tan.
              </p>
            )}
            {!searching && tab === "favorites" && nothingListed && (
              <p className="palette-empty" data-no-favorites>
                No favourites yet. Star a part with ☆ to keep it here.
              </p>
            )}
          </div>
        </nav>
      </ThumbnailsContext>
    </FavoritesContext>
  );
}, samePaletteInputs);
