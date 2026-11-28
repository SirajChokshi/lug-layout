import type { LibraryPartList } from "@brr/catalog";
import type { LibraryQuery, QueryTerm } from "./library-query.ts";
import type { CatalogColorView } from "./placeable-catalog.ts";
import {
  normalizedSearchText,
  phraseScore,
  searchWords,
  spaced,
  textScore,
  withSpellings,
} from "./search-text.ts";

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

interface Ranked {
  readonly part: number;
  readonly score: number;
  readonly colors: ReadonlyArray<CatalogColorView>;
}

interface ColorText {
  readonly words: string;
  readonly phrase: string;
}

const EXACT_NUMBER = 8;
const PREFIX_NUMBER = 6;
const EXACT_TITLE_WORD = 5;
const EXACT_TAG = 4;
const PREFIX_TITLE_WORD = 3;
const PREFIX_TAG = 1;
const PRODUCED_COLOR = EXACT_TITLE_WORD;
const LEAD_WORD = 1;
const LATTICE_SIZE = /^(\d+)x(\d+)$/u;
const SPACE = " ";
const PHRASE_BREAK = "|";
const CATALOG_NUMBER_KEYWORD = /^(?:bricklink|rebrickable)\s+(\S+)$/iu;

function keywordNumber(keyword: string): string | null {
  return CATALOG_NUMBER_KEYWORD.exec(keyword.trim())?.[1] ?? null;
}

function withSwappedSizes(words: ReadonlyArray<string>): ReadonlyArray<string> {
  return words.flatMap((word) => {
    const size = LATTICE_SIZE.exec(word);
    return size && size[1] !== size[2] ? [word, `${size[2]}x${size[1]}`] : [word];
  });
}

export class LibraryPartIndex {
  private readonly parts: ReadonlyArray<LibraryPartView>;
  private readonly titleText: ReadonlyArray<string>;
  private readonly tagText: ReadonlyArray<string>;
  private readonly titlePhrase: ReadonlyArray<string>;
  private readonly tagPhrase: ReadonlyArray<string>;
  private readonly numberText: ReadonlyArray<string>;
  private readonly leadWord: ReadonlyArray<string>;
  private readonly titleWords: Uint16Array;
  private readonly colorText = new Map<number, ColorText>();
  private readonly byId = new Map<string, number>();

  constructor({ file, colors }: LibraryPartList) {
    const colorViews = new Map<number, CatalogColorView>();
    for (const color of colors) {
      colorViews.set(color.code, { code: color.code, name: color.name, rgb: color.rgb });
      const words = searchWords(color.name);
      this.colorText.set(color.code, {
        words: spaced(withSpellings(words)),
        phrase: spaced(words),
      });
    }
    const { id, title, category, keywords, rebrickable, colorCount } = file.parts;
    const parts: LibraryPartView[] = [];
    const titleText: string[] = [];
    const tagText: string[] = [];
    const titlePhrase: string[] = [];
    const tagPhrase: string[] = [];
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
      const tags = [
        searchWords(part.category),
        ...ownKeywords.filter((keyword) => keywordNumber(keyword) === null).map(searchWords),
      ];
      parts.push(part);
      titleText.push(spaced(withSpellings(withSwappedSizes(ownTitle))));
      tagText.push(spaced(withSpellings(withSwappedSizes(tags.flat()))));
      titlePhrase.push(spaced(ownTitle));
      tagPhrase.push(tags.map(spaced).join(PHRASE_BREAK));
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
    this.titlePhrase = titlePhrase;
    this.tagPhrase = tagPhrase;
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

  search(query: LibraryQuery, limit: number, excluded: ReadonlySet<string>): LibraryPartMatches {
    if (!query.includesAnything) return { hits: [], total: 0 };
    const ranked: Ranked[] = [];
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part === undefined || excluded.has(part.id)) continue;
      const match = this.match(i, part, query.terms);
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

  private ownScore(index: number, term: QueryTerm): number {
    switch (term.kind) {
      case "word":
        return Math.max(
          textScore(this.numberText[index] ?? "", term.word, EXACT_NUMBER, PREFIX_NUMBER),
          textScore(this.titleText[index] ?? "", term.word, EXACT_TITLE_WORD, PREFIX_TITLE_WORD),
          textScore(this.tagText[index] ?? "", term.word, EXACT_TAG, PREFIX_TAG),
        );
      case "number":
        return textScore(this.numberText[index] ?? "", term.number, EXACT_NUMBER, PREFIX_NUMBER);
      case "phrase":
        return Math.max(
          phraseScore(
            this.titlePhrase[index] ?? "",
            term.words,
            EXACT_TITLE_WORD,
            PREFIX_TITLE_WORD,
          ),
          phraseScore(this.tagPhrase[index] ?? "", term.words, EXACT_TAG, PREFIX_TAG),
        );
      default: {
        const unhandled: never = term;
        throw new Error(`unhandled query term ${String(unhandled)}`);
      }
    }
  }

  private names(color: CatalogColorView, term: QueryTerm): boolean {
    const text = this.colorText.get(color.code);
    if (text === undefined) return false;
    switch (term.kind) {
      case "word":
        return text.words.includes(`${SPACE}${term.word}`);
      case "phrase":
        return text.phrase.includes(`${SPACE}${term.words.join(SPACE)}`);
      case "number":
        return false;
      default: {
        const unhandled: never = term;
        throw new Error(`unhandled query term ${String(unhandled)}`);
      }
    }
  }

  private match(
    index: number,
    part: LibraryPartView,
    terms: ReadonlyArray<QueryTerm>,
  ): Ranked | null {
    let score = 0;
    let ownMatches = 0;
    let colors = part.colors;
    for (const term of terms) {
      const own = this.ownScore(index, term);
      const named = colors.filter((color) => this.names(color, term));
      if (term.negated) {
        if (own > 0) return null;
        colors = colors.filter((color) => !named.includes(color));
      } else if (named.length > 0) {
        colors = named;
        score += Math.max(own, PRODUCED_COLOR);
        if (own > 0) ownMatches++;
      } else if (own > 0) {
        const lead = term.kind === "word" && this.leadWord[index] === term.word;
        score += own + (lead ? LEAD_WORD : 0);
        ownMatches++;
      } else {
        return null;
      }
      if (colors.length === 0) return null;
    }
    return ownMatches === 0 ? null : { part: index, score, colors };
  }
}
