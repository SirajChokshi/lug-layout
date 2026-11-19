import {
  CONNECTIVITY_LICENSE,
  CONNECTOR_SOURCE,
  LIBRARY_CONNECTORS_INDEX_FILE,
  type LibraryConnectorsPin,
} from "@brr/schema/bundle";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { contentAddressedName } from "../publish.ts";
import { assembleLibraryConnectors } from "./assemble.ts";
import {
  libraryConnectorsIndexKey,
  libraryConnectorsPointer,
  LIBRARY_CONNECTORS_PREFIX,
  uploadLibraryConnectors,
  verifyServedLibraryConnectors,
} from "./publish.ts";
import { liveBundleLibraryConnectorsIndexes } from "../pointer/live-bundles.ts";
import { partBundlePointer } from "../pointer/part-bundle-pointer.ts";
import { movePointer, pruneUnreferenced } from "../publication/pinned-publication.ts";
import type { PrunableStore, StoredObject } from "../r2.ts";
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

class MemoryStore implements PrunableStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly order: string[] = [];

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
    this.order.push(key);
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

async function addressedFiles(out: string): Promise<string[]> {
  const index = JSON.parse(await readFile(join(out, LIBRARY_CONNECTORS_INDEX_FILE), "utf8"));
  const files: string[] = [];
  for (const pkg of ["connectivity", "connectors"]) {
    const packageIndex = JSON.parse(await readFile(join(out, index[pkg].file), "utf8"));
    files.push(
      index[pkg].file,
      ...Object.values<{ file: string }>(packageIndex.parts).map((e) => e.file),
    );
  }
  return files;
}

it("uploads every record and both package indexes under their content addresses, then the pinned index, and only once", async () => {
  const { out, pin } = await assembled();
  const store = new MemoryStore();

  const first = await uploadLibraryConnectors(store, out, pin);
  const again = await uploadLibraryConnectors(store, out, pin);

  const files = await addressedFiles(out);
  const indexKey = libraryConnectorsIndexKey(pin);
  expect(indexKey).toBe(
    `${LIBRARY_CONNECTORS_PREFIX}/library-connectors.${pin.index.sha256.slice(0, 16)}.json`,
  );
  expect(store.order.toSorted()).toEqual(
    [...files.map((file) => `${LIBRARY_CONNECTORS_PREFIX}/${file}`), indexKey].toSorted(),
  );
  expect(store.order.at(-1)).toBe(indexKey);
  expect([first, again]).toEqual([
    { uploaded: files.length + 1, present: 0 },
    { uploaded: 0, present: files.length + 1 },
  ]);
  expect(await verifyServedLibraryConnectors(store.read, pin, "all")).toEqual([]);
});

it("refuses to upload a dist whose index is not the pinned one, or a record not named by its content", async () => {
  const { out, pin } = await assembled();
  const otherPin = { ...pin, index: { ...pin.index, sha256: "0".repeat(64) } };
  await expect(uploadLibraryConnectors(new MemoryStore(), out, otherPin)).rejects.toThrow(
    "is not the pinned index",
  );
  const [, recordFile = ""] = await addressedFiles(out);
  await writeFile(join(out, recordFile), "{}");
  await expect(uploadLibraryConnectors(new MemoryStore(), out, pin)).rejects.toThrow(
    `${recordFile} is not named by its content hash`,
  );
});

it("finds a served record that differs from its content address only when every record is checked", async () => {
  const { out, pin } = await assembled();
  const store = new MemoryStore();
  await uploadLibraryConnectors(store, out, pin);
  const [, recordFile = ""] = await addressedFiles(out);
  const key = `${LIBRARY_CONNECTORS_PREFIX}/${recordFile}`;
  store.objects.set(key, new TextEncoder().encode("{}"));

  expect(await verifyServedLibraryConnectors(store.read, pin, "indexes")).toEqual([]);
  expect(await verifyServedLibraryConnectors(store.read, pin, "all")).toEqual([
    `${key} differs from its content address`,
  ]);
});

it("the library-connectors pointer's manifest references the pinned index, both package indexes and every record they list", async () => {
  const { out, pin } = await assembled();
  const store = new MemoryStore();
  await uploadLibraryConnectors(store, out, pin);

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
    await uploadLibraryConnectors(store, out, pin);
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

it("the library-connectors prune keeps the index a live bundle manifest names beyond its own current and previous, and refuses while a named index is missing", async () => {
  const store = new MemoryStore();
  const pins: LibraryConnectorsPin[] = [];
  for (const piece of [2, 3, 4, 5]) {
    const { out, pin } = await assembled(piece);
    await uploadLibraryConnectors(store, out, pin);
    pins.push(pin);
  }
  const [fallbackPin, firstPin, secondPin, thirdPin] = pins;
  if (!fallbackPin || !firstPin || !secondPin || !thirdPin) throw new Error("four pins");
  const root = await mkdtemp(join(tmpdir(), "brr-library-live-"));
  directories.push(root);
  const fallbackPath = join(root, "bundle-fallback.json");
  const manifests = {
    fallback: "manifest.0000000000000001.json",
    current: "manifest.0000000000000002.json",
  };
  await writeFile(fallbackPath, JSON.stringify({ manifest_file: manifests.fallback }));
  const nameIndex = async (manifest: string, index: LibraryConnectorsPin["index"]) => {
    for (const lod of ["standard", "low", "far"]) {
      await store.put(
        `${lod}/${manifest}`,
        new TextEncoder().encode(JSON.stringify({ compiler: { libraryConnectors: index } })),
      );
    }
  };
  await nameIndex(manifests.fallback, fallbackPin.index);
  await nameIndex(manifests.current, thirdPin.index);
  const bundle = partBundlePointer(fallbackPath);
  await store.put(bundle.key, bundle.encode({ current: manifests.current, previous: null }));
  const adapter = {
    ...libraryConnectorsPointer,
    retained: () => liveBundleLibraryConnectorsIndexes(store.read, fallbackPath),
  };
  for (const pin of [firstPin, secondPin, thirdPin]) await movePointer(adapter, store, pin.index);
  const keys = async (pin: LibraryConnectorsPin) => {
    const { indexes, files } = await adapter.references(pin.index, store.read);
    return [...indexes, ...files.map((file) => file.key)];
  };
  const kept = new Set([
    ...(await keys(fallbackPin)),
    ...(await keys(secondPin)),
    ...(await keys(thirdPin)),
  ]);
  const firstOnly = (await keys(firstPin)).filter((key) => !kept.has(key));
  expect(firstOnly.length).toBeGreaterThan(0);

  const outcome = await pruneUnreferenced(adapter, store, false);

  expect(outcome.doomed.map((object) => object.key).toSorted()).toEqual(firstOnly.toSorted());
  expect((await keys(fallbackPin)).every((key) => store.objects.has(key))).toBe(true);
  expect((await pruneUnreferenced(adapter, store, false)).deleted).toBe(0);

  await nameIndex(manifests.fallback, firstPin.index);
  const before = [...store.objects.keys()].toSorted();
  await expect(pruneUnreferenced(adapter, store, false)).rejects.toThrow("is not stored");
  expect([...store.objects.keys()].toSorted()).toEqual(before);
});
