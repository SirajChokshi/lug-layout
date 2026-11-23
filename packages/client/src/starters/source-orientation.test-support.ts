import type { BundleModelEntry } from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const pinnedOmr = new URL("../../../../.cache/omr/", import.meta.url);
const SUBFILE_NUMBERS = 12;
const FIRST_NUMBER = 2;
const REFERENCE_FIELD = FIRST_NUMBER + SUBFILE_NUMBERS;
const TRANSLATION_COLUMN = 3;
const ROW_FLOATS = 4;
const AXES = 3;
const MODEL_ORG = "model";
const UNOFFICIAL_PREFIX = "unofficial_";
const PART_EXTENSION = ".dat";
const PART_ID_PREFIX = "ldraw:";
const CUSTOM_PART = "customPart";
const FILE_META = /^0\s+file\s+(?<name>.+)$/iu;
const LDRAW_ORG = /^0\s+!ldraw_org\s+(?<kind>\S+)/iu;
const GEOMETRY_LINE = /^[34]\s/u;
const LDRAW_TO_Y_UP = [1, -1, -1] as const;

type Affine = ReadonlyArray<number>;

interface Subfile {
  readonly reference: string;
  readonly matrix: Affine;
}

interface Section {
  readonly lines: string[];
  kind: string | null;
  hasGeometry: boolean;
}

export interface SourceInstance {
  readonly partId: string;
  readonly orientation: ReadonlyArray<number>;
}

function normalized(reference: string): string {
  return reference.trim().split(/\s+/u).join(" ").replaceAll("\\", "/").toLowerCase();
}

function subfileOf(line: string): Subfile | null {
  const fields = line.trim().split(/\s+/u);
  if (fields[0] !== "1" || fields.length <= REFERENCE_FIELD) return null;
  const [x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] =
    fields.slice(FIRST_NUMBER, REFERENCE_FIELD).map(Number);
  return {
    reference: normalized(fields.slice(REFERENCE_FIELD).join(" ")),
    matrix: [a, b, c, x, d, e, f, y, g, h, i, z],
  };
}

function then(parent: Affine, child: Affine): Affine {
  const out: number[] = [];
  for (let row = 0; row < AXES; row++) {
    for (let column = 0; column <= TRANSLATION_COLUMN; column++) {
      let value = 0;
      for (let k = 0; k < AXES; k++) {
        value += (parent[row * ROW_FLOATS + k] ?? 0) * (child[k * ROW_FLOATS + column] ?? 0);
      }
      if (column === TRANSLATION_COLUMN) value += parent[row * ROW_FLOATS + column] ?? 0;
      out.push(value);
    }
  }
  return out;
}

function yUpOrientation(matrix: Affine): ReadonlyArray<number> {
  const orientation: number[] = [];
  for (let row = 0; row < AXES; row++) {
    for (let column = 0; column < AXES; column++) {
      const value =
        (LDRAW_TO_Y_UP[row] ?? 1) *
        (matrix[row * ROW_FLOATS + column] ?? 0) *
        (LDRAW_TO_Y_UP[column] ?? 1);
      orientation.push(value + 0);
    }
  }
  return orientation;
}

function withErrata(text: string, entry: BundleModelEntry): string {
  const lines = text.split("\n");
  for (const erratum of entry.errata ?? []) {
    const at = erratum.line - 1;
    if (lines[at]?.trim() !== erratum.from) {
      throw new Error(`${entry.name} line ${erratum.line} no longer reads "${erratum.from}"`);
    }
    lines[at] = erratum.to;
  }
  return lines.join("\n");
}

function sectionsOf(text: string): {
  readonly main: string;
  readonly sections: Map<string, Section>;
} {
  const sections = new Map<string, Section>();
  let main: string | null = null;
  let current: Section | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const name = FILE_META.exec(line.trim())?.groups?.["name"];
    if (name !== undefined) {
      current = { lines: [], kind: null, hasGeometry: false };
      sections.set(normalized(name), current);
      main ??= normalized(name);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const kind = LDRAW_ORG.exec(line.trim())?.groups?.["kind"];
    if (kind !== undefined) current.kind ??= kind.toLowerCase();
    if (GEOMETRY_LINE.test(line.trim())) current.hasGeometry = true;
  }
  if (main === null) throw new Error("the model file has no FILE sections");
  return { main, sections };
}

function isPart(name: string, section: Section): boolean {
  if (section.kind !== null) {
    const kind = section.kind.startsWith(UNOFFICIAL_PREFIX)
      ? section.kind.slice(UNOFFICIAL_PREFIX.length)
      : section.kind;
    return kind !== MODEL_ORG;
  }
  return name.endsWith(PART_EXTENSION) || section.hasGeometry;
}

function partIdOf(reference: string): string {
  return `${PART_ID_PREFIX}${reference.endsWith(PART_EXTENSION) ? reference.slice(0, -PART_EXTENSION.length) : reference}`;
}

export async function sourceInstances(
  entry: BundleModelEntry,
): Promise<ReadonlyArray<SourceInstance>> {
  const file = decodeURIComponent(new URL(entry.source).pathname.split("/").pop() ?? "");
  const bytes = await readFile(new URL(file, pinnedOmr));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`${file} is not the pinned source of ${entry.name} (sha256 ${sha256})`);
  }
  const { main, sections } = sectionsOf(withErrata(bytes.toString("utf8"), entry));
  const official = new Map(
    entry.inlinePartsResolvedToOfficial.map((part) => [
      normalized(part.inline),
      normalized(part.official),
    ]),
  );
  const notDrawn = new Set(
    (entry.notDrawn ?? [])
      .filter((section) => section.kind === CUSTOM_PART)
      .map((section) => normalized(section.section)),
  );
  const instances: SourceInstance[] = [];
  const walk = (name: string, matrix: Affine): void => {
    for (const line of sections.get(name)?.lines ?? []) {
      const subfile = subfileOf(line);
      if (!subfile) continue;
      const placed = then(matrix, subfile.matrix);
      const section = sections.get(subfile.reference);
      if (section && !isPart(subfile.reference, section)) {
        walk(subfile.reference, placed);
        continue;
      }
      if (notDrawn.has(subfile.reference)) continue;
      instances.push({
        partId: partIdOf(official.get(subfile.reference) ?? subfile.reference),
        orientation: yUpOrientation(placed),
      });
    }
  };
  walk(main, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  return instances;
}
