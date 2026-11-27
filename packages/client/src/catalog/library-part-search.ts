import { LIBRARY_PART_CATALOG, type ILibraryPartCatalog } from "@brr/catalog";
import { inject, injectable } from "inversify";
import { errorText } from "../edit/error-text.ts";
import {
  LibraryPartIndex,
  type LibraryPartHit,
  type LibraryPartView,
} from "./library-part-index.ts";
import { LibraryQuery } from "./library-query.ts";

export type LibrarySearchStatus = "off" | "idle" | "loading" | "ready" | "unavailable";

export interface LibrarySearchView {
  readonly query: string;
  readonly status: LibrarySearchStatus;
  readonly hits: ReadonlyArray<LibraryPartHit>;
  readonly total: number;
  readonly parts: number;
  readonly error: string | null;
}

export interface ILibraryPartSearch {
  view(): LibrarySearchView;
  subscribe(listener: () => void): () => void;
  search(query: LibraryQuery, excluded: ReadonlySet<string>): void;
  part(id: string): LibraryPartView | null;
}

export const LIBRARY_RESULT_LIMIT = 40;
const MIN_QUERY_LENGTH = 2;
const NOTHING_EXCLUDED: ReadonlySet<string> = new Set();

@injectable()
export class LibraryPartSearch implements ILibraryPartSearch {
  private readonly listeners = new Set<() => void>();
  private index: LibraryPartIndex | null = null;
  private loading: Promise<void> | null = null;
  private absent = false;
  private excluded = NOTHING_EXCLUDED;
  private query = LibraryQuery.parse("");
  private state: LibrarySearchView = {
    query: "",
    status: "idle",
    hits: [],
    total: 0,
    parts: 0,
    error: null,
  };

  constructor(@inject(LIBRARY_PART_CATALOG) private readonly catalog: ILibraryPartCatalog) {}

  view(): LibrarySearchView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  part(id: string): LibraryPartView | null {
    return this.index?.part(id) ?? null;
  }

  search(query: LibraryQuery, excluded: ReadonlySet<string>): void {
    const trimmed = query.text;
    if (trimmed === this.state.query && excluded === this.excluded) return;
    this.excluded = excluded;
    this.query = query;
    if (this.absent) {
      this.set({ ...this.state, query: trimmed, status: "off", hits: [], total: 0 });
      return;
    }
    if (trimmed.length < MIN_QUERY_LENGTH) {
      this.set({ ...this.state, query: trimmed, status: "idle", hits: [], total: 0 });
      return;
    }
    if (this.index !== null) {
      this.set(this.searched(this.index, query));
      return;
    }
    this.set({ ...this.state, query: trimmed, status: "loading", hits: [], total: 0, error: null });
    void this.load();
  }

  private load(): Promise<void> {
    this.loading ??= this.catalog.load().then(
      (list) => {
        this.loading = null;
        if (list === null) {
          this.absent = true;
          this.set({ ...this.state, status: "off", hits: [], total: 0 });
          return;
        }
        this.index = new LibraryPartIndex(list);
        this.set(this.searched(this.index, this.query));
      },
      (error: unknown) => {
        this.loading = null;
        this.set({
          ...this.state,
          status: "unavailable",
          hits: [],
          total: 0,
          error: errorText(error),
        });
      },
    );
    return this.loading;
  }

  private searched(index: LibraryPartIndex, query: LibraryQuery): LibrarySearchView {
    const { text } = query;
    if (text.length < MIN_QUERY_LENGTH) {
      return { query: text, status: "idle", hits: [], total: 0, parts: index.size, error: null };
    }
    const { hits, total } = index.search(query, LIBRARY_RESULT_LIMIT, this.excluded);
    return { query: text, status: "ready", hits, total, parts: index.size, error: null };
  }

  private set(next: LibrarySearchView): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
