import type { LibraryPartList } from "@brr/catalog";
import type { CatalogColorView } from "./placeable-catalog.ts";
import { normalizedSearchText, searchWords, withSpellings } from "./search-text.ts";

export interface LibraryPartView {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly rebrickable: string;
  readonly colors: ReadonlyArray<CatalogColorView>;
}

export interface LibraryPartHit {
  readonly part: LibraryPartView;
  readonly colors: ReadonlyArray<CatalogColorView>;
}

export interface LibraryPartMatches {
  readonly hits: ReadonlyArray<LibraryPartHit>;
  readonly total: number;
}

interface QueryWord {
  readonly word: string;
  readonly negated: boolean;
}

interface Ranked {
  readonly part: number;
  readonly score: number;
  readonly colors: ReadonlyArray<CatalogColorView>;
}

const EXACT_NUMBER = 8;
const PREFIX_NUMBER = 6;
const EXACT_TITLE_WORD = 5;
const EXACT_TAG = 4;
const PREFIX_TITLE_WORD = 3;
const PREFIX_TAG = 1;
const PRODUCED_COLOR = EXACT_TITLE_WORD;
const LEAD_WORD = 1;
const NEGATION = "-";
const LATTICE_SIZE = /^(\d+)x(\d+)$/u;
const UNFINISHED_SIZE = /(\d+)\s*[x×]\s*$/u;
const QUERY_PUNCTUATION = /["#]/gu;
const WHITESPACE = /\s+/u;
const SPACE = " ";
const CATALOG_NUMBER_KEYWORD = /^(?:bricklink|rebrickable)\s+(\S+)$/iu;

function spaced(words: ReadonlyArray<string>): string {
  return `${SPACE}${words.join(SPACE)}${SPACE}`;
}

function keywordNumber(keyword: string): string | null {
  return CATALOG_NUMBER_KEYWORD.exec(keyword.trim())?.[1] ?? null;
}

function withSwappedSizes(words: ReadonlyArray<string>): ReadonlyArray<string> {
  return words.flatMap((word) => {
    const size = LATTICE_SIZE.exec(word);
    return size && size[1] !== size[2] ? [word, `${size[2]}x${size[1]}`] : [word];
  });
}

function queryWords(query: string): ReadonlyArray<QueryWord> {
  return normalizedSearchText(query)
    .replace(UNFINISHED_SIZE, "$1x")
    .replace(QUERY_PUNCTUATION, SPACE)
    .split(WHITESPACE)
    .flatMap((token) => {
      const negated = token.startsWith(NEGATION);
      return searchWords(negated ? token.slice(NEGATION.length) : token).map((word) => ({
        word,
        negated,
      }));
    });
}

function textScore(text: string, word: string, exact: number, prefix: number): number {
  if (text.includes(`${SPACE}${word}${SPACE}`)) return exact;
  return text.includes(`${SPACE}${word}`) ? prefix : 0;
}

export class LibraryPartIndex {
  private readonly parts: ReadonlyArray<LibraryPartView>;
  private readonly titleText: ReadonlyArray<string>;
  private readonly tagText: ReadonlyArray<string>;
  private readonly numberText: ReadonlyArray<string>;
  private readonly leadWord: ReadonlyArray<string>;
  private readonly titleWords: Uint16Array;
  private readonly colorText = new Map<number, string>();
  private readonly byId = new Map<string, number>();

  constructor({ file, colors }: LibraryPartList) {
    const colorViews = new Map<number, CatalogColorView>();
    for (const color of colors) {
      colorViews.set(color.code, { code: color.code, name: color.name, rgb: color.rgb });
      this.colorText.set(color.code, spaced(withSpellings(searchWords(color.name))));
    }
    const { id, title, category, keywords, rebrickable, colorCount } = file.parts;
    const parts: LibraryPartView[] = [];
    const titleText: string[] = [];
    const tagText: string[] = [];
    const numberText: string[] = [];
    const leadWord: string[] = [];
    this.titleWords = new Uint16Array(id.length);
    let colorAt = 0;
    for (let i = 0; i < id.length; i++) {
      const count = colorCount[i] ?? 0;
      const produced = file.parts.colors
        .slice(colorAt, colorAt + count)
        .flatMap((code) => colorViews.get(code) ?? []);
      colorAt += count;
      const part: LibraryPartView = {
        id: id[i] ?? "",
        title: (title[i] ?? "").replace(/\s+/gu, SPACE).trim(),
        category: file.categories[category[i] ?? 0] ?? "",
        rebrickable: rebrickable[i] ?? "",
        colors: produced,
      };
      const ownTitle = searchWords(part.title);
      const ownKeywords = keywords[i] ?? [];
      const keywordNumbers = ownKeywords.flatMap((keyword) => keywordNumber(keyword) ?? []);
      parts.push(part);
      titleText.push(spaced(withSpellings(withSwappedSizes(ownTitle))));
      tagText.push(
        spaced(
          withSpellings(
            withSwappedSizes([
              ...searchWords(part.category),
              ...ownKeywords
                .filter((keyword) => keywordNumber(keyword) === null)
                .flatMap(searchWords),
            ]),
          ),
        ),
      );
      numberText.push(
        spaced([part.id, part.rebrickable, ...keywordNumbers].map(normalizedSearchText)),
      );
      leadWord.push(ownTitle[0] ?? "");
      this.titleWords[i] = ownTitle.length;
      this.byId.set(part.id, i);
    }
    this.parts = parts;
    this.titleText = titleText;
    this.tagText = tagText;
    this.numberText = numberText;
    this.leadWord = leadWord;
  }

  get size(): number {
    return this.parts.length;
  }

  part(id: string): LibraryPartView | undefined {
    const index = this.byId.get(id);
    return index === undefined ? undefined : this.parts[index];
  }

  search(query: string, limit: number, excluded: ReadonlySet<string>): LibraryPartMatches {
    const words = queryWords(query);
    if (!words.some((word) => !word.negated)) return { hits: [], total: 0 };
    const ranked: Ranked[] = [];
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part === undefined || excluded.has(part.id)) continue;
      const match = this.match(i, part, words);
      if (match !== null) ranked.push(match);
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        (this.titleWords[a.part] ?? 0) - (this.titleWords[b.part] ?? 0) ||
        a.part - b.part,
    );
    return {
      hits: ranked.slice(0, limit).flatMap(({ part, colors }) => {
        const view = this.parts[part];
        return view ? [{ part: view, colors }] : [];
      }),
      total: ranked.length,
    };
  }

  private match(
    index: number,
    part: LibraryPartView,
    words: ReadonlyArray<QueryWord>,
  ): Ranked | null {
    let score = 0;
    let ownMatches = 0;
    let colors = part.colors;
    for (const { word, negated } of words) {
      const own = Math.max(
        textScore(this.numberText[index] ?? "", word, EXACT_NUMBER, PREFIX_NUMBER),
        textScore(this.titleText[index] ?? "", word, EXACT_TITLE_WORD, PREFIX_TITLE_WORD),
        textScore(this.tagText[index] ?? "", word, EXACT_TAG, PREFIX_TAG),
      );
      const named = colors.filter((color) =>
        (this.colorText.get(color.code) ?? "").includes(`${SPACE}${word}`),
      );
      if (negated) {
        if (own > 0) return null;
        colors = colors.filter((color) => !named.includes(color));
      } else if (named.length > 0) {
        colors = named;
        score += Math.max(own, PRODUCED_COLOR);
        if (own > 0) ownMatches++;
      } else if (own > 0) {
        score += own + (this.leadWord[index] === word ? LEAD_WORD : 0);
        ownMatches++;
      } else {
        return null;
      }
      if (colors.length === 0) return null;
    }
    return ownMatches === 0 ? null : { part: index, score, colors };
  }
}
