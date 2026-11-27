import type { CatalogSearchView } from "../catalog/catalog-search.ts";
import { LibraryQuery } from "../catalog/library-query.ts";
import type { PaletteIndex } from "../catalog/palette-index.ts";
import { workerHitsFor } from "../catalog/palette-results.ts";
import type { CatalogItemView } from "../catalog/placeable-catalog.ts";
import { COMMANDS, isHotbarCommand, type CommandId, type CommandSpec } from "./editor-commands.ts";

export interface PaletteCommandSpec extends CommandSpec {
  readonly id: Exclude<CommandId, "pick-slot">;
}

export interface CommandResult {
  readonly kind: "command";
  readonly spec: PaletteCommandSpec;
  readonly enabled: boolean;
}

export interface ItemResult {
  readonly kind: "item";
  readonly item: CatalogItemView;
  readonly recent: boolean;
}

export type PaletteResult = CommandResult | ItemResult;

export interface PaletteSources {
  readonly catalog: ReadonlyArray<CatalogItemView>;
  readonly index: PaletteIndex;
  readonly recent: ReadonlyArray<string>;
  readonly remote: CatalogSearchView;
  readonly enabled: (id: CommandId) => boolean;
}

const TITLE_START_SCORE = 110;
const TITLE_WORD_SCORE = 100;
const WORD_SCORE = 80;
const INSIDE_SCORE = 50;
const RECENT_BONUS = 20;
const DISABLED_PENALTY = 30;
const OTHER_COLOR_PENALTY = 5;
const RESULT_LIMIT = 60;
const LISTED = COMMANDS.filter((spec): spec is PaletteCommandSpec => !isHotbarCommand(spec.id));
const DIMENSION = /(\d)\s*[x×]\s*(\d)/gu;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

function normalized(text: string): string {
  return text.toLowerCase().replaceAll("_", " ").replace(DIMENSION, "$1x$2");
}

function startsWord(text: string, at: number): boolean {
  return at === 0 || !ALPHANUMERIC.test(text.charAt(at - 1));
}

function wordScore(word: string, title: string, haystack: string): number {
  if (title.startsWith(word)) return TITLE_START_SCORE;
  let best = 0;
  for (let at = haystack.indexOf(word); at >= 0; at = haystack.indexOf(word, at + 1)) {
    const inTitle = at < title.length;
    const score = startsWord(haystack, at)
      ? inTitle
        ? TITLE_WORD_SCORE
        : WORD_SCORE
      : INSIDE_SCORE;
    best = Math.max(best, score);
  }
  return best;
}

function matchScore(words: ReadonlyArray<string>, title: string, extra: string): number {
  const normalTitle = normalized(title);
  const haystack = `${normalTitle} ${normalized(extra)}`;
  let total = 0;
  for (const word of words) {
    const score = wordScore(word, normalTitle, haystack);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

function commandExtra(spec: CommandSpec): string {
  return `${spec.group} ${spec.keywords ?? ""}`;
}

interface Scored {
  readonly result: PaletteResult;
  readonly score: number;
  readonly order: number;
}

function titleLength(scored: Scored): number {
  return scored.result.kind === "command"
    ? scored.result.spec.title.length
    : Number.MAX_SAFE_INTEGER;
}

function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || titleLength(a) - titleLength(b) || a.order - b.order;
}

function itemsInHitOrder(
  index: PaletteIndex,
  items: ReadonlyArray<CatalogItemView>,
  narrowed: boolean,
): ReadonlyArray<CatalogItemView> {
  const preferred = narrowed ? items[0] : index.defaultItem(items, null);
  return preferred ? [preferred, ...items.filter((item) => item !== preferred)] : items;
}

function browse(sources: PaletteSources): ReadonlyArray<PaletteResult> {
  const recent = sources.recent.flatMap((id): ItemResult[] => {
    const item = sources.catalog.find((entry) => entry.id === id);
    return item ? [{ kind: "item", item, recent: true }] : [];
  });
  const commands = LISTED.map((spec): CommandResult => ({
    kind: "command",
    spec,
    enabled: sources.enabled(spec.id),
  }));
  return [
    ...recent,
    ...commands.filter((command) => command.enabled),
    ...commands.filter((command) => !command.enabled),
  ];
}

function serverItems(
  query: LibraryQuery,
  { remote, catalog, index, recent }: PaletteSources,
  listed: ReadonlyArray<PaletteResult>,
): ReadonlyArray<ItemResult> {
  const workerHits = workerHitsFor(query, remote);
  if (workerHits === null || workerHits.length === 0) return [];
  const shown = new Set(
    listed.flatMap((result) => (result.kind === "item" ? [result.item.id] : [])),
  );
  const byId = new Map(catalog.map((item) => [item.id, item]));
  return workerHits.flatMap((hit): ItemResult[] => {
    const item = byId.get(hit.id);
    if (item === undefined || shown.has(item.id) || !index.admits(item.id, query)) return [];
    return [{ kind: "item", item, recent: recent.includes(item.id) }];
  });
}

export function searchPalette(
  query: string,
  sources: PaletteSources,
): ReadonlyArray<PaletteResult> {
  const words = normalized(query)
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return browse(sources);
  const scored: Scored[] = [];
  for (const spec of LISTED) {
    const score = matchScore(words, spec.title, commandExtra(spec));
    if (score === 0) continue;
    const enabled = sources.enabled(spec.id);
    scored.push({
      result: { kind: "command", spec, enabled },
      score: enabled ? score : score - DISABLED_PENALTY,
      order: scored.length,
    });
  }
  const parsed = LibraryQuery.parse(query);
  for (const hit of sources.index.search(parsed, "all")) {
    const narrowed = hit.items.length < hit.entry.items.length;
    itemsInHitOrder(sources.index, hit.items, narrowed).forEach((item, variant) => {
      const recent = sources.recent.includes(item.id);
      const score = variant === 0 ? hit.score : hit.score - OTHER_COLOR_PENALTY;
      scored.push({
        result: { kind: "item", item, recent },
        score: recent ? score + RECENT_BONUS : score,
        order: scored.length,
      });
    });
  }
  const ranked = scored.toSorted(byScore).map((entry) => entry.result);
  return [...ranked, ...serverItems(parsed, sources, ranked)].slice(0, RESULT_LIMIT);
}
