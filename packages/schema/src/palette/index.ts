import * as v from "valibot";

export const PALETTE_MEMORY_VERSION = 1;

export const PaletteMemory = v.strictObject({
  version: v.literal(PALETTE_MEMORY_VERSION),
  favorites: v.array(v.string()),
  recents: v.array(v.string()),
});
export type PaletteMemory = v.InferOutput<typeof PaletteMemory>;

export const LIBRARY_FILTERS_VERSION = 1;
export const LIBRARY_FILTER_SCOPES = ["shared", "per-tab"] as const;

export const LibraryFilterScope = v.picklist(LIBRARY_FILTER_SCOPES);
export type LibraryFilterScope = v.InferOutput<typeof LibraryFilterScope>;

export const LibraryFilter = v.strictObject({
  query: v.string(),
  color: v.nullable(v.pipe(v.number(), v.integer())),
});
export type LibraryFilter = v.InferOutput<typeof LibraryFilter>;

export const LibraryFilters = v.strictObject({
  version: v.literal(LIBRARY_FILTERS_VERSION),
  scope: LibraryFilterScope,
  tab: v.string(),
  shared: LibraryFilter,
  tabs: v.record(v.string(), LibraryFilter),
});
export type LibraryFilters = v.InferOutput<typeof LibraryFilters>;
