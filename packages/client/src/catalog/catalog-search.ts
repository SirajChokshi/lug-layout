import type { ICatalogApi, IPartBundleLoader } from "@brr/catalog";
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
  private manifestKey: Promise<BundleManifestKey | null> | undefined;
  private readonly listeners = new Set<() => void>();
  private state: CatalogSearchView;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: ICatalogApi | null,
    private readonly bundle: Pick<IPartBundleLoader, "loadManifestFile">,
  ) {
    this.state = { query: "", status: api === null ? "off" : "idle", hits: [] };
  }

  view(): CatalogSearchView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  search(query: string): void {
    if (this.state.status === "off") return;
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
      void this.ask(trimmed);
    }, CATALOG_SEARCH_DEBOUNCE_MS);
  }

  private loadedManifestKey(): Promise<BundleManifestKey | null> {
    this.manifestKey ??= this.bundle.loadManifestFile().then(bundleManifestKeyOf);
    return this.manifestKey;
  }

  private async ask(query: string): Promise<void> {
    const api = this.api;
    if (api === null) return;
    let next: CatalogSearchView;
    try {
      const key = await this.loadedManifestKey();
      if (key === null) {
        this.set({ query, status: "off", hits: [] });
        return;
      }
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
