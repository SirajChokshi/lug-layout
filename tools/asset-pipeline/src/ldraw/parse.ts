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

const MODEL_ORG = "model";
const SUBPART_DIRECTORY = "s/";
const OMR_SET_SEPARATOR = " - ";
const OMR_SET_NUMBER = /^\d+(?:-\d+)?$/u;

export function officialReference(inlineName: string): string {
  const directory = inlineName.startsWith(SUBPART_DIRECTORY) ? SUBPART_DIRECTORY : "";
  const name = inlineName.slice(directory.length);
  const separator = name.indexOf(OMR_SET_SEPARATOR);
  if (separator < 0 || !OMR_SET_NUMBER.test(name.slice(0, separator))) return inlineName;
  return directory + name.slice(separator + OMR_SET_SEPARATOR.length);
}

function isPartSection(file: LdrawFile): boolean {
  const kind = file.header.ldrawOrg.split(/\s+/u)[0] ?? "";
  return kind !== "" && kind.toLowerCase() !== MODEL_ORG;
}

export interface ModelStructure {
  readonly parts: ReadonlyArray<string>;
  readonly inlinePartReferences: ReadonlyArray<string>;
  readonly modelSections: ReadonlyArray<LdrawHeader>;
}

function inlinePartReferences(
  sections: ReadonlyMap<string, LdrawFile>,
  inlineParts: ReadonlyArray<string>,
): string[] {
  const references = new Set<string>();
  const visited = new Set<string>();
  const pending = [...inlineParts];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const file = sections.get(name);
    if (visited.has(name) || file === undefined) continue;
    visited.add(name);
    for (const reference of subfileReferences(file)) {
      if (sections.has(reference)) pending.push(reference);
      else references.add(reference);
    }
  }
  return [...references].toSorted();
}

export function modelStructure(source: string): ModelStructure {
  const sections = new Map(
    splitMultiPart(source).map((section) => [section.name, parseLdraw(section.source)]),
  );
  const [root] = sections.keys();
  const parts = new Set<string>();
  const inlineParts = new Set<string>();
  const modelSections: LdrawHeader[] = [];
  const visited = new Set<string>();
  const pending = root === undefined ? [] : [root];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const file = sections.get(name);
    if (visited.has(name) || file === undefined) continue;
    visited.add(name);
    modelSections.push(file.header);
    for (const reference of subfileReferences(file)) {
      const section = sections.get(reference);
      if (section === undefined) parts.add(reference);
      else if (isPartSection(section)) {
        parts.add(officialReference(reference));
        inlineParts.add(reference);
      } else pending.push(reference);
    }
  }
  return {
    parts: [...parts].toSorted(),
    inlinePartReferences: inlinePartReferences(sections, [...inlineParts]),
    modelSections,
  };
}

export const LDCAD_META = "!LDCAD";

const STUD_PRIMITIVE = /^stud\d*a?\.dat$/u;

export function isStudPrimitive(reference: string): boolean {
  return STUD_PRIMITIVE.test(reference);
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

type SubfileLine = Extract<LdrawLine, { kind: "subfile" }>;
type GeometryLine = Extract<LdrawLine, { kind: "geometry" }>;

interface SubfilePlacement {
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
