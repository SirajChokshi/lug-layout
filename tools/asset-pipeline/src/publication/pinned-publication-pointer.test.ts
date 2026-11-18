import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { afterEach, expect, it } from "vitest";
import {
  decodeJsonFile,
  movePointer,
  pinnedIndexPointer,
  pruneUnreferenced,
  readPointer,
  runPointerCommand,
  uploadPublication,
  verifyServedPointer,
  type PinnedIndex,
  type PointerAdapter,
  type PointerCommands,
  type Publication,
} from "./pinned-publication.ts";
import { contentAddressedName } from "../publish.ts";
import { sha256Hex, type PrunableStore, type StoredObject } from "../r2.ts";

const INDEX_FILE = "toy.json";
const ToyListing = v.strictObject({ indexes: v.array(v.string()), leaves: v.array(v.string()) });

interface ToyPin {
  readonly index: PinnedIndex;
}

function list(file: string, bytes: Uint8Array) {
  const listing = decodeJsonFile(ToyListing, bytes, file);
  return { indexes: listing.indexes.map((name) => ({ file: name })), leaves: listing.leaves };
}

const toy: Publication<ToyPin> = {
  prefix: "toy",
  indexFile: INDEX_FILE,
  leafNoun: "leaves",
  rebuildCommand: "toy --check",
  pinnedIndex: (pin) => pin.index,
  list,
  contentType: () => "application/octet-stream",
};
const pointer = pinnedIndexPointer(toy, list, "latest.json");

class MemoryStore implements PrunableStore {
  readonly objects = new Map<string, Uint8Array>();

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }

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

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function addressed(root: string, file: string, text: string): Promise<string> {
  const name = contentAddressedName(file, sha256Hex(text));
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), text);
  return name;
}

interface Release {
  readonly root: string;
  readonly pin: ToyPin;
  readonly keys: ReadonlyArray<string>;
}

async function release(leaves: ReadonlyArray<string>): Promise<Release> {
  const root = await mkdtemp(join(tmpdir(), "pinned-pointer-"));
  roots.push(root);
  const names = await Promise.all(
    leaves.map((leaf) => addressed(root, `leaves/${leaf}.bin`, leaf)),
  );
  const group = await addressed(
    root,
    `groups/${leaves.join("")}.json`,
    JSON.stringify({ indexes: [], leaves: names }),
  );
  const text = JSON.stringify({ indexes: [group], leaves: [] });
  await writeFile(join(root, INDEX_FILE), text);
  const sha256 = sha256Hex(text);
  return {
    root,
    pin: { index: { file: INDEX_FILE, sha256 } },
    keys: [...names, group, contentAddressedName(INDEX_FILE, sha256)].map((file) => `toy/${file}`),
  };
}

async function publish(store: MemoryStore, leaves: ReadonlyArray<string>): Promise<Release> {
  const published = await release(leaves);
  await uploadPublication(toy, store, published.root, published.pin);
  await movePointer(pointer, store, published.pin.index);
  return published;
}

function leafKeys(store: MemoryStore): string[] {
  return [...store.objects.keys()].filter((key) => key.startsWith("toy/leaves/")).toSorted();
}

function leafKey(leaf: string): string {
  return `toy/${contentAddressedName(`leaves/${leaf}.bin`, sha256Hex(leaf))}`;
}

it("keeps exactly what the current and previous manifests reference, and a second prune deletes nothing", async () => {
  const store = new MemoryStore();
  await publish(store, ["a", "b"]);
  const second = await publish(store, ["b", "c"]);
  const third = await publish(store, ["c", "d"]);
  const before = [...store.objects.keys()];

  const pruned = await pruneUnreferenced(pointer, store, false);
  const again = await pruneUnreferenced(pointer, store, false);

  const live = new Set([pointer.key, ...second.keys, ...third.keys]);
  expect([...store.objects.keys()].toSorted()).toEqual([...live].toSorted());
  expect(pruned.doomed.map((object) => object.key).toSorted()).toEqual(
    before.filter((key) => !live.has(key)).toSorted(),
  );
  expect(pruned.doomed.map((object) => object.key)).toContain(leafKey("a"));
  expect(again.deleted).toBe(0);
});

it("keeps a leaf the previous manifest still references after a third release", async () => {
  const store = new MemoryStore();
  await publish(store, ["a"]);
  await publish(store, ["a", "b"]);
  await publish(store, ["b", "c"]);

  await pruneUnreferenced(pointer, store, false);

  expect(leafKeys(store)).toEqual(["a", "b", "c"].map(leafKey).toSorted());
});

