import * as v from "valibot";

export const RELEASE_ID_HEX_DIGITS = 16;
export const RELEASE_ID_PATTERN = `[0-9a-f]{${RELEASE_ID_HEX_DIGITS}}`;
export const MAX_THEME_ID_DIGITS = 9;
export const MIN_QUERY_CHARACTERS = 3;
export const MIN_PREFIX_LETTERS = 3;
export const SEARCH_KINDS = ["set", "module", "part"] as const;

const MAX_QUERY_WORDS = 8;
const MAX_WORD_LETTERS = 40;
const SEARCH_LIMIT = { fallback: "20", max: 50 } as const;
const THEME_PAGE_LIMIT = { fallback: "50", max: 100 } as const;
const THEME_MAX_OFFSET = 10_000;
const queryWord = /[\p{L}\p{N}]+/gu;

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));
const Integer = v.pipe(v.number(), v.integer());
const Text = v.string();
const Url = v.pipe(v.string(), v.url());

function boundedInteger(fallback: string, min: number, max: number) {
  return v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9]{1,6}$/u, `must be an integer from ${min} to ${max}`),
      v.transform(Number),
      v.minValue(min, `must be an integer from ${min} to ${max}`),
      v.maxValue(max, `must be an integer from ${min} to ${max}`),
    ),
    fallback,
  );
}

export const ReleaseId = v.pipe(
  v.string(),
  v.regex(new RegExp(`^${RELEASE_ID_PATTERN}$`, "u"), "is not a catalog release id"),
);
export type ReleaseId = v.InferOutput<typeof ReleaseId>;

export const SetNumber = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u, "has unexpected characters"),
);
export type SetNumber = v.InferOutput<typeof SetNumber>;

export const ThemeId = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(10 ** MAX_THEME_ID_DIGITS - 1, `must have at most ${MAX_THEME_ID_DIGITS} digits`),
);
export type ThemeId = v.InferOutput<typeof ThemeId>;

export const SearchKind = v.picklist(SEARCH_KINDS);
export type SearchKind = v.InferOutput<typeof SearchKind>;

export const SearchParams = v.object({
  q: v.pipe(
    v.optional(v.string(), ""),
    v.trim(),
    v.minGraphemes(
      MIN_QUERY_CHARACTERS,
      `must be at least ${MIN_QUERY_CHARACTERS} characters after trimming spaces`,
    ),
    v.transform((query) => query.normalize("NFKC").toLowerCase().match(queryWord) ?? []),
    v.minLength(1, "must contain at least one letter or digit"),
    v.maxLength(MAX_QUERY_WORDS, `must have at most ${MAX_QUERY_WORDS} words`),
    v.check(
      (words) => words.every((word) => word.length <= MAX_WORD_LETTERS),
      `must not have a word longer than ${MAX_WORD_LETTERS} characters`,
    ),
  ),
  kind: v.pipe(
    v.optional(v.string(), ""),
    v.transform((kinds) =>
      kinds === "" ? [...SEARCH_KINDS] : kinds.split(",").map((kind) => kind.trim()),
    ),
    v.array(v.picklist(SEARCH_KINDS, `must be a comma list of ${SEARCH_KINDS.join(", ")}`)),
    v.transform((kinds) => SEARCH_KINDS.filter((kind) => kinds.includes(kind))),
  ),
  limit: boundedInteger(SEARCH_LIMIT.fallback, 1, SEARCH_LIMIT.max),
});
export type SearchParams = v.InferOutput<typeof SearchParams>;

export const ThemePageParams = v.object({
  limit: boundedInteger(THEME_PAGE_LIMIT.fallback, 1, THEME_PAGE_LIMIT.max),
  offset: boundedInteger("0", 0, THEME_MAX_OFFSET),
});
export type ThemePageParams = v.InferOutput<typeof ThemePageParams>;

const ThemeRef = v.object({ id: Integer, path: v.string(), href: Url });

export const SetSummary = v.object({
  id: v.string(),
  kind: v.picklist(["set", "module"]),
  name: v.string(),
  year: v.nullable(Integer),
  numParts: v.nullable(Count),
  theme: v.nullable(ThemeRef),
  author: v.nullable(v.string()),
  footprint: v.nullable(v.string()),
  tags: v.array(v.string()),
  href: Url,
});
export type SetSummary = v.InferOutput<typeof SetSummary>;

export const PartSummary = v.object({ id: v.string(), name: v.string(), category: v.string() });
export type PartSummary = v.InferOutput<typeof PartSummary>;

export const ThemeNode = v.object({
  id: Integer,
  name: v.string(),
  path: v.string(),
  parentId: v.nullable(Integer),
  setCount: Count,
  moduleCount: Count,
  href: Url,
});
export type ThemeNode = v.InferOutput<typeof ThemeNode>;

export const ReleaseCounts = v.object({
  sets: Count,
  modules: Count,
  themes: Count,
  parts: Count,
  colors: Count,
  minifigs: Count,
  inventoryLots: Count,
  inventoryMinifigs: Count,
});
export type ReleaseCounts = v.InferOutput<typeof ReleaseCounts>;

