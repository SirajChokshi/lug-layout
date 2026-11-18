import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { afterEach, expect, it } from "vitest";
import {
  decodeJsonFile,
  movePointer,
  pinnedIndexPointer,
  prunePointed,
  readPointer,
  uploadPublication,
  type PinnedIndex,
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

  const pruned = await prunePointed(pointer, store, false);
  const again = await prunePointed(pointer, store, false);

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

  await prunePointed(pointer, store, false);

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

async function threeReleases(): Promise<{ store: MemoryStore; previous: ToyPin }> {
  const store = new MemoryStore();
  await publish(store, ["a"]);
  const previous = await publish(store, ["b"]);
  await publish(store, ["c"]);
  return { store, previous: previous.pin };
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
    await expect(prunePointed(pointer, store, false)).rejects.toThrow(reason);
    expect([...store.objects.keys()].toSorted()).toEqual(before);
  }
});

it("refuses and deletes nothing when no pointer is stored", async () => {
  const store = new MemoryStore();
  const { root, pin } = await release(["a"]);
  await uploadPublication(toy, store, root, pin);
  const before = store.objects.size;

  await expect(prunePointed(pointer, store, false)).rejects.toThrow("nothing says what is live");
  expect(store.objects.size).toBe(before);
});

it("a dry run deletes nothing and lists exactly what the prune then deletes", async () => {
  const { store } = await threeReleases();
  const before = store.objects.size;

  const dry = await prunePointed(pointer, store, true);
  const unchanged = store.objects.size;
  const real = await prunePointed(pointer, store, false);

  expect(unchanged).toBe(before);
  expect(dry.deleted).toBe(0);
  expect(dry.doomed).toEqual(real.doomed);
  expect(real.deleted).toBe(dry.doomed.length);
});

it("keeps what the adapter's extra references name, beside the current and previous manifests", async () => {
  const { store } = await threeReleases();
  const oldest = leafKey("a");
  const keeping = { ...pointer, extra: async () => new Set([oldest]) };

  await prunePointed(keeping, store, false);

  expect(store.objects.has(oldest)).toBe(true);
  expect(leafKeys(store)).toEqual(["a", "b", "c"].map(leafKey).toSorted());
});
