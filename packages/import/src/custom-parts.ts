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
  readonly reference: string;
  readonly path: string;
  readonly partId: string;
  readonly files: ReadonlyMap<string, string>;
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

export function mpdSections(text: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (current !== null) sections.set(current, body.join(""));
  };
  for (const line of text.split(/\r?\n/u)) {
    const name = fileMetaName(line);
    if (name !== null) {
      close();
      current = name;
      body = [];
      continue;
    }
    body.push(`${line}\n`);
  }
  close();
  return sections;
}

function lineTokens(line: string): ReadonlyArray<string> {
  return line.trim().split(/\s+/u);
}

function subfileReference(tokens: ReadonlyArray<string>): string | null {
  if (tokens[0] !== SUBFILE_LINE || tokens.length <= SUBFILE_REFERENCE_TOKEN) return null;
  return normalizeReference(tokens.slice(SUBFILE_REFERENCE_TOKEN).join(" "));
}

function subfileReferences(text: string): ReadonlyArray<string> {
  return text.split(/\r?\n/u).flatMap((line) => {
    const reference = subfileReference(lineTokens(line));
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

export async function customClosure(
  reference: string,
  sources: ReadonlyMap<string, string>,
): Promise<CustomClosure | null> {
  const files = new Map<string, string>();
  const reserved = new Map<string, { readonly path: string; readonly hex: string }>();
  const visiting = new Set<string>();
  const reserve = async (name: string, text: string) => {
    const known = reserved.get(name);
    if (known) return known;
    visiting.add(name);
    const renames = new Map<string, string>();
    for (const child of subfileReferences(text)) {
      const childText = sources.get(child);
      if (childText === undefined || visiting.has(child) || renames.has(child)) continue;
      renames.set(child, (await reserve(child, childText)).path);
    }
    visiting.delete(name);
    const renamed = renameReferences(text, renames);
    const hex = await digestHex(renamed);
    const entry = { path: `${CUSTOM_LIBRARY_DIRECTORY}${hex}/${name}`, hex };
    files.set(entry.path, renamed);
    reserved.set(name, entry);
    return entry;
  };
  const name = normalizeReference(reference);
  const text = sources.get(name);
  if (text === undefined) return null;
  const root = await reserve(name, text);
  return {
    reference: name,
    path: root.path,
    partId: `${CUSTOM_PART_NAMESPACE}${root.hex}/${name}`,
    files,
  };
}
