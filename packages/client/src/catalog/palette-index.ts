import type { CatalogItemView } from "../edit/editor.ts";

export type PaletteCategory = "track" | "baseplates" | "bricks" | "road" | "mils" | "sets";
export type PaletteFilter = PaletteCategory | "all";

export const PALETTE_CATEGORIES: ReadonlyArray<PaletteCategory> = [
  "track",
  "baseplates",
  "bricks",
  "road",
  "mils",
  "sets",
];

export interface PaletteEntry {
  readonly key: string;
  readonly category: PaletteCategory;
  readonly title: string;
  readonly partNumber: string | null;
  readonly size: string;
  readonly items: ReadonlyArray<CatalogItemView>;
}

export interface PaletteHit {
  readonly entry: PaletteEntry;
  readonly items: ReadonlyArray<CatalogItemView>;
  readonly score: number;
}

export interface PaletteTerms {
  readonly entryKey: string;
  readonly terms: ReadonlyArray<string>;
}

interface IndexedEntry {
  readonly entry: PaletteEntry;
  readonly order: number;
  readonly numbers: ReadonlyArray<string>;
  readonly words: ReadonlyArray<string>;
  readonly phrases: ReadonlyArray<ReadonlyArray<string>>;
  readonly colorWords: ReadonlyArray<ReadonlyArray<string>>;
}

interface TokenMatch {
  readonly score: number;
  readonly colors: ReadonlySet<number> | null;
}

const EXACT_NUMBER = 120;
const EXACT_WORD = 100;
const PREFIX = 80;
const SUBSTRING = 50;
const SUBSEQUENCE = 30;
const TYPO = 25;
const MIN_SUBSTRING = 2;
const MIN_SUBSEQUENCE = 3;
const ONE_TYPO_FROM = 4;
const TWO_TYPOS_FROM = 8;
const SIZE_PATTERN = /(\d+)\s*[x×]\s*(\d+)/gu;
const SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["grey", "gray"],
  ["gray", "grey"],
  ["colour", "color"],
  ["color", "colour"],
]);

const CATEGORY_OF: Readonly<Record<CatalogItemView["kind"], PaletteCategory>> = {
  track: "track",
  baseplate: "baseplates",
  "road-plate": "road",
  "mils-module": "mils",
  model: "sets",
  brick: "bricks",
};

export const CATEGORY_LABEL: Readonly<Record<PaletteCategory, string>> = {
  track: "Track",
  baseplates: "Baseplates",
  bricks: "Bricks",
  road: "Road",
  mils: "MILS modules",
  sets: "Sets",
};

export function colorDisplayName(name: string): string {
  return name.replaceAll("_", " ");
}

function normalized(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(SIZE_PATTERN, "$1x$2");
}

function wordsOf(text: string): ReadonlyArray<string> {
  return normalized(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

function withSpellings(words: ReadonlyArray<string>): ReadonlyArray<string> {
  return words.flatMap((word) => {
    const other = SPELLINGS.get(word);
    return other ? [word, other] : [word];
  });
}

function partNumberOf(group: string): string | null {
  const colon = group.indexOf(":");
  if (colon < 0) return null;
  const namespace = group.slice(0, colon);
  return namespace === "ldraw" ? group.slice(colon + 1) : null;
}

function isSubsequence(token: string, word: string): boolean {
  if (word[0] !== token[0]) return false;
  let at = 0;
  for (const char of word) {
    if (char === token[at]) at++;
    if (at === token.length) return true;
  }
  return false;
}

function editDistanceWithin(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let cost = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, (previous2[j - 2] ?? 0) + 1);
      }
      current.push(cost);
      rowMin = Math.min(rowMin, cost);
    }
    if (rowMin > limit) return false;
    previous2 = previous;
    previous = current;
  }
  return (previous[b.length] ?? limit + 1) <= limit;
}

function typoLimit(token: string): number {
  if (token.length >= TWO_TYPOS_FROM) return 2;
  return token.length >= ONE_TYPO_FROM ? 1 : 0;
}