export const ReleaseResponse = v.object({
  release: v.object({
    id: ReleaseId,
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    bytes: Count,
    source: v.string(),
    loadedAt: v.pipe(v.string(), v.isoTimestamp()),
    counts: ReleaseCounts,
    attribution: v.string(),
    links: v.object({ self: Url, search: Url, themes: Url, sqlite: Url }),
  }),
});
export type ReleaseResponse = v.InferOutput<typeof ReleaseResponse>;

export const SearchResponse = v.object({
  release: ReleaseId,
  query: v.string(),
  results: v.object({
    set: v.optional(v.array(SetSummary)),
    module: v.optional(v.array(SetSummary)),
    part: v.optional(v.array(PartSummary)),
  }),
});
export type SearchResponse = v.InferOutput<typeof SearchResponse>;

export const InventoryLot = v.object({
  part: v.object({ id: v.string(), name: v.string() }),
  color: v.object({
    id: Integer,
    name: v.nullable(v.string()),
    rgb: v.nullable(v.string()),
    isTransparent: v.boolean(),
  }),
  quantity: Count,
  isSpare: v.boolean(),
});
export type InventoryLot = v.InferOutput<typeof InventoryLot>;

export const InventoryMinifig = v.object({
  id: v.string(),
  name: v.string(),
  numParts: v.nullable(Count),
  quantity: Count,
});
export type InventoryMinifig = v.InferOutput<typeof InventoryMinifig>;

export const InventoryResponse = v.object({
  release: ReleaseId,
  set: v.object({ ...SetSummary.entries, description: v.nullable(v.string()) }),
  totals: v.object({ lots: Count, parts: Count, spareLots: Count, minifigs: Count }),
  lots: v.array(InventoryLot),
  minifigs: v.array(InventoryMinifig),
});
export type InventoryResponse = v.InferOutput<typeof InventoryResponse>;

export const ThemeRootsResponse = v.object({ release: ReleaseId, themes: v.array(ThemeNode) });
export type ThemeRootsResponse = v.InferOutput<typeof ThemeRootsResponse>;

export const ThemePageResponse = v.object({
  release: ReleaseId,
  theme: ThemeNode,
  children: v.array(ThemeNode),
  sets: v.array(SetSummary),
  page: v.object({ limit: Count, offset: Count, total: Count, next: v.nullable(Url) }),
});
export type ThemePageResponse = v.InferOutput<typeof ThemePageResponse>;

export const ErrorResponse = v.object({ error: v.string() });
export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;

export const ThemeRow = v.object({
  id: Integer,
  name: Text,
  parent_id: v.nullable(Integer),
  path: Text,
  set_count: Integer,
  module_count: Integer,
});
export type ThemeRow = v.InferOutput<typeof ThemeRow>;

export const SetRow = v.object({
  id: Integer,
  set_num: Text,
  name: Text,
  year: v.nullable(Integer),
  theme_id: v.nullable(Integer),
  num_parts: v.nullable(Integer),
  kind: Integer,
  author: v.nullable(Text),
  description: v.nullable(Text),
  tags: v.nullable(Text),
  footprint: v.nullable(Text),
});
export type SetRow = v.InferOutput<typeof SetRow>;

export const ColorRow = v.object({
  id: Integer,
  name: Text,
  rgb: v.nullable(Text),
  is_trans: v.nullable(Integer),
});
export type ColorRow = v.InferOutput<typeof ColorRow>;

export const PartCategoryRow = v.object({ id: Integer, name: Text });
export type PartCategoryRow = v.InferOutput<typeof PartCategoryRow>;

export const PartRow = v.object({
  id: Integer,
  part_num: Text,
  name: Text,
  cat_id: v.nullable(Integer),
  material: v.nullable(Text),
});
export type PartRow = v.InferOutput<typeof PartRow>;

export const MinifigRow = v.object({
  id: Integer,
  fig_num: Text,
  name: Text,
  num_parts: v.nullable(Integer),
});
export type MinifigRow = v.InferOutput<typeof MinifigRow>;

export const InventoryPartRow = v.object({
  inventory_id: Integer,
  part_id: Integer,
  color_id: Integer,
  is_spare: Integer,
  quantity: Integer,
});
export type InventoryPartRow = v.InferOutput<typeof InventoryPartRow>;

export const InventoryMinifigRow = v.object({
  inventory_id: Integer,
  minifig_id: Integer,
  quantity: Integer,
});
export type InventoryMinifigRow = v.InferOutput<typeof InventoryMinifigRow>;

export const ReleaseRow = v.object({
  id: ReleaseId,
  sha256: Text,
  bytes: Integer,
  object_key: Text,
  source: Text,
  loaded_at: Text,
  counts: Text,
});
export type ReleaseRow = v.InferOutput<typeof ReleaseRow>;

export const CurrentReleaseRow = v.object({ slot: v.literal("current"), release_id: ReleaseId });
export type CurrentReleaseRow = v.InferOutput<typeof CurrentReleaseRow>;

export const CatalogRelease = v.object({
  ...ReleaseRow.entries,
  counts: v.pipe(v.string(), v.parseJson(), ReleaseCounts),
});
export type CatalogRelease = v.InferOutput<typeof CatalogRelease>;
