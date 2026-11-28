import { CUSTOM_PART_NAMESPACE } from "@brr/schema/bundle";

export const CUSTOM_LIBRARY_DIRECTORY = "brr-custom/";

const DIGEST_HEX_DIGITS = 12;
const RESERVED_PATH_PREFIX = new RegExp(
  `${CUSTOM_LIBRARY_DIRECTORY}[0-9a-f]{${DIGEST_HEX_DIGITS}}/`,
  "gu",
);
const SUBFILE_LINE = "1";
const SUBFILE_REFERENCE_TOKEN = 14;
const utf8 = new TextEncoder();

export interface CustomSource {
  readonly name: string;
  readonly text: string;
}

export interface CustomClosure {
  readonly kind: "closure";
  readonly reference: string;
  readonly path: string;
  readonly partId: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface CustomCycle {
  readonly kind: "cycle";
  readonly reference: string;
  readonly through: ReadonlyArray<string>;
}

export interface MpdSection {
  readonly name: string | null;
  readonly lines: ReadonlyArray<string>;
}

interface Reserved {
  readonly path: string;
  readonly hex: string;
}

export function normalizeReference(reference: string): string {
  return reference.trim().replaceAll("\\", "/").toLowerCase();
}

function fileMetaName(line: string): string | null {
  const tokens = line.trim().split(/\s+/u);
  if (tokens[0] !== "0" || tokens[1]?.toUpperCase() !== "FILE") return null;
  const name = tokens.slice(2).join(" ");
  return name === "" ? null : normalizeReference(name);
}

export function sectionList(text: string): ReadonlyArray<MpdSection> {
  const sections: Array<{ readonly name: string | null; readonly lines: string[] }> = [];
  for (const line of text.split(/\r?\n/u)) {
    const name = fileMetaName(line);
    if (name !== null || sections.length === 0) sections.push({ name, lines: [] });
    sections.at(-1)?.lines.push(line);
  }
  return sections;
}

export function mpdSections(text: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  for (const { name, lines } of sectionList(text)) {
    if (name !== null)
      sections.set(
        name,
        lines
          .slice(1)
          .map((line) => `${line}\n`)
          .join(""),
      );
  }
  return sections;
}

function lineTokens(line: string): ReadonlyArray<string> {
  return line.trim().split(/\s+/u);
}

function rawSubfileName(tokens: ReadonlyArray<string>): string | null {
  if (tokens[0] !== SUBFILE_LINE || tokens.length <= SUBFILE_REFERENCE_TOKEN) return null;
  return tokens.slice(SUBFILE_REFERENCE_TOKEN).join(" ");
}

export function subfileName(line: string): string | null {
  return rawSubfileName(lineTokens(line));
}

function subfileReference(tokens: ReadonlyArray<string>): string | null {
  const name = rawSubfileName(tokens);
  return name === null ? null : normalizeReference(name);
}

export function lineReference(line: string): string | null {
  return subfileReference(lineTokens(line));
}

function subfileReferences(text: string): ReadonlyArray<string> {
  return text.split(/\r?\n/u).flatMap((line) => {
    const reference = lineReference(line);
    return reference === null ? [] : [reference];
  });
}

export function renameReferences(text: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return text;
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const fileName = fileMetaName(line);
      if (fileName !== null) {
        const renamed = renames.get(fileName);
        return renamed === undefined ? line : `0 FILE ${renamed}`;
      }
      const tokens = lineTokens(line);
      const reference = subfileReference(tokens);
      const renamed = reference === null ? undefined : renames.get(reference);
      if (renamed === undefined) return line;
      return [...tokens.slice(0, SUBFILE_REFERENCE_TOKEN), renamed].join(" ");
    })
    .join("\n");
}

export function withoutReservedPaths(text: string): string {
  return text.replaceAll(RESERVED_PATH_PREFIX, "");
}

async function digestHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, DIGEST_HEX_DIGITS);
}

function cycleFrom(
  root: string,
  sources: ReadonlyMap<string, string>,
): ReadonlyArray<string> | null {
  const acyclic = new Set<string>();
  const visit = (name: string, trail: ReadonlyArray<string>): ReadonlyArray<string> | null => {
    const repeated = trail.indexOf(name);
    if (repeated >= 0) return [...trail.slice(repeated), name];
    const text = sources.get(name);
    if (text === undefined || acyclic.has(name)) return null;
    for (const child of subfileReferences(text)) {
      const cycle = visit(child, [...trail, name]);
      if (cycle !== null) return cycle;
    }
    acyclic.add(name);
    return null;
  };
  return visit(root, []);
}

export async function customClosure(
  reference: string,
  sources: ReadonlyMap<string, string>,
): Promise<CustomClosure | CustomCycle | null> {
  const name = normalizeReference(reference);
  const rootText = sources.get(name);
  if (rootText === undefined) return null;
  const cycle = cycleFrom(name, sources);
  if (cycle !== null) return { kind: "cycle", reference: name, through: cycle };
  const files = new Map<string, string>();
  const reserved = new Map<string, Promise<Reserved>>();
  const reserveFile = async (file: string, text: string): Promise<Reserved> => {
    const children = [...new Set(subfileReferences(text))].flatMap((child) => {
      const childText = sources.get(child);
      return childText === undefined ? [] : [[child, childText] as const];
    });
    const paths = await Promise.all(
      children.map(
        async ([child, childText]) => [child, (await reserve(child, childText)).path] as const,
      ),
    );
    const renamed = renameReferences(text, new Map(paths));
    const hex = await digestHex(renamed);
    const path = `${CUSTOM_LIBRARY_DIRECTORY}${hex}/${file}`;
    files.set(path, renamed);
    return { path, hex };
  };
  const reserve = (file: string, text: string): Promise<Reserved> => {
    let entry = reserved.get(file);
    if (entry === undefined) {
      entry = reserveFile(file, text);
      reserved.set(file, entry);
    }
    return entry;
  };
  const root = await reserve(name, rootText);
  return {
    kind: "closure",
    reference: name,
    path: root.path,
    partId: `${CUSTOM_PART_NAMESPACE}${root.hex}/${name}`,
    files,
  };
}
