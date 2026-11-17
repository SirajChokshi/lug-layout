import type { CatalogColorView, CatalogItemView } from "../edit/editor.ts";

export type PaletteCategory = "track" | "baseplates" | "road" | "mils" | "sets";
export type PaletteFilter = PaletteCategory | "all";

export const PALETTE_CATEGORIES: ReadonlyArray<PaletteCategory> = [
  "track",
  "baseplates",
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
  readonly kindWords: ReadonlyArray<string>;
  readonly leadWord: string | undefined;
}

interface TokenMatch {
  readonly score: number;
  readonly colors: ReadonlySet<number> | null;
}

const EXACT_NUMBER = 120;
const EXACT_WORD = 100;
const LEAD_WORD_BONUS = 10;
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
};

export const CATEGORY_LABEL: Readonly<Record<PaletteCategory, string>> = {
  track: "Track",
  baseplates: "Baseplates",
  road: "Road",
  mils: "MILS modules",
  sets: "Sets",
};

const KIND_WORDS: Readonly<Record<PaletteCategory, string>> = {
  track: "track rail train",
  baseplates: "baseplate plate ground",
  road: "road plate street",
  mils: "mils module",
  sets: "set model",
};

export function colorDisplayName(name: string): string {
  return name.replaceAll("_", " ");
}

export interface PaletteColorChoice {
  readonly color: CatalogColorView;
  readonly parts: number;
}

const HEX_RGB = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu;
const GREY_SATURATION = 0.12;
const NEAR_BLACK = 0.18;
const NEAR_WHITE = 0.95;
const DEGREES = 360;
const HEXTET = 255;

interface Hsl {
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
}

function hslOf(rgb: string): Hsl {
  const match = HEX_RGB.exec(rgb);
  if (!match) return { hue: 0, saturation: 0, lightness: 0 };
  const channel = (group: number): number => parseInt(match[group] ?? "0", 16) / HEXTET;
  const red = channel(1);
  const green = channel(2);
  const blue = channel(3);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  let sector: number;
  if (max === red) sector = ((green - blue) / chroma + 6) % 6;
  else if (max === green) sector = (blue - red) / chroma + 2;
  else sector = (red - green) / chroma + 4;
  return { hue: (sector * DEGREES) / 6, saturation, lightness };
}

function isNeutral({ saturation, lightness }: Hsl): boolean {
  return saturation < GREY_SATURATION || lightness < NEAR_BLACK || lightness > NEAR_WHITE;
}

interface ColorKey {
  readonly code: number;
  readonly neutral: boolean;
  readonly hue: number;
  readonly lightness: number;
}

function colorKey(color: CatalogColorView): ColorKey {
  const hsl = hslOf(color.rgb);
  return { code: color.code, neutral: isNeutral(hsl), hue: hsl.hue, lightness: hsl.lightness };
}

function byColorKey(a: ColorKey, b: ColorKey): number {
  if (a.neutral !== b.neutral) return a.neutral ? 1 : -1;
  if (a.neutral) return b.lightness - a.lightness || a.code - b.code;
  return a.hue - b.hue || b.lightness - a.lightness || a.code - b.code;
}

function colorRanks(items: ReadonlyArray<CatalogItemView>): ReadonlyMap<number, number> {
  const keys = new Map<number, ColorKey>();
  for (const { color } of items) {
    if (color && !keys.has(color.code)) keys.set(color.code, colorKey(color));
  }
  return new Map([...keys.values()].toSorted(byColorKey).map((key, rank) => [key.code, rank]));
}

