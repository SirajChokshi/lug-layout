import { affineFromLdraw, type Affine, type Vec3 } from "./affine.ts";

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

export interface MultiPartSection {
  readonly name: string;
  readonly source: string;
}

const FILE_META = /^0\s+FILE\s+(.+)$/u;

export function splitMultiPart(source: string): MultiPartSection[] {
  const sections: Array<{ name: string; lines: string[] }> = [];
  for (const raw of source.split(/\r?\n/u)) {
    const match = FILE_META.exec(raw.trim());
    if (match?.[1]) sections.push({ name: normalizeReference(match[1]), lines: [] });
    else if (sections.length === 0) sections.push({ name: "", lines: [raw] });
    else sections.at(-1)?.lines.push(raw);
  }
  return sections.map(({ name, lines }) => ({ name, source: lines.join("\n") }));
}

export function modelPartReferences(source: string): string[] {
  const sections = splitMultiPart(source);
  const submodels = new Set(sections.map((section) => section.name));
  const parts = new Set<string>();
  for (const section of sections) {
    for (const reference of subfileReferences(parseLdraw(section.source))) {
      if (!submodels.has(reference)) parts.add(reference);
    }
  }
  return [...parts].toSorted();
}

export function metaValues(file: LdrawFile, key: string): string[] {
  const values: string[] = [];
  for (const line of file.lines) {
    if (line.kind === "meta" && line.tokens[0] === key) values.push(line.tokens.slice(1).join(" "));
  }
  return values;
}

export function keywords(file: LdrawFile): string[] {
  return metaValues(file, "!KEYWORDS")
    .flatMap((value) => value.split(","))
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== "");
}

export type SubfileLine = Extract<LdrawLine, { kind: "subfile" }>;
export type GeometryLine = Extract<LdrawLine, { kind: "geometry" }>;

export interface SubfilePlacement {
  readonly color: number;
  readonly transform: Affine;
  readonly translationUnit: number;
  readonly rotationUnit: number;
}

function lastPrintedUnit(tokens: ReadonlyArray<string>): number {
  let unit = 0;
  for (const token of tokens) {
    const dot = token.indexOf(".");
    if (dot < 0 || Number(token) === Math.trunc(Number(token))) continue;
    unit = Math.max(unit, 10 ** -(token.length - dot - 1));
  }
  return unit;
}

export function subfilePlacement(line: SubfileLine): SubfilePlacement {
  const numbers = line.tokens.slice(1, SUBFILE_NUMBER_COUNT);
  return {
    color: Number(line.color),
    transform: affineFromLdraw(numbers.map(Number)),
    translationUnit: lastPrintedUnit(numbers.slice(0, 3)),
    rotationUnit: lastPrintedUnit(numbers.slice(3)),
  };
}

export function polygonVertices(line: GeometryLine): ReadonlyArray<Vec3> {
  const vertices: Vec3[] = [];
  for (let index = 0; index < line.type; index += 1) {
    const offset = 1 + index * 3;
    vertices.push([
      Number(line.tokens[offset]),
      Number(line.tokens[offset + 1]),
      Number(line.tokens[offset + 2]),
    ]);
  }
  return vertices;
}
