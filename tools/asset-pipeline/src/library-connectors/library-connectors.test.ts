import {
  CONNECTIVITY_LICENSE,
  CONNECTOR_SOURCE,
  LIBRARY_CONNECTORS_INDEX_FILE,
  type LibraryConnectorsPin,
} from "@brr/schema/bundle";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { contentAddressedName } from "../publish.ts";
import { assembleLibraryConnectors, LIBRARY_CONNECTORS_PIN } from "./assemble.ts";
import { libraryConnectorsPublication } from "./publish.ts";
import { publicationIndexKey, uploadPublication } from "../publication/pinned-publication.ts";
import type { ObjectStore } from "../r2.ts";
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

async function assembled(): Promise<{ readonly out: string; readonly pin: LibraryConnectorsPin }> {
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
  return { out, pin };
}

it("publishes CA parts' records under their content addresses, stamps the connector records with the section vocabulary, and refuses a part outside the CA licences", async () => {
  const { out, pin } = await assembled();

  expect(pin).toMatchObject({
    parts: 2,
    refused: [{ part: "ldraw:nonca", license: "Not redistributable : see NonCAreadme.txt" }],
    records: { connectivity: 1, connectors: 1 },
    partsWithPieces: 1,
  });
  const indexText = await readFile(join(out, LIBRARY_CONNECTORS_INDEX_FILE), "utf8");
  expect(
    await readFile(
      join(out, contentAddressedName(LIBRARY_CONNECTORS_INDEX_FILE, pin.index.sha256)),
      "utf8",
    ),
  ).toBe(indexText);
  const index = JSON.parse(indexText);
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

class RecordingStore implements ObjectStore {
  readonly types = new Map<string, string | undefined>();

  async has(): Promise<boolean> {
    return false;
  }

  async put(
    key: string,
    _body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.types.set(key, headers["Content-Type"]);
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

it("publishes every file the assembly wrote as JSON under library-connectors/, with the pinned index under its pinned hash", async () => {
  const { out, pin } = await assembled();
  const store = new RecordingStore();

  await uploadPublication(libraryConnectorsPublication, store, out, pin);

  const indexKey = `library-connectors/library-connectors.${pin.index.sha256.slice(0, 16)}.json`;
  expect(publicationIndexKey(libraryConnectorsPublication, pin)).toBe(indexKey);
  const addressed = (await filesUnder(out)).filter(
    (file) => file !== LIBRARY_CONNECTORS_INDEX_FILE,
  );
  expect([...store.types.keys()].toSorted()).toEqual(
    [...new Set([...addressed.map((file) => `library-connectors/${file}`), indexKey])].toSorted(),
  );
  expect(new Set(store.types.values())).toEqual(new Set(["application/json"]));
});

it("routes the CLI's served command to the committed pin's index under library-connectors/", async () => {
  const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const committed = JSON.parse(
    await readFile(join(toolRoot, "..", "..", LIBRARY_CONNECTORS_PIN), "utf8"),
  ) as LibraryConnectorsPin;
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(`${request.method} ${request.url}`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/library-connectors/cli.ts", "served"],
      {
        cwd: toolRoot,
        env: {
          ...process.env,
          PART_BUNDLE_BASE_URL: `http://127.0.0.1:${port}/`,
          GITHUB_OUTPUT: "",
        },
      },
    );
    const indexPath = `/library-connectors/library-connectors.${committed.index.sha256.slice(0, 16)}.json`;
    expect(requested).toEqual([`HEAD ${indexPath}`]);
    expect(stdout).toBe(`http://127.0.0.1:${port}${indexPath}: served\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
