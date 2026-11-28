const SIZE_PATTERN = /(\d+)\s*[x×]\s*(\d+)/gu;
const SPACE = " ";

export function normalizedSearchText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(SIZE_PATTERN, "$1x$2");
}

export function searchWords(text: string): ReadonlyArray<string> {
  return normalizedSearchText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

const SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["grey", "gray"],
  ["gray", "grey"],
  ["colour", "color"],
  ["color", "colour"],
]);

export function withSpellings(words: ReadonlyArray<string>): ReadonlyArray<string> {
  return words.flatMap((word) => {
    const other = SPELLINGS.get(word);
    return other ? [word, other] : [word];
  });
}

export function spaced(words: ReadonlyArray<string>): string {
  return `${SPACE}${words.join(SPACE)}${SPACE}`;
}

export function textScore(text: string, word: string, exact: number, prefix: number): number {
  if (text.includes(`${SPACE}${word}${SPACE}`)) return exact;
  return text.includes(`${SPACE}${word}`) ? prefix : 0;
}

export function phraseScore(
  text: string,
  words: ReadonlyArray<string>,
  exact: number,
  prefix: number,
): number {
  return textScore(text, words.join(SPACE), exact, prefix) * words.length;
}
