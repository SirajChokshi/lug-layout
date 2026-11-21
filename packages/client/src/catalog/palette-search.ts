import { inject, injectable } from "inversify";
import { searchPalette, type PaletteResult } from "../commands/command-search.ts";
import type { CommandId } from "../commands/editor-commands.ts";
import { TRACK_ITEM_ID, type EditorSnapshot, type IEditor } from "../edit/editor.ts";
import type { CatalogItemView } from "./placeable-catalog.ts";
import { CATALOG_SEARCH, EDITOR, LIBRARY_PART_SEARCH, PALETTE_MEMORY } from "../tokens.ts";
import type { CatalogSearchStatus, ICatalogSearch } from "./catalog-search.ts";
import type { ILibraryPartSearch, LibrarySearchView } from "./library-part-search.ts";
import type { IPaletteMemory } from "./palette-memory.ts";
import {
  PALETTE_CATEGORIES,
  PaletteIndex,
  itemInColor,
  type PaletteCategory,
  type PaletteColorChoice,
  type PaletteEntry,
  type PaletteFilter,
} from "./palette-index.ts";
import { paletteResults } from "./palette-results.ts";

export type PaletteTab = PaletteFilter | "favorites";

export interface PaletteRow {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
  readonly chosen: CatalogItemView | undefined;
  readonly preview: CatalogItemView | undefined;
}

export interface PaletteColors {
  readonly choices: ReadonlyArray<PaletteColorChoice>;
  readonly current: number | null;
}

export interface PaletteSection {
  readonly category: PaletteCategory;
  readonly colors: PaletteColors;
  readonly rows: ReadonlyArray<PaletteRow>;
  readonly unmade: ReadonlyArray<PaletteRow>;
}

export type PaletteFind = (
  query: string,
  enabled: (id: CommandId) => boolean,
) => ReadonlyArray<PaletteResult>;

export interface PaletteSearchSnapshot {
  readonly query: string;
  readonly tab: PaletteTab;
  readonly color: number | null;
  readonly sections: ReadonlyArray<PaletteSection>;
  readonly hits: ReadonlyArray<PaletteRow>;
  readonly counts: ReadonlyMap<PaletteTab, number>;
  readonly status: CatalogSearchStatus;
  readonly library: LibrarySearchView | null;
  readonly find: PaletteFind;
}

export interface IPaletteSearch {
  subscribe(listener: () => void): () => void;
  snapshot(): PaletteSearchSnapshot;
  setQuery(query: string): void;
  setTab(tab: PaletteTab): void;
  chooseColor(code: number | null): void;
}

interface IndexedCatalog {
  readonly catalog: EditorSnapshot["catalog"];
  readonly trackTerms: string;
  readonly index: PaletteIndex;
  readonly offeredParts: ReadonlySet<string>;
}

const ELEMENT_NAMESPACE = /^[a-z]+:/u;
const LDRAW_GROUP = "ldraw:";

function offeredParts(catalog: EditorSnapshot["catalog"]): ReadonlySet<string> {
  return new Set(
    catalog.flatMap((item) =>
      item.group.startsWith(LDRAW_GROUP) ? [item.group.slice(LDRAW_GROUP.length)] : [],
    ),
  );
}

function trackTerms(track: EditorSnapshot["track"]): ReadonlyArray<string> {
  return (track?.bom ?? []).flatMap((line) => [
    line.piece.replace(ELEMENT_NAMESPACE, ""),
    line.title,
  ]);
}

function indexCatalog(
  { catalog, track }: EditorSnapshot,
  previous: IndexedCatalog | null,
): IndexedCatalog {
  const terms = trackTerms(track);
  const key = terms.join("\n");
  if (previous?.catalog === catalog && previous.trackTerms === key) return previous;
  return {
    catalog,
    trackTerms: key,
    index: new PaletteIndex(catalog, [{ entryKey: TRACK_ITEM_ID, terms }]),
    offeredParts: previous?.catalog === catalog ? previous.offeredParts : offeredParts(catalog),
  };
}

