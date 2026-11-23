import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
import { httpReader } from "../library/ldraw-library.ts";
import { contentAddressedName } from "../publish.ts";
import { sha256Hex, type ObjectStore } from "../r2.ts";
import * as v from "valibot";

const OK = 200;
const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;
const THROTTLED_READ_TIMEOUT_MS = 30_000;

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

function listedShelf(_file: string, bytes: Uint8Array, pin: ShelfPin): IndexListing {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    shelves?: string[];
    items?: string[];
  };
  return {
    indexes: (parsed.shelves ?? []).map((shelf) => ({ file: shelf, leaves: pin.items })),
    leaves: parsed.items ?? [],
  };
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

it("refuses an index tree that loops back to its pinned index, and verify-served reports it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinned-publication-"));
  roots.push(root);
  const item = await addressed(root, "a.json", encoder.encode('{"a":1}'));
  const looping = encoder.encode(JSON.stringify({ items: [item], shelves: ["shelf.json"] }));
  const inner = await addressed(root, "items.json", looping);
  const index = encoder.encode(JSON.stringify({ shelves: [inner] }));
  await writeFile(join(root, "shelf.json"), index);
  const pin = { index: { file: "shelf.json", sha256: sha256Hex(index) }, items: 1 };
  await expect(uploadPublication(shelf, new MemoryStore(), root, pin)).rejects.toThrow(
    "shelf.json is listed by more than one index",
  );
  const store = new MemoryStore();
  await store.put(`shelf/${inner}`, looping, {});
  await store.put(`shelf/${item}`, encoder.encode('{"a":1}'), {});
  await store.put(publicationIndexKey(shelf, pin), index, {});
  expect(await verifyServedPublication(shelf, store.read, pin, "all")).toEqual([
    "shelf.json is listed by more than one index",
  ]);
});

it(
  "verify-served reads every file through a public bucket that answers each file's first request with 429, and still reports the tampered one",
  async () => {
    const { root, pin } = await shelfBuild();
    const store = new MemoryStore();
    await uploadPublication(shelf, store, root, pin);
    const leaf = [...store.objects.keys()].find((key) => key.endsWith(".glb")) ?? "";
    store.objects.set(leaf, { body: new Uint8Array([9]), type: undefined });
    const throttled = new Set<string>();
    const server = createServer((request, response) => {
      const key = decodeURIComponent((request.url ?? "/").slice(1));
      if (!throttled.has(key)) {
        throttled.add(key);
        response.statusCode = TOO_MANY_REQUESTS;
        response.end();
        return;
      }
      const object = store.objects.get(key);
      response.statusCode = object === undefined ? NOT_FOUND : OK;
      response.end(object?.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const read = httpReader(`http://127.0.0.1:${port}/`);
      expect(await verifyServedPublication(shelf, read, pin, "all")).toEqual([
        `${leaf} differs from its content address`,
      ]);
      expect(throttled).toEqual(new Set(store.objects.keys()));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
  THROTTLED_READ_TIMEOUT_MS,
);