function wordScore(token: string, word: string, exact: number): number {
  if (word === token) return exact;
  if (word.startsWith(token)) return PREFIX;
  if (token.length >= MIN_SUBSTRING && word.includes(token)) return SUBSTRING;
  if (token.length >= MIN_SUBSEQUENCE && isSubsequence(token, word)) return SUBSEQUENCE;
  const limit = typoLimit(token);
  if (limit > 0) {
    const prefix = word.slice(0, token.length);
    if (editDistanceWithin(token, word, limit) || editDistanceWithin(token, prefix, limit)) {
      return TYPO;
    }
  }
  return 0;
}

function bestScore(token: string, words: ReadonlyArray<string>, exact: number): number {
  let best = 0;
  for (const word of words) best = Math.max(best, wordScore(token, word, exact));
  return best;
}

function bestNumberScore(token: string, numbers: ReadonlyArray<string>): number {
  if (numbers.includes(token)) return EXACT_NUMBER;
  return numbers.some((number) => number.startsWith(token)) ? PREFIX : 0;
}

function sizeWords(item: CatalogItemView): ReadonlyArray<string> {
  if (item.studsWide === 0 || item.studsDeep === 0) return [];
  return [`${item.studsWide}x${item.studsDeep}`, `${item.studsDeep}x${item.studsWide}`];
}

function groupEntries(items: ReadonlyArray<CatalogItemView>): ReadonlyArray<PaletteEntry> {
  const entries = new Map<string, PaletteEntry>();
  for (const item of items) {
    const existing = entries.get(item.group);
    if (existing) {
      entries.set(item.group, { ...existing, items: [...existing.items, item] });
      continue;
    }
    entries.set(item.group, {
      key: item.group,
      category: CATEGORY_OF[item.kind],
      title: item.groupLabel,
      partNumber: partNumberOf(item.group),
      size: item.studsWide > 0 ? `${item.studsWide}×${item.studsDeep}` : "",
      items: [item],
    });
  }
  return [...entries.values()];
}

type QueryTerm =
  | { readonly kind: "word"; readonly word: string; readonly negated: boolean }
  | { readonly kind: "phrase"; readonly words: ReadonlyArray<string>; readonly negated: boolean }
  | { readonly kind: "number"; readonly number: string; readonly negated: boolean };

const QUERY_TERM = /(-?)(?:"([^"]*)"?|#(\S+)|(\S+))/gu;

function parseQuery(query: string): ReadonlyArray<QueryTerm> {
  const terms: QueryTerm[] = [];
  for (const [, minus, phrase, number, plain] of normalized(query).matchAll(QUERY_TERM)) {
    const negated = minus === "-";
    if (phrase !== undefined) {
      const words = wordsOf(phrase);
      if (words.length > 0) terms.push({ kind: "phrase", words, negated });
    } else if (number !== undefined) {
      for (const word of wordsOf(number)) terms.push({ kind: "number", number: word, negated });
    } else if (plain !== undefined) {
      for (const word of wordsOf(plain)) terms.push({ kind: "word", word, negated });
    }
  }
  return terms;
}

function phraseScore(phrase: ReadonlyArray<string>, words: ReadonlyArray<string>): number {
  const last = phrase.length - 1;
  for (let start = 0; start + phrase.length <= words.length; start++) {
    const matches = phrase.every((word, i) => {
      const candidate = words[start + i] ?? "";
      return i === last ? candidate.startsWith(word) : candidate === word;
    });
    if (matches) return EXACT_WORD * phrase.length;
  }
  return 0;
}

function strictScore(token: string, words: ReadonlyArray<string>): number {
  return words.some((word) => word.startsWith(token)) ? PREFIX : 0;
}

function isLatticeSize(word: string): boolean {
  return /^\d+x\d+$/u.test(word);
}

export class PaletteIndex {
  private readonly indexed: ReadonlyArray<IndexedEntry>;