it("moves the pointer: the first manifest has no previous, a new one shifts current to previous, the same one leaves it", async () => {
  const store = new MemoryStore();
  const read = (key: string) => store.get(key);

  const first = await publish(store, ["a"]);
  const afterFirst = await readPointer(pointer, read);
  const second = await publish(store, ["b"]);
  const afterSecond = await readPointer(pointer, read);
  const repeat = await movePointer(pointer, store, second.pin.index);

  expect(afterFirst).toEqual({ current: first.pin.index, previous: null });
  expect(afterSecond).toEqual({ current: second.pin.index, previous: first.pin.index });
  expect(repeat).toEqual({ pointer: afterSecond, moved: false });
});

it("refuses to point at a manifest the bucket doesn't hold", async () => {
  const store = new MemoryStore();
  const { pin } = await release(["a"]);

  await expect(movePointer(pointer, store, pin.index)).rejects.toThrow("is not stored");
  expect(store.objects.has(pointer.key)).toBe(false);
});

async function threeReleases(): Promise<{ store: MemoryStore; oldest: Release; previous: ToyPin }> {
  const store = new MemoryStore();
  const oldest = await publish(store, ["a"]);
  const previous = await publish(store, ["b"]);
  await publish(store, ["c"]);
  return { store, oldest, previous: previous.pin };
}

function previousIndexKey(previous: ToyPin): string {
  return `toy/${contentAddressedName(INDEX_FILE, previous.index.sha256)}`;
}

it("refuses and deletes nothing when the previous manifest is missing, differs from its pin, or lists an index that differs from its content address", async () => {
  const missing = await threeReleases();
  missing.store.objects.delete(previousIndexKey(missing.previous));
  const corrupt = await threeReleases();
  corrupt.store.objects.set(previousIndexKey(corrupt.previous), new TextEncoder().encode("{}"));
  const nested = await threeReleases();
  const groupKey = [...nested.store.objects.keys()].find((key) => key.startsWith("toy/groups/b."));
  if (groupKey === undefined) throw new Error("no group index stored");
  nested.store.objects.set(
    groupKey,
    new TextEncoder().encode(JSON.stringify({ indexes: [], leaves: [] })),
  );

  for (const { store, reason } of [
    { store: missing.store, reason: "is not stored" },
    { store: corrupt.store, reason: "differs from its pinned SHA-256" },
    { store: nested.store, reason: "differs from its content address" },
  ]) {
    const before = [...store.objects.keys()].toSorted();
    await expect(pruneUnreferenced(pointer, store, false)).rejects.toThrow(reason);
    expect([...store.objects.keys()].toSorted()).toEqual(before);
  }
});

it("refuses and deletes nothing when no pointer is stored", async () => {
  const store = new MemoryStore();
  const { root, pin } = await release(["a"]);
  await uploadPublication(toy, store, root, pin);
  const before = store.objects.size;

  await expect(pruneUnreferenced(pointer, store, false)).rejects.toThrow(
    "nothing says what is live",
  );
  expect(store.objects.size).toBe(before);
});

it("a dry run deletes nothing and lists exactly what the prune then deletes", async () => {
  const { store } = await threeReleases();
  const before = store.objects.size;

  const dry = await pruneUnreferenced(pointer, store, true);
  const unchanged = store.objects.size;
  const real = await pruneUnreferenced(pointer, store, false);

  expect(unchanged).toBe(before);
  expect(dry.deleted).toBe(0);
  expect(dry.doomed).toEqual(real.doomed);
  expect(real.deleted).toBe(dry.doomed.length);
});

it("keeps and verifies every file of a manifest the adapter retains, beside the current and previous manifests", async () => {
  const { store, oldest } = await threeReleases();
  const retaining = { ...pointer, retained: async () => [oldest.pin.index] };
  const read = (key: string) => store.get(key);

  const pruned = await pruneUnreferenced(retaining, store, false);
  const intact = await verifyServedPointer(retaining, read, "all");
  store.objects.set(leafKey("a"), new TextEncoder().encode("tampered"));
  const tampered = await verifyServedPointer(retaining, read, "all");

  expect(pruned.deleted).toBe(0);
  expect(oldest.keys.every((key) => store.objects.has(key))).toBe(true);
  expect(intact).toEqual([]);
  expect(tampered).toEqual([`${leafKey("a")} differs from its SHA-256`]);
});

