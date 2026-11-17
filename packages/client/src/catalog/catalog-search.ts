import type { ICatalogApi } from "@brr/catalog";
import {
  BundleSearchParams,
  bundleManifestKeyOf,
  type BundleManifestKey,
  type BundleSearchHit,
} from "@brr/schema/catalog-api";
import { decode } from "@brr/schema/decode";

export type CatalogSearchStatus = "off" | "idle" | "searching" | "ready" | "offline";

export interface CatalogSearchView {
  readonly query: string;
  readonly status: CatalogSearchStatus;
  readonly hits: ReadonlyArray<BundleSearchHit>;
}

export interface ICatalogSearch {
  view(): CatalogSearchView;
  search(query: string): void;
  subscribe(listener: () => void): () => void;
}

export const CATALOG_SEARCH_DEBOUNCE_MS = 150;
const REMOTE_RESULT_LIMIT = "50";

export class CatalogSearch implements ICatalogSearch {
  private readonly manifestKey: BundleManifestKey | null;
  private readonly listeners = new Set<() => void>();
  private state: CatalogSearchView;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: ICatalogApi | null,
    manifestFile: string,
  ) {
    this.manifestKey = api === null ? null : bundleManifestKeyOf(manifestFile);
    this.state = { query: "", status: this.manifestKey === null ? "off" : "idle", hits: [] };
  }

  view(): CatalogSearchView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  search(query: string): void {
    const key = this.manifestKey;
    if (key === null) return;
    const trimmed = query.trim();
    if (trimmed === this.state.query) return;
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
    if (!decode(BundleSearchParams, { q: trimmed }).ok) {
      this.set({ query: trimmed, status: "idle", hits: [] });
      return;
    }
    this.set({ query: trimmed, status: "searching", hits: [] });
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.ask(key, trimmed);
    }, CATALOG_SEARCH_DEBOUNCE_MS);
  }

  private async ask(key: BundleManifestKey, query: string): Promise<void> {
    const api = this.api;
    if (api === null) return;
    let next: CatalogSearchView;
    try {
      const response = await api.searchBundle(key, { q: query, limit: REMOTE_RESULT_LIMIT });
      next = { query, status: "ready", hits: response.results };
    } catch {
      next = { query, status: "offline", hits: [] };
    }
    if (this.state.query === query) this.set(next);
  }

  private set(next: CatalogSearchView): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
