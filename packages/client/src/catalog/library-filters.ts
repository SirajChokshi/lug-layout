import { decode } from "@brr/schema/decode";
import {
  LIBRARY_FILTERS_VERSION,
  LibraryFilters as LibraryFiltersRecord,
  type LibraryFilter,
  type LibraryFilterScope,
} from "@brr/schema/palette";
import { injectable } from "inversify";
import { PALETTE_TABS, type PaletteTab } from "./palette-index.ts";

export type { LibraryFilter, LibraryFilterScope } from "@brr/schema/palette";

export const NO_FILTER: LibraryFilter = { query: "", color: null };

function isPaletteTab(tab: string): tab is PaletteTab {
  return (PALETTE_TABS as ReadonlyArray<string>).includes(tab);
}

function isEmptyFilter(filter: LibraryFilter): boolean {
  return filter.query === "" && filter.color === null;
}

function sameFilter(a: LibraryFilter, b: LibraryFilter): boolean {
  return a.query === b.query && a.color === b.color;
}

export class LibraryFilters {
  static readonly DEFAULT = new LibraryFilters("shared", "all", NO_FILTER, new Map());

  private constructor(
    readonly scope: LibraryFilterScope,
    readonly tab: PaletteTab,
    private readonly shared: LibraryFilter,
    private readonly perTab: ReadonlyMap<PaletteTab, LibraryFilter>,
  ) {}

  static fromRecord(record: LibraryFiltersRecord): LibraryFilters {
    const perTab = new Map<PaletteTab, LibraryFilter>();
    for (const [tab, filter] of Object.entries(record.tabs)) {
      if (isPaletteTab(tab) && !isEmptyFilter(filter)) perTab.set(tab, filter);
    }
    return new LibraryFilters(
      record.scope,
      isPaletteTab(record.tab) ? record.tab : "all",
      record.shared,
      perTab,
    );
  }

  current(): LibraryFilter {
    return this.filterOf(this.tab);
  }

  filterOf(tab: PaletteTab): LibraryFilter {
    if (this.scope === "shared") return this.shared;
    return this.perTab.get(tab) ?? NO_FILTER;
  }

  filtered(tab: PaletteTab): boolean {
    return !isEmptyFilter(this.filterOf(tab));
  }

  withTab(tab: PaletteTab): LibraryFilters {
    if (tab === this.tab) return this;
    return new LibraryFilters(this.scope, tab, this.shared, this.perTab);
  }

  withQuery(query: string): LibraryFilters {
    return this.withCurrent({ ...this.current(), query });
  }

  withColor(color: number | null): LibraryFilters {
    return this.withCurrent({ ...this.current(), color });
  }

  withScope(scope: LibraryFilterScope): LibraryFilters {
    if (scope === this.scope) return this;
    const shown = this.current();
    if (scope === "shared") return new LibraryFilters(scope, this.tab, shown, this.perTab);
    return new LibraryFilters(scope, this.tab, this.shared, this.withTabFilter(shown));
  }

  toRecord(): LibraryFiltersRecord {
    return {
      version: LIBRARY_FILTERS_VERSION,
      scope: this.scope,
      tab: this.tab,
      shared: this.shared,
      tabs: Object.fromEntries(this.perTab),
    };
  }

  private withCurrent(filter: LibraryFilter): LibraryFilters {
    if (sameFilter(filter, this.current())) return this;
    if (this.scope === "shared") {
      return new LibraryFilters(this.scope, this.tab, filter, this.perTab);
    }
    return new LibraryFilters(this.scope, this.tab, this.shared, this.withTabFilter(filter));
  }

  private withTabFilter(filter: LibraryFilter): ReadonlyMap<PaletteTab, LibraryFilter> {
    const perTab = new Map(this.perTab);
    if (isEmptyFilter(filter)) perTab.delete(this.tab);
    else perTab.set(this.tab, filter);
    return perTab;
  }
}

export function readLibraryFilters(raw: string | null): LibraryFilters {
  if (raw === null) return LibraryFilters.DEFAULT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return LibraryFilters.DEFAULT;
  }
  const decoded = decode(LibraryFiltersRecord, parsed);
  return decoded.ok ? LibraryFilters.fromRecord(decoded.value) : LibraryFilters.DEFAULT;
}

export interface ILibraryFilterStore {
  load(): LibraryFilters;
  save(filters: LibraryFilters): void;
}

const STORAGE_KEY = "brr.library-filters";

function storedLibraryFilters(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

@injectable()
export class LocalStorageLibraryFilterStore implements ILibraryFilterStore {
  load(): LibraryFilters {
    return readLibraryFilters(storedLibraryFilters());
  }

  save(filters: LibraryFilters): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(filters.toRecord()));
    } catch {
      return;
    }
  }
}