it("refuses and deletes nothing when the manifests reference nothing", async () => {
  const { store } = await threeReleases();
  const before = store.objects.size;
  const empty = { ...pointer, references: async () => ({ indexes: [], files: [] }) };

  await expect(pruneUnreferenced(empty, store, false)).rejects.toThrow("reference nothing");
  expect(store.objects.size).toBe(before);
});

class PointingWhileListing extends MemoryStore {
  constructor(private readonly pointDuringListing: (store: MemoryStore) => Promise<void>) {
    super();
  }

  override async list(prefix: string): Promise<ReadonlyArray<StoredObject>> {
    const listed = await super.list(prefix);
    await this.pointDuringListing(this);
    return listed;
  }
}

it("refuses and deletes nothing when the pointer moves while the bucket is listed", async () => {
  const next = await release(["d"]);
  const store = new PointingWhileListing((bucket) =>
    movePointer(pointer, bucket, next.pin.index).then(() => undefined),
  );
  await publish(store, ["a"]);
  await publish(store, ["b"]);
  await publish(store, ["c"]);
  await uploadPublication(toy, store, next.root, next.pin);
  const before = store.objects.size;

  await expect(pruneUnreferenced(pointer, store, false)).rejects.toThrow(
    "changed during the prune",
  );
  expect(store.objects.size).toBe(before);
  expect(next.keys.every((key) => store.objects.has(key))).toBe(true);
});

it("refuses and deletes nothing when the manifests the adapter retains change while the bucket is listed", async () => {
  let retainedNow: PinnedIndex[] = [];
  const store = new PointingWhileListing(async () => {
    retainedNow = [oldest.pin.index];
  });
  const oldest = await publish(store, ["a"]);
  await publish(store, ["b"]);
  await publish(store, ["c"]);
  const retaining = { ...pointer, retained: async () => retainedNow };
  const before = store.objects.size;

  await expect(pruneUnreferenced(retaining, store, false)).rejects.toThrow(
    "keeps changed during the prune",
  );
  expect(store.objects.size).toBe(before);
  expect(oldest.keys.every((key) => store.objects.has(key))).toBe(true);
});

it("verifies every referenced file against the SHA-256 its manifest gives, content-addressed or not", async () => {
  const store = new MemoryStore();
  const part = new TextEncoder().encode("1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
  const library: PointerAdapter<string> = {
    ...pointer,
    key: "library/latest.json",
    prefixes: ["library/"],
    decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
    encode: (state) => new TextEncoder().encode(JSON.stringify(state)),
    sameManifest: (a, b) => a === b,
    describeManifest: (commit) => commit,
    references: async (commit) => ({
      indexes: [],
      files: [
        { key: `library/${commit}/parts/3001.dat`, sha256Prefix: sha256Hex(part) },
        { key: `library/${commit}/parts/short.dat`, sha256Prefix: "ab" },
      ],
    }),
    retained: async () => [],
  };
  const read = (key: string) => store.get(key);
  await store.put(library.key, library.encode({ current: "c1", previous: null }));
  await store.put("library/c1/parts/3001.dat", part);
  await store.put("library/c1/parts/short.dat", part);

  const intact = await verifyServedPointer(library, read, "all");
  await store.put("library/c1/parts/3001.dat", new TextEncoder().encode("0 tampered\n"));
  const tampered = await verifyServedPointer(library, read, "all");

  expect(intact).toEqual(["library/c1/parts/short.dat names no usable SHA-256 prefix"]);
  expect(tampered).toEqual([
    "library/c1/parts/3001.dat differs from its SHA-256",
    "library/c1/parts/short.dat names no usable SHA-256 prefix",
  ]);
});

it("refuses a pointer command flag it does not know before touching the bucket", async () => {
  const untouchable: PointerCommands<ToyPin, PinnedIndex> = {
    publication: toy,
    storeConfigPath: "/nonexistent/store.json",
    root: "/nonexistent",
    readPin: () => Promise.reject(new Error("read the pin")),
    describeVerified: () => "",
    pointer,
    manifestOf: (pin) => pin.index,
  };

  await expect(runPointerCommand(untouchable, ["prune", "--dryrun"])).rejects.toThrow(
    "prune takes --dry-run; it does not take --dryrun",
  );
  await expect(runPointerCommand(untouchable, ["point", "--all"])).rejects.toThrow(
    "point takes no flags; it does not take --all",
  );
});
