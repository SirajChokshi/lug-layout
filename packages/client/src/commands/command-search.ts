import type { CatalogItemView } from "../edit/editor.ts";
import { COMMANDS, type CommandId, type CommandSpec } from "./editor-commands.ts";

export interface CommandResult {
  readonly kind: "command";
  readonly spec: CommandSpec;
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
  readonly recent: ReadonlyArray<string>;
  readonly enabled: (id: CommandId) => boolean;
}

const KIND_WORDS: Readonly<Record<CatalogItemView["kind"], string>> = {
  baseplate: "baseplate plate ground",
  "road-plate": "road plate street",
  "mils-module": "mils module",
  model: "set model",
  brick: "brick plate tile jumper part",
  track: "track rail train",
};

const TITLE_START_SCORE = 6;
const TITLE_WORD_SCORE = 4;
const WORD_SCORE = 3;
const INSIDE_SCORE = 1;
const RECENT_BONUS = 2;
const DISABLED_PENALTY = 3;
const RESULT_LIMIT = 60;
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

function itemExtra(item: CatalogItemView): string {
  return [
    item.color?.name ?? "",
    item.groupLabel,
    KIND_WORDS[item.kind],
    `${item.studsWide}x${item.studsDeep}`,
    item.id,
  ].join(" ");
}

function commandExtra(spec: CommandSpec): string {
  return `${spec.group} ${spec.keywords ?? ""}`;
}

interface Scored {
  readonly result: PaletteResult;
  readonly score: number;
  readonly title: string;
}

function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title);
}

function browse(sources: PaletteSources): ReadonlyArray<PaletteResult> {
  const recent = sources.recent.flatMap((id): ItemResult[] => {
    const item = sources.catalog.find((entry) => entry.id === id);
    return item ? [{ kind: "item", item, recent: true }] : [];
  });
  const commands = COMMANDS.map((spec): CommandResult => ({
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

export function searchPalette(
  query: string,
  sources: PaletteSources,
): ReadonlyArray<PaletteResult> {
  const words = normalized(query)
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return browse(sources);
  const scored: Scored[] = [];
  for (const spec of COMMANDS) {
    const score = matchScore(words, spec.title, commandExtra(spec));
    if (score === 0) continue;
    const enabled = sources.enabled(spec.id);
    scored.push({
      result: { kind: "command", spec, enabled },
      score: enabled ? score : score - DISABLED_PENALTY,
      title: spec.title,
    });
  }
  for (const item of sources.catalog) {
    const score = matchScore(words, item.label, itemExtra(item));
    if (score === 0) continue;
    const recent = sources.recent.includes(item.id);
    scored.push({
      result: { kind: "item", item, recent },
      score: recent ? score + RECENT_BONUS : score,
      title: item.label,
    });
  }
  return scored
    .toSorted(byScore)
    .slice(0, RESULT_LIMIT)
    .map((entry) => entry.result);
}
