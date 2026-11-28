import {
  ldrawSections,
  renamedSectionLines,
  type LdrawSection,
  type LdrawSections,
} from "./ldraw-sections.ts";
import {
  LDRAW_INHERITED_COLOR,
  LDRAW_LINE_END,
  commentLines,
  normalizeLdrawReference,
  type1Line,
} from "./ldraw-text.ts";

const LAYOUT_TAG = "layout";
const PART_SECTION = /\.dat$/iu;
const SET_PREFIXED = /^\d+(?:-\d+)? - /u;
const SET_PREFIX_SEPARATOR = " - ";
const META_FIRST_WORD = /^(?:FILE|NOFILE|Name:|Author:|!\S*|\/\/)$/iu;
const IDENTITY = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

export interface LdrawOriginal {
  readonly key: string;
  readonly tag: string;
  readonly name: string;
  readonly text: string;
}

export type SubmodelLine =
  | {
      readonly kind: "part";
      readonly color: number;
      readonly affine: Float64Array;
      readonly reference: string;
    }
  | {
      readonly kind: "model";
      readonly affine: Float64Array;
      readonly original: string;
    };

export interface MpdSubmodel {
  readonly name: string;
  readonly lines: ReadonlyArray<SubmodelLine>;
}

export interface MpdDocument {
  readonly name: string;
  readonly title: string;
  readonly notes: ReadonlyArray<string>;
  readonly submodels: ReadonlyArray<MpdSubmodel>;
  readonly originals: ReadonlyArray<LdrawOriginal>;
}

interface ParsedOriginal {
  readonly original: LdrawOriginal;
  readonly sections: LdrawSections;
}

interface EmbeddedOriginal extends ParsedOriginal {
  readonly names: ReadonlyArray<string>;
  readonly renames: ReadonlyMap<string, string>;
}

function clashFreeName(name: string, tag: string, n: number): string {
  if (!PART_SECTION.test(name)) return n === 1 ? `${tag}-${name}` : `${tag}-${n}-${name}`;
  const folder = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1;
  const part = name.slice(folder).replace(SET_PREFIXED, "");
  return `${name.slice(0, folder)}${n}${SET_PREFIX_SEPARATOR}${part}`;
}

function titleText(title: string): string {
  const flat = title.trim().split(/\s+/u).join(" ");
  return META_FIRST_WORD.test(flat.split(" ")[0] ?? "") ? `"${flat}"` : flat;
}

class SectionNames {
  private readonly taken = new Set<string>();

  reserve(name: string): void {
    this.taken.add(normalizeLdrawReference(name));
  }

  claim(name: string, tag: string): string {
    let claimed = name;
    for (let n = 1; this.taken.has(normalizeLdrawReference(claimed)); n++) {
      claimed = clashFreeName(name, tag, n);
    }
    this.reserve(claimed);
    return claimed;
  }
}

function parsedOriginals(originals: ReadonlyArray<LdrawOriginal>): ParsedOriginal[] {
  const byKey = new Map<string, LdrawOriginal>();
  for (const original of originals) {
    const known = byKey.get(original.key);
    if (known && known.text !== original.text) {
      throw new Error(`two different original files share the key ${original.key}`);
    }
    byKey.set(original.key, original);
  }
  const sorted = [...byKey.values()];
  sorted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sorted.map((original) => {
    const sections = ldrawSections(original.text);
    if (sections.sections.length === 0) throw new Error(`${original.name} has no LDraw lines`);
    return { original, sections };
  });
}

function displayName(section: LdrawSection, original: LdrawOriginal): string {
  return section.name ?? original.name.trim().split(/\s+/u).join(" ");
}

function embedded(file: ParsedOriginal, names: SectionNames): EmbeddedOriginal {
  const { original, sections } = file;
  const claimed = sections.sections.map((section) =>
    names.claim(displayName(section, original), original.tag),
  );
  const renames = new Map<string, string>();
  sections.sections.forEach((section, index) => {
    const name = claimed[index];
    if (section.name !== null && name !== undefined && name !== section.name) {
      renames.set(section.key, name);
    }
  });
  return { ...file, names: claimed, renames };
}

function partReferences(submodels: ReadonlyArray<MpdSubmodel>): ReadonlyArray<string> {
  return submodels.flatMap((submodel) =>
    submodel.lines.flatMap((line) => (line.kind === "part" ? [line.reference] : [])),
  );
}

function header(name: string, title: string): string[] {
  return [`0 FILE ${name}`, `0 ${titleText(title)}`, `0 Name: ${name}`];
}

function submodelLine(line: SubmodelLine, mains: ReadonlyMap<string, string>): string {
  switch (line.kind) {
    case "part":
      return type1Line(line.color, line.affine, line.reference);
    case "model": {
      const main = mains.get(line.original);
      if (main === undefined) throw new Error(`no original file ${line.original} is embedded`);
      return type1Line(LDRAW_INHERITED_COLOR, line.affine, main);
    }
    default: {
      const unhandled: never = line;
      throw new Error(`unhandled submodel line ${String(unhandled)}`);
    }
  }
}

function embeddedLines(file: EmbeddedOriginal): string[] {
  return file.sections.sections.flatMap((section, index) => [
    `0 FILE ${file.names[index] ?? ""}`,
    ...renamedSectionLines(section, file.renames),
  ]);
}

export function mpdText(document: MpdDocument): string {
  const parsed = parsedOriginals(document.originals);
  const names = new SectionNames();
  for (const reference of partReferences(document.submodels)) names.reserve(reference);
  for (const { sections } of parsed) for (const outside of sections.outside) names.reserve(outside);
  const main = names.claim(document.name, LAYOUT_TAG);
  const submodels = document.submodels.map((submodel) => ({
    ...submodel,
    name: names.claim(submodel.name, LAYOUT_TAG),
  }));
  const files = parsed.map((file) => embedded(file, names));
  const mains = new Map(files.map((file) => [file.original.key, file.names[0] ?? ""]));
  const lines = [
    ...header(main, document.title),
    ...document.notes.flatMap(commentLines),
    ...submodels.map((submodel) => type1Line(LDRAW_INHERITED_COLOR, IDENTITY, submodel.name)),
    ...submodels.flatMap((submodel) => [
      ...header(submodel.name, submodel.name),
      ...submodel.lines.map((line) => submodelLine(line, mains)),
    ]),
    ...files.flatMap(embeddedLines),
  ];
  return `${lines.join(LDRAW_LINE_END)}${LDRAW_LINE_END}`;
}
