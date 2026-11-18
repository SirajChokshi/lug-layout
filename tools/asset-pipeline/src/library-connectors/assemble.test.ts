import { CONNECTIVITY_LICENSE, CONNECTOR_SOURCE } from "@brr/schema/bundle";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assembleLibraryConnectors, LIBRARY_CONNECTORS_INDEX } from "./assemble.ts";
import { CA_LICENSE_LINES } from "../verify/license-audit.ts";

const [PART_LICENSE = ""] = CA_LICENSE_LINES;
const VOCABULARY = "a".repeat(64);
const ldraw = { kind: "github-mirror" as const, repo: "owner/ldraw", commit: "abc", root: "ldraw" };
const shadow = { kind: "github-archive" as const, repo: "owner/shadow", commit: "def", root: "" };
const directories: string[] = [];

function record(part: string, license: string, tier: number, piece: number) {
  return {
    part,
    license,
    faces: {
      gender: [0],
      source: [tier],
      status: [0],
      caps: [0],
      slide: [false],
      group: [""],
      origin: [0, 0, 0],
      axis: [0],
      sectionStart: [0],
      sectionCount: [1],
      sectionCode: [0],
      sectionSize: [6],
      sectionLength: [8],
      piece: [piece],
    },
    free: { face: [], origin: [], axis: [] },
    unreadable: [],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("publishes CA parts' records under their content addresses, stamps the connector records with the section vocabulary, and refuses a part outside the CA licences", async () => {
  const build = await mkdtemp(join(tmpdir(), "brr-library-build-"));
  const out = await mkdtemp(join(tmpdir(), "brr-library-out-"));
  directories.push(build, out);
  for (const pkg of ["connectivity", "connectors"]) await mkdir(join(build, pkg));
  await writeFile(
    join(build, "connectivity", "3815c01.json"),
    JSON.stringify(record("ldraw:3815c01", CONNECTIVITY_LICENSE, CONNECTOR_SOURCE.shadow, 2)),
  );
  await writeFile(
    join(build, "connectors", "3815c01.json"),
    JSON.stringify(record("ldraw:3815c01", PART_LICENSE, CONNECTOR_SOURCE.inferred, 1)),
  );
  const listing = [
    {
      part: "ldraw:3815c01",
      path: "parts/3815c01.dat",
      license: PART_LICENSE,
      connectivity: "connectivity/3815c01.json",
      connectors: "connectors/3815c01.json",
    },
    {
      part: "ldraw:nonca",
      path: "parts/nonca.dat",
      license: "Not redistributable : see NonCAreadme.txt",
      connectivity: null,
      connectors: null,
    },
  ];
  await writeFile(
    join(build, "parts-0-of-1.jsonl"),
    listing.map((line) => JSON.stringify(line)).join("\n"),
  );

  const pin = await assembleLibraryConnectors({
    build,
    out,
    ldraw,
    shadow,
    sectionVocabulary: VOCABULARY,
  });

  expect(pin).toMatchObject({
    parts: 2,
    refused: [{ part: "ldraw:nonca", license: "Not redistributable : see NonCAreadme.txt" }],
    records: { connectivity: 1, connectors: 1 },
    partsWithPieces: 1,
  });
  const index = JSON.parse(await readFile(join(out, LIBRARY_CONNECTORS_INDEX), "utf8"));
  expect(index).toMatchObject({ format: 1, ldraw, shadow, sectionVocabulary: VOCABULARY });
  for (const [pkg, stamped] of [
    ["connectivity", undefined],
    ["connectors", VOCABULARY],
  ] as const) {
    const packageIndex = JSON.parse(await readFile(join(out, index[pkg].file), "utf8"));
    expect(packageIndex.sectionVocabulary).toBe(stamped);
    expect(packageIndex.parts["ldraw:nonca"]).toBeUndefined();
    const file: string = packageIndex.parts["ldraw:3815c01"].file;
    expect(file).toMatch(new RegExp(`^${pkg}/3815c01\\.[0-9a-f]{16}\\.json$`, "u"));
    expect(JSON.parse(await readFile(join(out, file), "utf8")).sectionVocabulary).toBe(stamped);
  }
});
