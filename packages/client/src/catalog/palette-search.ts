import { inject, injectable } from "inversify";
import type { CatalogItemView } from "./placeable-catalog.ts";
import { CATALOG_SEARCH, LIBRARY_PART_SEARCH, PALETTE_CATALOG, PALETTE_MEMORY } from "../tokens.ts";
import type { CatalogSearchStatus, ICatalogSearch } from "./catalog-search.ts";
import type { ILibraryPartSearch, LibrarySearchView } from "./library-part-search.ts";
import type { IPaletteCatalog } from "./palette-catalog.ts";
import type { IPaletteMemory } from "./palette-memory.ts";
import {
  PALETTE_CATEGORIES,
  itemInColor,
  type PaletteCategory,
  type PaletteColorChoice,
  type PaletteEntry,
  type PaletteFilter,
  type PaletteIndex,
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

export interface PaletteSearchSnapshot {
  readonly query: string;
  readonly tab: PaletteTab;
  readonly color: number | null;
  readonly sections: ReadonlyArray<PaletteSection>;
  readonly hits: ReadonlyArray<PaletteRow>;
  readonly counts: ReadonlyMap<PaletteTab, number>;
  readonly status: CatalogSearchStatus;
  readonly library: LibrarySearchView | null;
}

export interface IPaletteSearch {
  subscribe(listener: () => void): () => void;
  snapshot(): PaletteSearchSnapshot;
  setQuery(query: string): void;
  setTab(tab: PaletteTab): void;
  chooseColor(code: number | null): void;
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
  private state: PaletteSearchSnapshot;

  constructor(
    @inject(PALETTE_CATALOG)
    private readonly catalog: Pick<IPaletteCatalog, "snapshot" | "subscribe">,
    @inject(CATALOG_SEARCH) private readonly catalogSearch: ICatalogSearch,
    @inject(PALETTE_MEMORY) private readonly memory: Pick<IPaletteMemory, "snapshot" | "subscribe">,
    @inject(LIBRARY_PART_SEARCH) private readonly library: ILibraryPartSearch,
  ) {
    this.state = this.searched();
    catalog.subscribe(() => this.reindexed());
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
    this.library.search(query, this.catalog.snapshot().offeredParts);
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

  private reindexed(): void {
    this.library.search(this.query, this.catalog.snapshot().offeredParts);
    this.update();
  }

  private update(): void {
    this.state = this.searched();
    for (const listener of this.listeners) listener();
  }

  private searched(): PaletteSearchSnapshot {
    const { query, tab, color } = this;
    const { index } = this.catalog.snapshot();
    const favorites = new Set(this.memory.snapshot().favorites);
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
    };
  }
}
