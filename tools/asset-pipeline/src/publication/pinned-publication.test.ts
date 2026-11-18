import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  publicationIndexKey,
  uploadPublication,
  verifyServedPublication,
  writeOrCheckPin,
  type IndexListing,
  type Publication,
} from "./pinned-publication.ts";
import { contentAddressedName } from "../publish.ts";
import { sha256Hex, type ObjectStore } from "../r2.ts";
import * as v from "valibot";

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; type: string | undefined }>();
  readonly order: string[] = [];

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(
    key: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.objects.set(key, { body, type: headers["Content-Type"] });
    this.order.push(key);
  }

  readonly read = async (key: string): Promise<Uint8Array | undefined> =>
    this.objects.get(key)?.body;
}

interface ShelfPin {
  readonly index: { readonly file: string; readonly sha256: string };
  readonly items: number;
}

const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function listedShelf(file: string, bytes: Uint8Array, pin: ShelfPin): IndexListing {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    shelves?: string[];
    items?: string[];
  };
  return file === "shelf.json"
    ? {
        indexes: (parsed.shelves ?? []).map((shelf) => ({ file: shelf, leaves: pin.items })),
        leaves: [],
      }
    : { indexes: [], leaves: parsed.items ?? [] };
}

const shelf: Publication<ShelfPin> = {
  prefix: "shelf",
  indexFile: "shelf.json",
  leafNoun: "items",
  rebuildCommand: "shelf --check",
  pinnedIndex: (pin) => pin.index,
  list: listedShelf,
  contentType: (file) => (file.endsWith(".glb") ? "model/gltf-binary" : "application/json"),
};

async function addressed(root: string, file: string, body: Uint8Array): Promise<string> {
  const name = contentAddressedName(file, sha256Hex(body));
  await writeFile(join(root, name), body);
  return name;
}

async function shelfBuild(): Promise<{ root: string; pin: ShelfPin }> {
  const root = await mkdtemp(join(tmpdir(), "pinned-publication-"));
  roots.push(root);
  const items = [
    await addressed(root, "a.glb", new Uint8Array([1, 2, 3])),
    await addressed(root, "b.json", encoder.encode('{"b":1}')),
  ];
  const inner = await addressed(root, "items.json", encoder.encode(JSON.stringify({ items })));
  const index = encoder.encode(JSON.stringify({ shelves: [inner] }));
  await writeFile(join(root, "shelf.json"), index);
  return { root, pin: { index: { file: "shelf.json", sha256: sha256Hex(index) }, items: 2 } };
}

it("publishes every file an index tree names, the pinned index last and each with its own content type", async () => {
  const { root, pin } = await shelfBuild();
  const store = new MemoryStore();
  expect(await uploadPublication(shelf, store, root, pin)).toEqual({ uploaded: 4, present: 0 });
  expect(await uploadPublication(shelf, store, root, pin)).toEqual({ uploaded: 0, present: 4 });
  expect(store.order.at(-1)).toBe(publicationIndexKey(shelf, pin));
  const types = [...store.objects].map(([key, { type }]) => [key.split(".").at(-1), type]);
  expect(types).toContainEqual(["glb", "model/gltf-binary"]);
  expect(await verifyServedPublication(shelf, store.read, pin, "all")).toEqual([]);
});

it("reports unserved, tampered and miscounted files and refuses an index that isn't the pinned one", async () => {
  const { root, pin } = await shelfBuild();
  const store = new MemoryStore();
  await uploadPublication(shelf, store, root, pin);
  const leaf = [...store.objects.keys()].find((key) => key.endsWith(".glb")) ?? "";
  store.objects.set(leaf, { body: new Uint8Array([9]), type: undefined });
  expect(await verifyServedPublication(shelf, store.read, pin, "indexes")).toEqual([]);
  expect(await verifyServedPublication(shelf, store.read, pin, "all")).toEqual([
    `${leaf} differs from its content address`,
  ]);
  const miscounted = await verifyServedPublication(
    shelf,
    store.read,
    { ...pin, items: 3 },
    "indexes",
  );
  expect(miscounted).toHaveLength(1);
  expect(miscounted[0]).toMatch(/lists 2 items, the pin 3$/u);
  const other = { ...pin, index: { ...pin.index, sha256: "0".repeat(64) } };
  await expect(uploadPublication(shelf, new MemoryStore(), root, other)).rejects.toThrow(
    "run shelf --check",
  );
});

it("writes a pin, then reports whether a rebuild matches it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinned-publication-"));
  roots.push(root);
  const path = join(root, "pin.json");
  const schema = v.object({ index: v.string() });
  expect(await writeOrCheckPin(path, schema, { index: "a" }, false)).toBe("written");
  expect(await writeOrCheckPin(path, schema, { index: "a" }, true)).toBe("matches");
  expect(await writeOrCheckPin(path, schema, { index: "b" }, true)).toBe("differs");
});
