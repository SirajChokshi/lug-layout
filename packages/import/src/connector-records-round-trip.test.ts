import { ConnectorRecords, type PartConnectors } from "@brr/catalog/connector-records";
import {
  AXIS_FREE,
  CAP_FAR,
  CAP_ROOT,
  ConnectorTable,
  connectorOriginLdu,
  SECTION_AXLE,
  SECTION_FEMALE_FINGER,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_FLARE_JOINS_PREVIOUS,
  SECTION_MALE_FINGER,
  SECTION_ROUND,
  SECTION_SQUARE,
  SnapShapes,
} from "@brr/domain";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const SIXTEENTHS_PER_LDU = 16;
const VECTOR_FLOATS = 3;
const SECTION_CODES = [
  SECTION_ROUND,
  SECTION_AXLE,
  SECTION_SQUARE,
  SECTION_FLARE_JOINS_PREVIOUS,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_MALE_FINGER,
  SECTION_FEMALE_FINGER,
];
const ROUND_TRIP_TIMEOUT_MS = 120_000;

interface Manifest {
  readonly connectors: { readonly file: string };
  readonly connectivity: { readonly file: string };
  readonly compiler: { readonly sectionVocabulary: { readonly sha256: string } };
}

interface Converted {
  readonly part: string;
  readonly columns: PartConnectors;
  readonly table: ConnectorTable;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, bundleRoot), "utf8"));
}

function isDyadic(value: number): boolean {
  return Number.isInteger(value * 2 ** 20);
}

function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a.length === b.length && Array.from(a).every((value, i) => value === b[i]);
}

function sectionsOf(columns: PartConnectors, face: number) {
  const start = columns.sectionStart[face] ?? 0;
  const end = start + (columns.sectionCount[face] ?? 0);
  return {
    codes: columns.sectionCode.subarray(start, end),
    sizes: columns.sectionSize.subarray(start, end),
    lengths: columns.sectionLength.subarray(start, end),
  };
}

function survives({ columns, table }: Converted, shapes: SnapShapes): boolean {
  if (
    !same(table.gender, columns.gender) ||
    !same(table.source, columns.source) ||
    !same(table.status, columns.status) ||
    !same(table.axis, columns.axis) ||
    !same(table.piece, columns.piece) ||
    !same(table.origin, columns.origin) ||
    table.unreadable.join() !== columns.unreadable.join()
  ) {
    return false;
  }
  for (let f = 0; f < columns.freeFace.length; f++) {
    const face = columns.freeFace[f] ?? 0;
    for (let k = 0; k < VECTOR_FLOATS; k++) {
      const recorded = columns.freeOrigin[f * VECTOR_FLOATS + k];
      if (connectorOriginLdu(table, face, k) !== recorded) return false;
      if (table.axisFree[face * VECTOR_FLOATS + k] !== columns.freeAxis[f * VECTOR_FLOATS + k]) {
        return false;
      }
    }
  }
  for (let face = 0; face < columns.count; face++) {
    const shape = table.shape[face] ?? 0;
    const { codes, sizes, lengths } = sectionsOf(columns, face);
    const reinterned = shapes.intern(
      columns.caps[face] ?? 0,
      columns.slide[face] === 1,
      codes,
      sizes,
      lengths,
      columns.group[face] ?? "",
    );
    const spans = Array.from(lengths, (_, s) => shapes.span(shapes.firstSection(shape) + s));
    if (reinterned !== shape || !same(spans, lengths)) return false;
    if (columns.axis[face] !== AXIS_FREE) {
      for (let k = 0; k < VECTOR_FLOATS; k++) {
        const sixteenths = columns.origin[face * VECTOR_FLOATS + k] ?? 0;
        if (connectorOriginLdu(table, face, k) !== sixteenths / SIXTEENTHS_PER_LDU) return false;
      }
    }
  }
  return true;
}

function coverage(converted: ReadonlyArray<Converted>): Record<string, boolean> {
  const all = converted.map(({ columns }) => columns);
  const someFace = (test: (columns: PartConnectors, face: number) => boolean) =>
    all.some((columns) =>
      Array.from({ length: columns.count }, (_, f) => f).some((f) => test(columns, f)),
    );
  return {
    ...Object.fromEntries(
      SECTION_CODES.map((code) => [
        `section code ${code}`,
        all.some((c) => c.sectionCode.includes(code)),
      ]),
    ),
    "root cap": someFace((c, f) => ((c.caps[f] ?? 0) & CAP_ROOT) !== 0),
    "far cap": someFace((c, f) => ((c.caps[f] ?? 0) & CAP_FAR) !== 0),
    slide: someFace((c, f) => c.slide[f] === 1),
    group: someFace((c, f) => (c.group[f] ?? "") !== ""),
    "free face": all.some((c) => c.freeFace.length > 0),
    "piece above the body": all.some((c) => c.piece.some((piece) => piece > 0)),
    unreadable: all.some((c) => c.unreadable.length > 0),
    "non-dyadic section value": all.some((c) =>
      [...c.sectionSize, ...c.sectionLength].some((value) => !isDyadic(value)),
    ),
  };
}

describe("connector records into ConnectorTable", () => {
  const shapes = new SnapShapes();
  let converted: Converted[] = [];

  beforeAll(async () => {
    const manifest = (await readJson("manifest.json")) as Manifest;
    const index = (await readJson(manifest.connectors.file)) as {
      readonly parts: Readonly<Record<string, unknown>>;
    };
    const records = new ConnectorRecords(
      readJson,
      { connectivity: manifest.connectivity.file, connectors: manifest.connectors.file },
      manifest.compiler.sectionVocabulary.sha256,
    );
    const loaded = await Promise.all(
      Object.keys(index.parts).map(async (part) => ({ part, columns: await records.load(part) })),
    );
    converted = loaded.flatMap(({ part, columns }) =>
      columns === null
        ? []
        : [{ part, columns, table: ConnectorTable.fromColumns(columns, shapes, part) }],
    );
  }, ROUND_TRIP_TIMEOUT_MS);

  it("keeps every connector field of every part's real records", () => {
    expect(converted.length).toBeGreaterThan(0);
    expect(converted.filter((part) => !survives(part, shapes)).map(({ part }) => part)).toEqual([]);
  });

  it("covers every connector kind the records carry", () => {
    const covered = coverage(converted);
    expect(covered).toEqual(Object.fromEntries(Object.keys(covered).map((kind) => [kind, true])));
  });
});
