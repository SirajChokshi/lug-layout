export interface CommentLocation {
  readonly line: number;
  readonly column: number;
}

function lineAndColumn(source: string, offset: number): CommentLocation {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function skipQuoted(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") i += 2;
    else if (ch === '"') return i + 1;
    else i++;
  }
  return i;
}

function rawStringEnd(source: string, start: number): number | undefined {
  let i = start;
  if (source[i] === "b") i++;
  if (source[i] !== "r") return undefined;
  i++;
  let hashes = 0;
  while (source[i] === "#") {
    hashes++;
    i++;
  }
  if (source[i] !== '"') return undefined;
  const terminator = `"${"#".repeat(hashes)}`;
  const end = source.indexOf(terminator, i + 1);
  return end === -1 ? source.length : end + terminator.length;
}

const CHAR_LITERAL = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/su;

function skipBlockComment(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    if (source.startsWith("/*", i)) {
      depth++;
      i += 2;
    } else if (source.startsWith("*/", i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else i++;
  }
  return i;
}

export function findRustComments(source: string): CommentLocation[] {
  const found: CommentLocation[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const previous = i > 0 ? source[i - 1] : "";
    const identifierBefore = previous !== undefined && /[A-Za-z0-9_]/u.test(previous);
    if (source.startsWith("//", i)) {
      found.push(lineAndColumn(source, i));
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
    } else if (source.startsWith("/*", i)) {
      found.push(lineAndColumn(source, i));
      i = skipBlockComment(source, i);
    } else if ((ch === "r" || ch === "b") && !identifierBefore && rawStringEnd(source, i)) {
      i = rawStringEnd(source, i) ?? i + 1;
    } else if (ch === '"') {
      i = skipQuoted(source, i);
    } else if (ch === "'") {
      const literal = CHAR_LITERAL.exec(source.slice(i, i + 12));
      i += literal ? literal[0].length : 1;
    } else {
      i++;
    }
  }
  return found;
}