  constructor(items: ReadonlyArray<CatalogItemView>, extraTerms: ReadonlyArray<PaletteTerms> = []) {
    const extra = new Map<string, string[]>();
    for (const { entryKey, terms } of extraTerms) {
      extra.set(entryKey, [...(extra.get(entryKey) ?? []), ...terms]);
    }
    this.indexed = groupEntries(items).map((entry, order) => {
      const phrases = [entry.title, CATEGORY_LABEL[entry.category], ...(extra.get(entry.key) ?? [])]
        .map(wordsOf)
        .map(withSpellings);
      const first = entry.items[0];
      const words = [...phrases.flat(), ...(first ? sizeWords(first) : [])];
      return {
        entry,
        order,
        numbers: [
          ...(entry.partNumber === null ? [] : [normalized(entry.partNumber)]),
          ...words.filter((word) => /^\d/u.test(word) && !isLatticeSize(word)),
        ],
        words,
        phrases,
        colorWords: entry.items.map((item) =>
          item.color ? withSpellings(wordsOf(item.color.name)) : [],
        ),
      };
    });
  }

  entries(filter: PaletteFilter): ReadonlyArray<PaletteEntry> {
    return this.indexed
      .map(({ entry }) => entry)
      .filter((entry) => filter === "all" || entry.category === filter);
  }

  search(query: string, filter: PaletteFilter): ReadonlyArray<PaletteHit> {
    const terms = parseQuery(query);
    const pool = this.indexed.filter(({ entry }) => filter === "all" || entry.category === filter);
    if (terms.length === 0) {
      return pool.map(({ entry }) => ({ entry, items: entry.items, score: 0 }));
    }
    const hits: Array<PaletteHit & { readonly order: number }> = [];
    for (const indexed of pool) {
      const hit = this.match(indexed, terms);
      if (hit) hits.push({ ...hit, order: indexed.order });
    }
    return hits
      .toSorted((a, b) => b.score - a.score || a.order - b.order)
      .map(({ entry, items, score }) => ({ entry, items, score }));
  }

  private match(indexed: IndexedEntry, terms: ReadonlyArray<QueryTerm>): PaletteHit | null {
    const { entry } = indexed;
    let score = 0;
    let kept = entry.items.map((_, i) => i);
    for (const term of terms) {
      const matched = this.matchTerm(indexed, term);
      if (term.negated) {
        if (matched && !matched.colors) return null;
        const colors = matched?.colors;
        if (colors) kept = kept.filter((i) => !colors.has(i));
      } else {
        if (!matched) return null;
        score += matched.score;
        const colors = matched.colors;
        if (colors) kept = kept.filter((i) => colors.has(i));
      }
      if (kept.length === 0) return null;
    }
    return { entry, items: kept.flatMap((i) => entry.items[i] ?? []), score };
  }

  private matchTerm(indexed: IndexedEntry, term: QueryTerm): TokenMatch | null {
    switch (term.kind) {
      case "number": {
        const score = term.negated
          ? strictScore(term.number, indexed.numbers)
          : bestNumberScore(term.number, indexed.numbers);
        return score > 0 ? { score, colors: null } : null;
      }
      case "phrase":
        return this.bestOf(
          indexed,
          Math.max(...indexed.phrases.map((words) => phraseScore(term.words, words))),
          (words) => phraseScore(term.words, words),
        );
      case "word":
        return term.negated
          ? this.bestOf(
              indexed,
              Math.max(
                strictScore(term.word, indexed.words),
                strictScore(term.word, indexed.numbers),
              ),
              (words) => strictScore(term.word, words),
            )
          : this.bestOf(
              indexed,
              Math.max(
                bestScore(term.word, indexed.numbers, EXACT_NUMBER),
                bestScore(term.word, indexed.words, EXACT_WORD),
              ),
              (words) => bestScore(term.word, words, EXACT_WORD),
            );
      default: {
        const unhandled: never = term;
        throw new Error(`unhandled query term ${String(unhandled)}`);
      }
    }
  }

  private bestOf(
    indexed: IndexedEntry,
    entryScore: number,
    colorScoreOf: (words: ReadonlyArray<string>) => number,
  ): TokenMatch | null {
    let colorScore = 0;
    const colors = new Set<number>();
    indexed.colorWords.forEach((words, i) => {
      const score = colorScoreOf(words);
      if (score === 0) return;
      if (score > colorScore) {
        colorScore = score;
        colors.clear();
      }
      if (score === colorScore) colors.add(i);
    });
    if (entryScore === 0 && colorScore === 0) return null;
    if (entryScore >= colorScore) return { score: entryScore, colors: null };
    return { score: colorScore, colors };
  }
}
