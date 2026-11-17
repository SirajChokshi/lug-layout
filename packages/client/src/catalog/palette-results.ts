import type { BundleSearchHit } from "@brr/schema/catalog-api";
import type { CatalogItemView } from "../edit/editor.ts";
import type { CatalogSearchStatus, CatalogSearchView } from "./catalog-search.ts";
import {
  PALETTE_CATEGORIES,
  type PaletteEntry,
  type PaletteFilter,
  type PaletteHit,
  type PaletteIndex,
} from "./palette-index.ts";

export interface PaletteResults {
  readonly hits: ReadonlyArray<PaletteHit>;
  readonly counts: ReadonlyMap<PaletteFilter, number>;
  readonly remoteOnly: ReadonlyArray<BundleSearchHit>;
  readonly status: CatalogSearchStatus;
}

interface Located {
  readonly entry: PaletteEntry;
  readonly item: CatalogItemView;
}

function locate(index: PaletteIndex): ReadonlyMap<string, Located> {
  const byId = new Map<string, Located>();
  for (const entry of index.entries("all")) {
    for (const item of entry.items) byId.set(item.id, { entry, item });
  }
  return byId;
}

function merged(
  local: ReadonlyArray<PaletteHit>,
  remote: ReadonlyArray<BundleSearchHit>,
  byId: ReadonlyMap<string, Located>,
): {
  readonly hits: ReadonlyArray<PaletteHit>;
  readonly remoteOnly: ReadonlyArray<BundleSearchHit>;
} {
  const hits = new Map<string, PaletteHit>(local.map((hit) => [hit.entry.key, hit]));
  const remoteOnly: BundleSearchHit[] = [];
  for (const hit of remote) {
    const located = byId.get(hit.id);
    if (located === undefined) {
      remoteOnly.push(hit);
      continue;
    }
    const existing = hits.get(located.entry.key);
    if (existing?.items.some((item) => item.id === hit.id)) continue;
    hits.set(located.entry.key, {
      entry: located.entry,
      items: [...(existing?.items ?? []), located.item],
      score: existing?.score ?? 0,
    });
  }
  return { hits: [...hits.values()], remoteOnly };
}

function inFilter(category: PaletteFilter, filter: PaletteFilter): boolean {
  return filter === "all" || category === filter;
}

export function paletteResults(
  index: PaletteIndex,
  query: string,
  filter: PaletteFilter,
  remote: CatalogSearchView,
): PaletteResults {
  const current = remote.query === query.trim();
  const all = merged(index.search(query, "all"), current ? remote.hits : [], locate(index));
  const counts = new Map<PaletteFilter, number>([
    ["all", all.hits.length],
    ...PALETTE_CATEGORIES.map(
      (category) =>
        [category, all.hits.filter((hit) => hit.entry.category === category).length] as const,
    ),
  ]);
  return {
    hits: all.hits.filter((hit) => inFilter(hit.entry.category, filter)),
    counts,
    remoteOnly: all.remoteOnly.filter((hit) => inFilter(hit.section, filter)),
    status: current || remote.status === "off" ? remote.status : "idle",
  };
}
