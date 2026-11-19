import { partConnectors } from "@brr/catalog/connector-records";
import { ConnectorTable, SnapShapes } from "@brr/domain";
import { CONNECTOR_SOURCE, type ConnectorRecordFile } from "@brr/schema/bundle";
import { expect, it } from "vitest";
import type { PartConnectorRecord } from "../catalog/placeable-catalog.ts";
import { ConnectorTables, type ConnectedPlaceable } from "./connector-tables.ts";

const MATRIX_FLOATS = 12;
const WITH_FACES = "ldraw:3023b";
const NO_FACES = "ldraw:57877";
const WITHOUT_RECORD = "ldraw:custom-1";
const MALFORMED = "ldraw:malformed";
const UNUSED = "ldraw:unused";
const PART_IDS = [WITH_FACES, NO_FACES, WITHOUT_RECORD, MALFORMED, UNUSED];
const NOT_LISTED = "the bundle's connector packages don't list it";

function record(part: string, sectionCount: number): ConnectorRecordFile {
  return {
    part,
    license: "CC BY 4.0",
    faces: {
      gender: [0, 1],
      source: [CONNECTOR_SOURCE.shadow, CONNECTOR_SOURCE.shadow],
      status: [0, 0],
      caps: [1, 2],
      slide: [false, false],
      group: ["", ""],
      origin: [160, 0, 0, 160, -128, 0],
      axis: [2, 3],
      sectionStart: [0, sectionCount],
      sectionCount: [sectionCount, sectionCount],
      sectionCode: Array.from({ length: 2 * sectionCount }, () => 0),
      sectionSize: Array.from({ length: 2 * sectionCount }, () => 6),
      sectionLength: Array.from({ length: 2 * sectionCount }, () => 4),
      piece: [0, 0],
    },
    free: { face: [], origin: [], axis: [] },
    unreadable: [],
  };
}

const RECORDS = new Map<string, PartConnectorRecord>([
  [WITH_FACES, { kind: "record", connectors: partConnectors([record(WITH_FACES, 1)]) }],
  [NO_FACES, { kind: "record", connectors: partConnectors([]) }],
  [WITHOUT_RECORD, { kind: "missing", reason: NOT_LISTED }],
  [MALFORMED, { kind: "record", connectors: partConnectors([record(MALFORMED, 0)]) }],
]);

function recordSource(asked: string[] = []) {
  return {
    parts: () => PART_IDS.map((id) => ({ id })),
    partConnectorRecord: async (partIndex: number): Promise<PartConnectorRecord> => {
      const id = PART_IDS[partIndex] ?? "";
      asked.push(id);
      return RECORDS.get(id) ?? { kind: "missing", reason: `no record for ${id}` };
    },
  };
}

function placeable(id: string, partIndex: ReadonlyArray<number>): ConnectedPlaceable {
  return {
    id,
    partTransforms: {
      count: partIndex.length,
      partIndex,
      matrices: new Float64Array(partIndex.length * MATRIX_FLOATS),
    },
  };
}

it("gives each part index a placeable uses its record's table, a zero-face table to a part whose record has no faces, and null to a part without a usable record, listed with the reason", async () => {
  const shapes = new SnapShapes();
  const tables = new ConnectorTables(recordSource(), shapes);

  const loaded = await tables.load(placeable("test:model", [3, 0, 2, 1, 0]));

  const expected = RECORDS.get(WITH_FACES);
  if (expected?.kind !== "record") throw new Error("the fixture lost its record");
  expect(loaded.tables).toHaveLength(4);
  expect(loaded.tables[0]).toEqual(ConnectorTable.fromColumns(expected.connectors, shapes, "x"));
  expect(loaded.tables[1]?.count).toBe(0);
  expect([loaded.tables[2], loaded.tables[3]]).toEqual([null, null]);
  expect(loaded.withoutRecords).toEqual([
    { partIndex: 2, partId: WITHOUT_RECORD, reason: NOT_LISTED },
    {
      partIndex: 3,
      partId: MALFORMED,
      reason: expect.stringContaining("its connector record is malformed"),
    },
  ]);
});

it("serves a placeable replaced by one with the same id from the same result at once, reads each part's record once, and asks again for a part that had none", async () => {
  const asked: string[] = [];
  const tables = new ConnectorTables(recordSource(asked), new SnapShapes());
  const pending = placeable("import:abc", [0, 2]);
  const checked = placeable("import:abc", [0, 2]);

  const first = await tables.load(pending);
  const swapped = tables.loaded(checked);
  await tables.load(placeable("omr:other", [0, 2]));

  expect(swapped).toBe(first);
  expect(asked).toEqual([WITH_FACES, WITHOUT_RECORD, WITHOUT_RECORD]);
});
