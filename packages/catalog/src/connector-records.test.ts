import { NO_ROLL, type ConnectorRecordFile } from "@brr/schema/bundle";
import { expect, it } from "vitest";
import { ConnectorRecords, partConnectors } from "./connector-records.ts";

const PATHS = {
  connectivity: "standard/connectivity-index.json",
  connectors: "standard/connector-index.json",
};
const SOURCE = { kind: "github-mirror", repo: "kulits/ldraw-parts", commit: "c0ffee", root: "" };
const PART = "ldraw:3001";

function emptyIndex(pkg: "connectivity" | "connectors") {
  return { package: pkg, licenses: [], attribution: [], source: SOURCE, parts: { [PART]: null } };
}

it("reads the package indexes again after a failed read instead of replaying the failure", async () => {
  let unreachable = true;
  const asked: string[] = [];
  const records = new ConnectorRecords(
    async (path) => {
      asked.push(path);
      if (unreachable) throw new TypeError(`Failed to fetch ${path}`);
      return emptyIndex(path === PATHS.connectivity ? "connectivity" : "connectors");
    },
    PATHS,
    null,
  );

  const failed = await records.read(PART).then(
    () => "read",
    (error: unknown) => String(error),
  );
  unreachable = false;
  const retried = await records.read(PART);

  expect({ failed, retried, asked: asked.toSorted() }).toEqual({
    failed: expect.stringContaining("Failed to fetch"),
    retried: { kind: "loaded", connectors: expect.objectContaining({ count: 0 }) },
    asked: [PATHS.connectivity, PATHS.connectivity, PATHS.connectors, PATHS.connectors].toSorted(),
  });
});

function facesRecord(count: number, roll?: ReadonlyArray<number>): ConnectorRecordFile {
  const each = <T>(value: T): T[] => Array.from({ length: count }, () => value);
  return {
    part: "4181.dat",
    license: "CC BY-SA 4.0",
    faces: {
      gender: each(1),
      source: each(1),
      status: each(0),
      caps: each(0),
      slide: each(false),
      group: each("winTrain"),
      origin: each([64, -576, -480]).flat(),
      axis: each(3),
      sectionStart: Array.from({ length: count }, (_, i) => i),
      sectionCount: each(1),
      sectionCode: each(7),
      sectionSize: each(0),
      sectionLength: each(0),
      piece: each(0),
      ...(roll === undefined ? {} : { roll: [...roll] }),
    },
    free: { face: [], origin: [], axis: [] },
    unreadable: [],
  };
}

it("joins each record's roll column, and gives the faces of a record without one no roll", () => {
  const withRoll = facesRecord(1, [1]);
  const without = facesRecord(2);
  expect({
    rolledFirst: Array.from(partConnectors([withRoll, without]).roll),
    rolledLast: Array.from(partConnectors([without, withRoll]).roll),
  }).toEqual({ rolledFirst: [1, NO_ROLL, NO_ROLL], rolledLast: [NO_ROLL, NO_ROLL, 1] });
});
