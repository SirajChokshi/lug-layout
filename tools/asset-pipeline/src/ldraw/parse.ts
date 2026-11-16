export interface LdrawHeader {
  readonly title: string;
  readonly name: string;
  readonly author: string;
  readonly license: string;
  readonly ldrawOrg: string;
}

export type LdrawLine =
  | { readonly kind: "meta"; readonly line: number; readonly tokens: ReadonlyArray<string> }
  | {
      readonly kind: "subfile";
      readonly line: number;
      readonly color: string;
      readonly reference: string;
      readonly tokens: ReadonlyArray<string>;
    }
  | {
      readonly kind: "geometry";
      readonly line: number;
      readonly type: 2 | 3 | 4 | 5;
      readonly tokens: ReadonlyArray<string>;
    };

export interface LdrawFile {
  readonly header: LdrawHeader;
  readonly lines: ReadonlyArray<LdrawLine>;
}

type HeaderField = Exclude<keyof LdrawHeader, "title">;

const HEADER_META: ReadonlyArray<readonly [string, HeaderField]> = [
  ["Name:", "name"],
  ["Author:", "author"],
  ["!LICENSE", "license"],
  ["!LDRAW_ORG", "ldrawOrg"],
];

const SUBFILE_NUMBER_COUNT = 13;
const GEOMETRY_TYPES = new Set(["2", "3", "4", "5"]);

export function normalizeReference(reference: string): string {
  return reference.trim().replaceAll("\\", "/").toLowerCase();
}

export function parseLdraw(source: string): LdrawFile {
  const header: Record<HeaderField, string> = { name: "", author: "", license: "", ldrawOrg: "" };
  let title = "";
  const lines: LdrawLine[] = [];
  source.split(/\r?\n/u).forEach((raw, index) => {
    const tokens = raw
      .trim()
      .split(/\s+/u)
      .filter((t) => t !== "");
    const [type, ...rest] = tokens;
    const line = index + 1;
    if (type === "0") {
      if (index === 0) title = rest.join(" ");
      const meta = HEADER_META.find(([key]) => rest[0] === key);
      if (meta) header[meta[1]] = rest.slice(1).join(" ");
      lines.push({ kind: "meta", line, tokens: rest });
    } else if (type === "1" && rest.length > SUBFILE_NUMBER_COUNT) {
      lines.push({
        kind: "subfile",
        line,
        color: rest[0] ?? "",
        reference: normalizeReference(rest.slice(SUBFILE_NUMBER_COUNT).join(" ")),
        tokens: rest,
      });
    } else if (type !== undefined && GEOMETRY_TYPES.has(type)) {
      lines.push({ kind: "geometry", line, type: Number(type) as 2 | 3 | 4 | 5, tokens: rest });
    }
  });
  return { header: { title, ...header }, lines };
}

export function subfileReferences(file: LdrawFile): string[] {
  const references: string[] = [];
  for (const line of file.lines) {
    if (line.kind === "subfile") references.push(line.reference);
  }
  return references;
}
