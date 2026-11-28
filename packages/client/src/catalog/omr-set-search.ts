import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import { inject, injectable } from "inversify";
import { errorText } from "../edit/error-text.ts";
import type { LibrarySearchStatus } from "./library-part-search.ts";
import { LibraryQuery } from "./library-query.ts";
import { OmrSetIndex, type OmrSetView } from "./omr-set-index.ts";

export interface OmrSetSearchView {
  readonly query: string;
  readonly status: LibrarySearchStatus;
  readonly hits: ReadonlyArray<OmrSetView>;
  readonly total: number;
  readonly sets: number;
  readonly modelled: number;
  readonly error: string | null;
}

export interface IOmrSetSearch {
  view(): OmrSetSearchView;
  subscribe(listener: () => void): () => void;
  search(query: LibraryQuery, offered: ReadonlySet<string>): void;
}

export const OMR_SET_RESULT_LIMIT = 12;
const MIN_QUERY_LENGTH = 2;
const SEARCH_LOD = "standard";
const NOTHING_OFFERED: ReadonlySet<string> = new Set();

@injectable()
export class OmrSetSearch implements IOmrSetSearch {
  private readonly listeners = new Set<() => void>();
  private index: OmrSetIndex | null = null;
  private loading: Promise<void> | null = null;
  private absent = false;
  private offered = NOTHING_OFFERED;
  private query = LibraryQuery.parse("");
  private state: OmrSetSearchView = {
    query: "",
    status: "idle",
    hits: [],
    total: 0,
    sets: 0,
    modelled: 0,
    error: null,
  };

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: Pick<IPartBundleLoader, "loadOmrSets">,
  ) {}

  view(): OmrSetSearchView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  search(query: LibraryQuery, offered: ReadonlySet<string>): void {
    if (query.text === this.state.query && offered === this.offered) return;
    this.offered = offered;
    this.query = query;
    if (this.absent) {
      this.set({ ...this.state, query: query.text, status: "off", hits: [], total: 0 });
    } else if (this.index !== null || query.text.length < MIN_QUERY_LENGTH) {
      this.set(this.searched());
    } else {
      this.set({ ...this.state, query: query.text, status: "loading", hits: [], total: 0 });
      void this.load();
    }
  }

  private load(): Promise<void> {
    this.loading ??= this.loader.loadOmrSets(SEARCH_LOD).then(
      (file) => {
        this.loading = null;
        if (file === null) {
          this.absent = true;
          this.set({ ...this.state, status: "off", hits: [], total: 0 });
          return;
        }
        this.index = new OmrSetIndex(file);
        this.set(this.searched());
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

  private searched(): OmrSetSearchView {
    const { text } = this.query;
    const { index } = this;
    const sizes = { sets: index?.size ?? 0, modelled: index?.modelled ?? 0 };
    if (index === null || text.length < MIN_QUERY_LENGTH) {
      return { query: text, status: "idle", hits: [], total: 0, ...sizes, error: null };
    }
    const { hits, total } = index.search(this.query, OMR_SET_RESULT_LIMIT, this.offered);
    return { query: text, status: "ready", hits, total, ...sizes, error: null };
  }

  private set(next: OmrSetSearchView): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
