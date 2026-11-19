import {
  BundleCompiler,
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
import { libraryConnectorsPointer, libraryConnectorsPublication } from "./publish.ts";
import {
  movePointer,
  publicationIndexKey,
  pruneUnreferenced,
  uploadPublication,
} from "../publication/pinned-publication.ts";
import type { ObjectStore, PrunableStore, StoredObject } from "../r2.ts";
import { CA_LICENSE_LINES } from "../verify/license-audit.ts";

const [PART_LICENSE = ""] = CA_LICENSE_LINES;
const NON_CA_LICENSE = "Not redistributable : see NonCAreadme.txt";
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

async function assembled(
  connectivityPiece = 2,
): Promise<{ readonly out: string; readonly pin: LibraryConnectorsPin }> {
  const build = await mkdtemp(join(tmpdir(), "brr-library-build-"));
  const out = await mkdtemp(join(tmpdir(), "brr-library-out-"));
  directories.push(build, out);
  for (const pkg of ["connectivity", "connectors"]) await mkdir(join(build, pkg));
  await writeFile(
    join(build, "connectivity", "3815c01.json"),
    JSON.stringify(
      record("ldraw:3815c01", CONNECTIVITY_LICENSE, CONNECTOR_SOURCE.shadow, connectivityPiece),
    ),
  );
  await writeFile(
    join(build, "connectors", "3815c01.json"),
    JSON.stringify(record("ldraw:3815c01", PART_LICENSE, CONNECTOR_SOURCE.inferred, 1)),
  );
  await writeFile(
    join(build, "connectors", "nonca.json"),
    JSON.stringify(record("ldraw:nonca", NON_CA_LICENSE, CONNECTOR_SOURCE.primitive, 0)),
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
      license: NON_CA_LICENSE,
      connectivity: null,
      connectors: "connectors/nonca.json",
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

it("publishes each part's records under their content addresses, whatever licence the part names, and stamps the connector records with the section vocabulary", async () => {
  const { out, pin } = await assembled();

  expect(pin).toMatchObject({
    parts: 2,
    records: { connectivity: 1, connectors: 2 },
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

class MemoryStore implements PrunableStore {
  readonly objects = new Map<string, Uint8Array>();

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }

  readonly read = async (key: string): Promise<Uint8Array | undefined> => this.objects.get(key);

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async list(prefix: string): Promise<ReadonlyArray<StoredObject>> {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length }));
  }

  async delete(keys: ReadonlyArray<string>): Promise<void> {
    for (const key of keys) this.objects.delete(key);
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

it("the library-connectors pointer's manifest references the pinned index, both package indexes and every record they list", async () => {
  const { out, pin } = await assembled();
  const store = new MemoryStore();
  await uploadPublication(libraryConnectorsPublication, store, out, pin);

  const { indexes, files } = await libraryConnectorsPointer.references(pin.index, store.read);

  expect(indexes).toHaveLength(3);
  expect([...indexes, ...files.map((file) => file.key)].toSorted()).toEqual(
    [...store.objects.keys()].toSorted(),
  );
});

it("prune keeps the current and previous indexes and every record they share, deletes the rest, and refuses while a kept package index is missing", async () => {
  const store = new MemoryStore();
  const pins: LibraryConnectorsPin[] = [];
  for (const piece of [2, 3, 4]) {
    const { out, pin } = await assembled(piece);
    await uploadPublication(libraryConnectorsPublication, store, out, pin);
    pins.push(pin);
  }
  const [first, second, third] = pins;
  if (!first || !second || !third) throw new Error("three pins");
  for (const pin of pins) await movePointer(libraryConnectorsPointer, store, pin.index);
  const keys = async (pin: LibraryConnectorsPin) => {
    const { indexes, files } = await libraryConnectorsPointer.references(pin.index, store.read);
    return [...indexes, ...files.map((file) => file.key)];
  };
  const kept = new Set([...(await keys(second)), ...(await keys(third))]);
  const firstOnly = (await keys(first)).filter((key) => !kept.has(key));
  const shared = (await keys(first)).filter((key) => kept.has(key));
  expect(shared.length).toBeGreaterThan(0);

  const outcome = await pruneUnreferenced(libraryConnectorsPointer, store, false);

  expect(outcome.doomed.map((object) => object.key).toSorted()).toEqual(firstOnly.toSorted());
  expect(shared.every((key) => store.objects.has(key))).toBe(true);
  expect((await pruneUnreferenced(libraryConnectorsPointer, store, false)).deleted).toBe(0);

  const [, secondPackage] = (await libraryConnectorsPointer.references(second.index, store.read))
    .indexes;
  if (secondPackage === undefined) throw new Error("a package index");
  store.objects.delete(secondPackage);
  const before = [...store.objects.keys()].toSorted();
  await expect(pruneUnreferenced(libraryConnectorsPointer, store, false)).rejects.toThrow(
    "is not stored",
  );
  expect([...store.objects.keys()].toSorted()).toEqual(before);
});

it("no BundleCompiler field names a library-connectors index, since its prune keeps only its own current and previous; one that does needs that prune to retain what the live bundle manifests name, and library-connectors to publish in part-bundle.yml's concurrency group", () => {
  expect(Object.keys(BundleCompiler.entries)).not.toContain("libraryConnectors");
});
