export interface LdrawHeader {
  readonly title: string;
  readonly name: string;
  readonly author: string;
  readonly license: string;
  readonly ldrawOrg: string;
}

const HEADER_PREFIXES = {
  name: "0 Name:",
  author: "0 Author:",
  license: "0 !LICENSE",
  ldrawOrg: "0 !LDRAW_ORG",
} as const;

export function readHeader(source: string): LdrawHeader {
  const lines = source.split(/\r?\n/u);
  const firstLine = lines[0] ?? "";
  let name = "";
  let author = "";
  let license = "";
  let ldrawOrg = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(HEADER_PREFIXES.name))
      name = line.slice(HEADER_PREFIXES.name.length).trim();
    else if (line.startsWith(HEADER_PREFIXES.author))
      author = line.slice(HEADER_PREFIXES.author.length).trim();
    else if (line.startsWith(HEADER_PREFIXES.license))
      license = line.slice(HEADER_PREFIXES.license.length).trim();
    else if (line.startsWith(HEADER_PREFIXES.ldrawOrg))
      ldrawOrg = line.slice(HEADER_PREFIXES.ldrawOrg.length).trim();
  }
  return {
    title: firstLine.replace(/^0\s*/u, "").trim(),
    name,
    author,
    license,
    ldrawOrg,
  };
}

const SUBFILE_FIELD_COUNT = 14;

export function subfileReferences(source: string): ReadonlyArray<string> {
  const references: string[] = [];
  for (const raw of source.split(/\r?\n/u)) {
    const tokens = raw.trim().split(/\s+/u);
    if (tokens[0] !== "1" || tokens.length <= SUBFILE_FIELD_COUNT) continue;
    references.push(normalizeReference(tokens.slice(SUBFILE_FIELD_COUNT).join(" ")));
  }
  return references;
}

export function normalizeReference(reference: string): string {
  return reference.trim().replaceAll("\\", "/").toLowerCase();
}
