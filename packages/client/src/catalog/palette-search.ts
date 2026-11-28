import { inject, injectable } from "inversify";
import type { CatalogItemView } from "./placeable-catalog.ts";
import {
  CATALOG_SEARCH,
  LIBRARY_FILTER_STORE,
  LIBRARY_PART_SEARCH,
  PALETTE_CATALOG,
  PALETTE_MEMORY,
} from "../tokens.ts";
import type { CatalogSearchStatus, ICatalogSearch } from "./catalog-search.ts";
import type { ILibraryFilterStore, LibraryFilterScope, LibraryFilters } from "./library-filters.ts";
import type { ILibraryPartSearch, LibrarySearchView } from "./library-part-search.ts";
import { LibraryQuery } from "./library-query.ts";
import type { IPaletteCatalog } from "./palette-catalog.ts";
import type { IPaletteMemory } from "./palette-memory.ts";
import {
  PALETTE_CATEGORIES,
  PALETTE_TABS,
  itemInColor,
  type PaletteCategory,
  type PaletteColorChoice,
  type PaletteEntry,
  type PaletteIndex,
  type PaletteTab,
} from "./palette-index.ts";
import { paletteResults } from "./palette-results.ts";

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
  readonly searching: boolean;
  readonly tab: PaletteTab;
  readonly scope: LibraryFilterScope;
  readonly filteredTabs: ReadonlySet<PaletteTab>;
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
  setScope(scope: LibraryFilterScope): void;
}

type FavoriteTest = (hit: { readonly entry: PaletteEntry }) => boolean;

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

function localCount(
  index: PaletteIndex,
  tab: PaletteTab,
  query: LibraryQuery,
  isFavorite: FavoriteTest,
): number {
  if (tab === "favorites") return index.search(query, "all").filter(isFavorite).length;
  return index.search(query, tab).length;
}

@injectable()
export class PaletteSearch implements IPaletteSearch {
  private readonly listeners = new Set<() => void>();
  private filters: LibraryFilters;
  private state: PaletteSearchSnapshot;

  constructor(
    @inject(PALETTE_CATALOG)
    private readonly catalog: Pick<IPaletteCatalog, "snapshot" | "subscribe">,
    @inject(CATALOG_SEARCH) private readonly catalogSearch: ICatalogSearch,
    @inject(PALETTE_MEMORY) private readonly memory: Pick<IPaletteMemory, "snapshot" | "subscribe">,
    @inject(LIBRARY_PART_SEARCH) private readonly library: ILibraryPartSearch,
    @inject(LIBRARY_FILTER_STORE) private readonly store: ILibraryFilterStore,
  ) {
    this.filters = store.load();
    this.state = this.searched();
    catalog.subscribe(() => this.reindexed());
    catalogSearch.subscribe(() => this.update());
    memory.subscribe(() => this.update());
    library.subscribe(() => this.update());
    if (this.filters.current().query !== "") this.searchSources();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PaletteSearchSnapshot {
    return this.state;
  }

  setQuery(query: string): void {
    this.change(this.filters.withQuery(query));
  }

  setTab(tab: PaletteTab): void {
    this.change(this.filters.withTab(tab));
  }

  chooseColor(code: number | null): void {
    this.change(this.filters.withColor(code));
  }

  setScope(scope: LibraryFilterScope): void {
    this.change(this.filters.withScope(scope));
  }

  private change(next: LibraryFilters): void {
    if (next === this.filters) return;
    const queryBefore = this.filters.current().query;
    this.filters = next;
    this.store.save(next);
    if (next.current().query !== queryBefore) this.searchSources();
    this.update();
  }

  private currentQuery(): LibraryQuery {
    return LibraryQuery.parse(this.filters.current().query);
  }

  private searchSources(): void {
    const query = this.currentQuery();
    this.catalogSearch.search(query.remoteText);
    this.library.search(query, this.catalog.snapshot().offeredParts);
  }

  private reindexed(): void {
    this.library.search(this.currentQuery(), this.catalog.snapshot().offeredParts);
    this.update();
  }

  private update(): void {
    this.state = this.searched();
    for (const listener of this.listeners) listener();
  }

  private searched(): PaletteSearchSnapshot {
    const { filters } = this;
    const { tab, scope } = filters;
    const { query, color } = filters.current();
    const parsed = LibraryQuery.parse(query);
    const { index } = this.catalog.snapshot();
    const favorites = new Set(this.memory.snapshot().favorites);
    const isFavorite: FavoriteTest = (hit) => favorites.has(hit.entry.key);
    const results = paletteResults(
      index,
      parsed,
      tab === "favorites" ? "all" : tab,
      this.catalogSearch.view(),
    );
    const searching = !parsed.isEmpty;
    let hits = searching ? results.hits : [];
    if (tab === "favorites") hits = results.hits.filter(isFavorite);
    const shownCounts = new Map<PaletteTab, number>([
      ...results.counts,
      ["favorites", localCount(index, "favorites", parsed, isFavorite)],
    ]);
    return {
      query,
      searching,
      tab,
      scope,
      filteredTabs: new Set(
        scope === "per-tab" ? PALETTE_TABS.filter((option) => filters.filtered(option)) : [],
      ),
      color,
      sections: shownCategories(tab).map((category) => section(index, category, color)),
      hits: hits.map(({ entry, items }) => {
        const chosen = index.defaultItem(items, color);
        return { entry, items, chosen, preview: chosen };
      }),
      counts: scope === "shared" ? shownCounts : this.perTabCounts(index, shownCounts, isFavorite),
      status: results.status,
      library: tab === "all" ? this.library.view() : null,
    };
  }

  private perTabCounts(
    index: PaletteIndex,
    shown: ReadonlyMap<PaletteTab, number>,
    isFavorite: FavoriteTest,
  ): ReadonlyMap<PaletteTab, number> {
    return new Map(
      PALETTE_TABS.map((option) => {
        if (option === this.filters.tab) return [option, shown.get(option) ?? 0];
        const query = LibraryQuery.parse(this.filters.filterOf(option).query);
        return [option, localCount(index, option, query, isFavorite)];
      }),
    );
  }
}
