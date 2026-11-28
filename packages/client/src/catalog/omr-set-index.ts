import type { OmrSetsFile } from "@brr/schema/bundle";
import { importRef } from "@brr/schema/world";
import type { LibraryQuery, QueryTerm } from "./library-query.ts";
import { phraseScore, searchWords, spaced, textScore } from "./search-text.ts";

export interface OmrModelView {
  readonly item: string;
  readonly file: string;
  readonly variant: string | null;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
}

export interface OmrSetView {
  readonly number: string;
  readonly name: string;
  readonly year: number;
  readonly theme: ReadonlyArray<string>;
  readonly parts: number;
  readonly models: ReadonlyArray<OmrModelView>;
}

export interface OmrSetMatches {
  readonly hits: ReadonlyArray<OmrSetView>;
  readonly total: number;
}

interface Ranked {
  readonly set: number;
  readonly score: number;
  readonly models: ReadonlyArray<OmrModelView>;
}

const EXACT_NUMBER = 8;
const PREFIX_NUMBER = 6;
const EXACT_NAME_WORD = 5;
const EXACT_TAG = 4;
const PREFIX_NAME_WORD = 3;
const PREFIX_TAG = 1;
const GITHUB_RAW = "https://raw.githubusercontent.com";
const MODEL_VARIANT = /^\d+-\d+[_.](.+)\.mpd$/u;
const MODEL_STEM = /\.mpd$/u;
const PALETTE_NAMESPACE = "omr:";

function variantOf(file: string): string | null {
  return MODEL_VARIANT.exec(file)?.[1]?.replaceAll("-", " ") ?? null;
}

function mirrorUrl({ repo, commit, root }: OmrSetsFile["mirror"], file: string): string {
  return [GITHUB_RAW, repo, commit, root, encodeURIComponent(file)].join("/");
}

export function omrPaletteItem(file: string): string {
  return `${PALETTE_NAMESPACE}${file.replace(MODEL_STEM, "")}`;
}

export class OmrSetIndex {
  private readonly sets: ReadonlyArray<OmrSetView>;
  private readonly numberText: ReadonlyArray<string>;
  private readonly nameText: ReadonlyArray<string>;
  private readonly tagText: ReadonlyArray<string>;
  private readonly nameWords: Uint16Array;
  readonly modelled: number;

  constructor(file: OmrSetsFile) {
    const { number, name, year, theme, parts } = file.sets;
    const models: OmrModelView[][] = number.map(() => []);
    file.models.file.forEach((modelFile, index) => {
      const sha256 = file.models.sha256[index] ?? "";
      models[file.models.set[index] ?? 0]?.push({
        item: importRef(sha256),
        file: modelFile,
        variant: variantOf(modelFile),
        sha256,
        bytes: file.models.bytes[index] ?? 0,
        url: mirrorUrl(file.mirror, modelFile),
      });
    });
    const sets: OmrSetView[] = [];
    const numberText: string[] = [];
    const nameText: string[] = [];
    const tagText: string[] = [];
    this.nameWords = new Uint16Array(number.length);
    for (let i = 0; i < number.length; i++) {
      const set: OmrSetView = {
        number: number[i] ?? "",
        name: name[i] ?? "",
        year: year[i] ?? 0,
        theme: file.themes[theme[i] ?? 0] ?? [],
        parts: parts[i] ?? 0,
        models: models[i] ?? [],
      };
      const ownName = searchWords(set.name);
      sets.push(set);
      numberText.push(spaced(searchWords(set.number)));
      nameText.push(spaced(ownName));
      tagText.push(
        spaced([
          String(set.year),
          ...set.theme.flatMap(searchWords),
          ...set.models.flatMap((model) => searchWords(model.variant ?? "")),
        ]),
      );
      this.nameWords[i] = ownName.length;
    }
    this.sets = sets;
    this.numberText = numberText;
    this.nameText = nameText;
    this.tagText = tagText;
    this.modelled = models.filter((own) => own.length > 0).length;
  }

  get size(): number {
    return this.sets.length;
  }

  search(query: LibraryQuery, limit: number, offered: ReadonlySet<string>): OmrSetMatches {
    if (!query.includesAnything) return { hits: [], total: 0 };
    const ranked: Ranked[] = [];
    for (let i = 0; i < this.sets.length; i++) {
      const set = this.sets[i];
      if (set === undefined) continue;
      const models = set.models.filter((model) => !offered.has(omrPaletteItem(model.file)));
      if (set.models.length > 0 && models.length === 0) continue;
      const score = this.score(i, query.terms);
      if (score > 0) ranked.push({ set: i, score, models });
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.models.length > 0) - Number(a.models.length > 0) ||
        (this.nameWords[a.set] ?? 0) - (this.nameWords[b.set] ?? 0) ||
        a.set - b.set,
    );
    return {
      hits: ranked.slice(0, limit).flatMap(({ set, models }) => {
        const view = this.sets[set];
        return view ? [{ ...view, models }] : [];
      }),
      total: ranked.length,
    };
  }

  private termScore(index: number, term: QueryTerm): number {
    const numbers = this.numberText[index] ?? "";
    const name = this.nameText[index] ?? "";
    const tags = this.tagText[index] ?? "";
    switch (term.kind) {
      case "word":
        return Math.max(
          textScore(numbers, term.word, EXACT_NUMBER, PREFIX_NUMBER),
          textScore(name, term.word, EXACT_NAME_WORD, PREFIX_NAME_WORD),
          textScore(tags, term.word, EXACT_TAG, PREFIX_TAG),
        );
      case "number":
        return textScore(numbers, term.number, EXACT_NUMBER, PREFIX_NUMBER);
      case "phrase":
        return Math.max(
          phraseScore(name, term.words, EXACT_NAME_WORD, PREFIX_NAME_WORD),
          phraseScore(tags, term.words, EXACT_TAG, PREFIX_TAG),
        );
      default: {
        const unhandled: never = term;
        throw new Error(`unhandled query term ${String(unhandled)}`);
      }
    }
  }

  private score(index: number, terms: ReadonlyArray<QueryTerm>): number {
    let score = 0;
    for (const term of terms) {
      const own = this.termScore(index, term);
      if (term.negated ? own > 0 : own === 0) return 0;
      score += own;
    }
    return score;
  }
}
