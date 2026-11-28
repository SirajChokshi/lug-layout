import { normalizedSearchText, searchWords } from "./search-text.ts";

export type QueryTerm =
  | { readonly kind: "word"; readonly word: string; readonly negated: boolean }
  | { readonly kind: "phrase"; readonly words: ReadonlyArray<string>; readonly negated: boolean }
  | { readonly kind: "number"; readonly number: string; readonly negated: boolean };

const QUERY_TERM = /([+-]?)(?:"([^"]*)"?|#(\S+)|(\S+))/gu;
const UNFINISHED_SIZE = /(\d+)\s*[x×]\s*$/u;
const EXCLUDE = "-";
const SPACE = " ";

export function termWords(term: QueryTerm): ReadonlyArray<string> {
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

function isConstraint(term: QueryTerm): boolean {
  return term.negated || term.kind !== "word";
}

function parsedTerms(text: string): ReadonlyArray<QueryTerm> {
  const terms: QueryTerm[] = [];
  const normalized = normalizedSearchText(text).replace(UNFINISHED_SIZE, "$1x");
  for (const [, sign, phrase, number, plain] of normalized.matchAll(QUERY_TERM)) {
    const negated = sign === EXCLUDE;
    if (phrase !== undefined) {
      const words = searchWords(phrase);
      if (words.length > 0) terms.push({ kind: "phrase", words, negated });
    } else if (number !== undefined) {
      for (const word of searchWords(number)) terms.push({ kind: "number", number: word, negated });
    } else if (plain !== undefined) {
      for (const word of searchWords(plain)) terms.push({ kind: "word", word, negated });
    }
  }
  return terms;
}

export class LibraryQuery {
  readonly constraints: ReadonlyArray<QueryTerm>;
  readonly remoteText: string;

  private constructor(
    readonly text: string,
    readonly terms: ReadonlyArray<QueryTerm>,
  ) {
    this.constraints = terms.filter(isConstraint);
    this.remoteText = terms
      .filter((term) => !term.negated)
      .flatMap(termWords)
      .join(SPACE);
  }

  static parse(text: string): LibraryQuery {
    const trimmed = text.trim();
    return new LibraryQuery(trimmed, parsedTerms(trimmed));
  }

  get isEmpty(): boolean {
    return this.terms.length === 0;
  }

  get includesAnything(): boolean {
    return this.terms.some((term) => !term.negated);
  }
}