function shownCategories(tab: PaletteTab): ReadonlyArray<PaletteCategory> {
  if (tab === "all") return PALETTE_CATEGORIES;
  return tab === "favorites" ? [] : [tab];
}

function browseRow(index: PaletteIndex, entry: PaletteEntry, current: number | null): PaletteRow {
  const chosen =
    current === null ? index.defaultItem(entry.items, null) : itemInColor(entry, current);
  return {
    entry,
    items: entry.items,
    chosen,
    preview: chosen ?? index.defaultItem(entry.items, null),
  };
}

function section(
  index: PaletteIndex,
  category: PaletteCategory,
  color: number | null,
): PaletteSection {
  const choices = index.colorChoices(category);
  const current = choices.some((option) => option.color.code === color) ? color : null;
  const rows = index.entries(category).map((entry) => browseRow(index, entry, current));
  return {
    category,
    colors: { choices, current },
    rows: current === null ? rows : rows.filter((row) => row.chosen !== undefined),
    unmade: current === null ? [] : rows.filter((row) => row.chosen === undefined),
  };
}

@injectable()
export class PaletteSearch implements IPaletteSearch {
  private readonly listeners = new Set<() => void>();
  private query = "";
  private tab: PaletteTab = "all";
  private color: number | null = null;
  private indexed: IndexedCatalog;
  private state: PaletteSearchSnapshot;

  constructor(
    @inject(EDITOR) private readonly editor: Pick<IEditor, "snapshot" | "subscribe">,
    @inject(CATALOG_SEARCH) private readonly catalogSearch: ICatalogSearch,
    @inject(PALETTE_MEMORY) private readonly memory: Pick<IPaletteMemory, "snapshot" | "subscribe">,
    @inject(LIBRARY_PART_SEARCH) private readonly library: ILibraryPartSearch,
  ) {
    this.indexed = indexCatalog(editor.snapshot(), null);
    this.state = this.searched();
    editor.subscribe(() => this.reindex());
    catalogSearch.subscribe(() => this.update());
    memory.subscribe(() => this.update());
    library.subscribe(() => this.update());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PaletteSearchSnapshot {
    return this.state;
  }

  setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    this.catalogSearch.search(query);
    this.library.search(query, this.indexed.offeredParts);
    this.update();
  }

  setTab(tab: PaletteTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.update();
  }

  chooseColor(code: number | null): void {
    if (code === this.color) return;
    this.color = code;
    this.update();
  }

  private reindex(): void {
    const next = indexCatalog(this.editor.snapshot(), this.indexed);
    if (next === this.indexed) return;
    this.indexed = next;
    this.library.search(this.query, next.offeredParts);
    this.update();
  }

  private update(): void {
    this.state = this.searched();
    for (const listener of this.listeners) listener();
  }

  private searched(): PaletteSearchSnapshot {
    const { query, tab, color } = this;
    const { catalog, index } = this.indexed;
    const { favorites: favoriteKeys, recents } = this.memory.snapshot();
    const favorites = new Set(favoriteKeys);
    const isFavorite = (hit: { readonly entry: PaletteEntry }): boolean =>
      favorites.has(hit.entry.key);
    const results = paletteResults(
      index,
      query,
      tab === "favorites" ? "all" : tab,
      this.catalogSearch.view(),
    );
    let hits = query.trim() === "" ? [] : results.hits;
    if (tab === "favorites") hits = results.hits.filter(isFavorite);
    return {
      query,
      tab,
      color,
      sections: shownCategories(tab).map((category) => section(index, category, color)),
      hits: hits.map(({ entry, items }) => {
        const chosen = index.defaultItem(items, color);
        return { entry, items, chosen, preview: chosen };
      }),
      counts: new Map<PaletteTab, number>([
        ...results.counts,
        ["favorites", index.search(query, "all").filter(isFavorite).length],
      ]),
      status: results.status,
      library: tab === "all" ? this.library.view() : null,
      find: (findQuery, enabled) =>
        searchPalette(findQuery, { catalog, index, recent: recents, enabled }),
    };
  }
}