export function itemInColor(entry: PaletteEntry, code: number): CatalogItemView | undefined {
  return entry.items.find((item) => item.color?.code === code);
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

const HAS_DIGIT = /\d/u;

function wordScore(token: string, word: string, exact: number): number {
  if (word === token) return exact;
  if (word.startsWith(token)) return PREFIX;
  if (HAS_DIGIT.test(token)) return 0;
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

function exactOrPrefixScore(token: string, words: ReadonlyArray<string>): number {
  let best = 0;
  for (const word of words) {
    if (word === token) return EXACT_WORD;
    if (word.startsWith(token)) best = PREFIX;
  }
  return best;
}

function kindWordScore(token: string, words: ReadonlyArray<string>): number {
  if (words.includes(token)) return PREFIX;
  return words.some((word) => word.startsWith(token)) ? SUBSTRING : 0;
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

function termWords(term: QueryTerm): ReadonlyArray<string> {
  switch (term.kind) {
    case "word":
      return [term.word];
    case "phrase":
      return term.words;
    case "number":
      return [term.number];
    default: {
      const unhandled: never = term;
      throw new Error(`unhandled query term ${String(unhandled)}`);
    }
  }
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
  private readonly ranks: ReadonlyMap<number, number>;
  private readonly colorVocabulary: ReadonlyArray<string>;
  private readonly colorTokenCache = new Map<string, boolean>();
  private readonly entryCache = new Map<PaletteFilter, ReadonlyArray<PaletteEntry>>();
  private readonly choiceCache = new Map<PaletteFilter, ReadonlyArray<PaletteColorChoice>>();

  constructor(items: ReadonlyArray<CatalogItemView>, extraTerms: ReadonlyArray<PaletteTerms> = []) {
    const extra = new Map<string, string[]>();
    for (const { entryKey, terms } of extraTerms) {
      extra.set(entryKey, [...(extra.get(entryKey) ?? []), ...terms]);
    }
    this.ranks = colorRanks(items);
    const rankOf = (item: CatalogItemView): number =>
      item.color ? (this.ranks.get(item.color.code) ?? 0) : 0;
    const sorted = groupEntries(items).map((entry) => ({
      ...entry,
      items: entry.items.toSorted((a, b) => rankOf(a) - rankOf(b)),
    }));
    this.indexed = sorted.map((entry, order) => {
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
          ...(first?.aliases ?? []).map(normalized),
          ...words.filter((word) => /^\d/u.test(word) && !isLatticeSize(word)),
        ],
        words,
        phrases,
        leadWord: wordsOf(entry.title).find(
          (word) => entry.partNumber === null || word !== normalized(entry.partNumber),
        ),
        colorWords: entry.items.map((item) =>
          item.color ? [...withSpellings(wordsOf(item.color.name)), ...item.elements] : [],
        ),
        kindWords: wordsOf(KIND_WORDS[entry.category]),
      };
    });
    this.colorVocabulary = [
      ...new Set(this.indexed.flatMap((indexed) => indexed.colorWords.flat())),
    ].filter((word) => !HAS_DIGIT.test(word));
  }

  private isColorWordOrPrefix(token: string): boolean {
    const known = this.colorTokenCache.get(token);
    if (known !== undefined) return known;
    const found = this.colorVocabulary.some((word) => word.startsWith(token));
    this.colorTokenCache.set(token, found);
    return found;
  }

  private colorScore(token: string, words: ReadonlyArray<string>): number {
    return this.isColorWordOrPrefix(token)
      ? exactOrPrefixScore(token, words)
      : bestScore(token, words, EXACT_WORD);
  }

  entries(filter: PaletteFilter): ReadonlyArray<PaletteEntry> {
    const cached = this.entryCache.get(filter);
    if (cached) return cached;
    const entries = this.indexed
      .map(({ entry }) => entry)
      .filter((entry) => filter === "all" || entry.category === filter);
    this.entryCache.set(filter, entries);
    return entries;
  }

  defaultItem(
    items: ReadonlyArray<CatalogItemView>,
    current: number | null,
  ): CatalogItemView | undefined {
    const first = items[0];
    if (!first) return undefined;
    const common = this.commonestColor(CATEGORY_OF[first.kind]);
    return (
      items.find((item) => item.color !== null && item.color.code === current) ??
      items.find((item) => item.displayColor) ??
      items.find((item) => item.color !== null && item.color.code === common) ??
      first
    );
  }

  private commonestColor(category: PaletteCategory): number | null {
    let best: PaletteColorChoice | null = null;
    for (const choice of this.colorChoices(category)) {
      if (!best || choice.parts > best.parts) best = choice;
    }
    return best ? best.color.code : null;
  }

  colorChoices(filter: PaletteFilter): ReadonlyArray<PaletteColorChoice> {
    const cached = this.choiceCache.get(filter);
    if (cached) return cached;
    const counts = new Map<number, { color: CatalogColorView; parts: number }>();
    for (const entry of this.entries(filter)) {
      for (const { color } of entry.items) {
        if (!color) continue;
        const choice = counts.get(color.code);
        if (choice) choice.parts++;
        else counts.set(color.code, { color, parts: 1 });
      }
    }
    const rank = (code: number): number => this.ranks.get(code) ?? 0;
    const choices = [...counts.values()].toSorted(
      (a, b) => rank(a.color.code) - rank(b.color.code),
    );
    this.choiceCache.set(filter, choices);
    return choices;
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
    const colorTokens: string[] = [];
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
        if (colors) {
          kept = kept.filter((i) => colors.has(i));
          colorTokens.push(...termWords(term));
        }
      }
      if (kept.length === 0) return null;
    }
    if (colorTokens.length > 0) {
      const unnamed = (i: number): number =>
        (indexed.colorWords[i] ?? []).filter(
          (word) => !HAS_DIGIT.test(word) && !colorTokens.some((token) => word.startsWith(token)),
        ).length;
      kept = kept.toSorted((a, b) => unnamed(a) - unnamed(b));
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
                strictScore(term.word, indexed.kindWords),
                strictScore(term.word, indexed.numbers),
              ),
              (words) => strictScore(term.word, words),
            )
          : this.bestOf(
              indexed,
              Math.max(
                bestScore(term.word, indexed.numbers, EXACT_NUMBER),
                bestScore(term.word, indexed.words, EXACT_WORD) +
                  (indexed.leadWord === term.word ? LEAD_WORD_BONUS : 0),
                kindWordScore(term.word, indexed.kindWords),
              ),
              (words) => this.colorScore(term.word, words),
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
