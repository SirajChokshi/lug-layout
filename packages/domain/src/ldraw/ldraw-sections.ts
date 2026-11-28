import { ldrawLines, normalizeLdrawReference } from "./ldraw-text.ts";

const META_LINE = "0";
const SUBFILE_LINE = "1";
const FILE_META = "FILE";
const NAME_META = "Name:";
const SUBFILE_REFERENCE_TOKEN = 14;
const SUBFILE_REFERENCE_START = new RegExp(
  String.raw`^\s*(?:\S+\s+){${SUBFILE_REFERENCE_TOKEN}}`,
  "u",
);
const NAME_META_START = /^\s*0\s+Name:\s*/u;

export interface LdrawSection {
  readonly name: string | null;
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
}

export interface LdrawSections {
  readonly sections: ReadonlyArray<LdrawSection>;
  readonly own: ReadonlySet<string>;
  readonly outside: ReadonlySet<string>;
}

function tokensOf(line: string): ReadonlyArray<string> {
  const trimmed = line.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/u);
}

function fileName(tokens: ReadonlyArray<string>): string | null {
  if (tokens[0] !== META_LINE || tokens[1]?.toUpperCase() !== FILE_META) return null;
  const name = tokens.slice(2).join(" ");
  return name === "" ? null : name;
}

export function subfileReference(line: string): string | null {
  const tokens = tokensOf(line);
  if (tokens[0] !== SUBFILE_LINE || tokens.length <= SUBFILE_REFERENCE_TOKEN) return null;
  return tokens.slice(SUBFILE_REFERENCE_TOKEN).join(" ");
}

export function ldrawSections(text: string): LdrawSections {
  const sections: Array<{ name: string | null; key: string; lines: string[] }> = [];
  for (const line of ldrawLines(text)) {
    const name = fileName(tokensOf(line));
    if (name !== null) {
      sections.push({ name, key: normalizeLdrawReference(name), lines: [] });
      continue;
    }
    if (sections.length === 0) sections.push({ name: null, key: "", lines: [] });
    sections.at(-1)?.lines.push(line);
  }
  const own = new Set(sections.flatMap((section) => (section.name === null ? [] : [section.key])));
  const outside = new Set<string>();
  for (const section of sections) {
    for (const line of section.lines) {
      const reference = subfileReference(line);
      if (reference === null) continue;
      const key = normalizeLdrawReference(reference);
      if (!own.has(key)) outside.add(key);
    }
  }
  return { sections, own, outside };
}

export function renamedSectionLines(
  section: LdrawSection,
  renames: ReadonlyMap<string, string>,
): string[] {
  return section.lines.map((line) => {
    const reference = subfileReference(line);
    if (reference !== null) {
      const renamed = renames.get(normalizeLdrawReference(reference));
      const start = SUBFILE_REFERENCE_START.exec(line)?.[0];
      return renamed === undefined || start === undefined ? line : `${start}${renamed}`;
    }
    const tokens = tokensOf(line);
    if (tokens[0] === META_LINE && tokens[1] === NAME_META) {
      const named = normalizeLdrawReference(tokens.slice(2).join(" "));
      const renamed = named === section.key ? renames.get(section.key) : undefined;
      const start = NAME_META_START.exec(line)?.[0];
      return renamed === undefined || start === undefined ? line : `${start}${renamed}`;
    }
    return line;
  });
}
