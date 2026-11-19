import {
  contentAddressedFile,
  LIBRARY_BAKE_BUCKETS,
  LIBRARY_BAKE_FORMAT,
  LIBRARY_BAKE_INDEX_FILE,
  libraryBakeBucket,
  type LibraryBakeIndex,
  type LibraryBakePart,
} from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { LibraryBakeStore, type IByteCache, type RecordOptions } from "./library-bake-store.ts";
import type { FetchFunction } from "./ldraw-mirror.ts";

const BASE_URL = "https://records.test/library-bake/";
const HTTP_NOT_FOUND = 404;
const SOURCE = { repo: "kulits/ldraw-parts", commit: "c0ffee", root: "ldraw" };
const PRIMITIVES = {
  source: { kind: "github-mirror" as const, ...SOURCE },
  license: "CC BY 4.0",
  primitives: [],
};
const OPTIONS: RecordOptions = {
  source: SOURCE,
  studPrimitives: ["stud.dat", "stud2.dat"],
  unofficialAllowlist: [],
  primitives: PRIMITIVES,
};
const PARTS = ["ldraw:3001", "ldraw:3002", "ldraw:3626c"];

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Served {
  readonly files: Map<string, Uint8Array>;
  readonly pin: { readonly file: string; readonly sha256: string };
  readonly parts: ReadonlyMap<string, LibraryBakePart>;
}

function served(change: (index: LibraryBakeIndex) => LibraryBakeIndex = (index) => index): Served {
  const files = new Map<string, Uint8Array>();
  const add = (file: string, bytes: Uint8Array): string => {
    const name = contentAddressedFile(file, sha256(bytes));
    files.set(name, bytes);
    return name;
  };
  const parts = new Map<string, LibraryBakePart>();
  const buckets: Array<Record<string, LibraryBakePart>> = Array.from(
    { length: LIBRARY_BAKE_BUCKETS },
    () => ({}),
  );
  for (const id of PARTS) {
    const stem = id.slice("ldraw:".length);
    const part = {
      record: add(`records/${stem}.bin`, new TextEncoder().encode(`record ${stem}`)),
      glb: add(`standard/${stem}.glb`, new TextEncoder().encode(`glb ${stem}`)),
    };
    parts.set(id, part);
    const bucket = buckets[libraryBakeBucket(id)];
    if (bucket) bucket[id] = part;
  }
  const bucketFiles = buckets.map((bucketParts, bucket) =>
    add(
      `buckets/${String(bucket).padStart(3, "0")}.json`,
      new TextEncoder().encode(JSON.stringify({ bucket, parts: bucketParts })),
    ),
  );
  const index = change({
    format: LIBRARY_BAKE_FORMAT,
    source: { kind: "github-mirror", ...SOURCE },
    options: {
      studPrimitives: OPTIONS.studPrimitives,
      unofficialAllowlist: [],
      primitives: PRIMITIVES,
    },
    licenses: [],
    buckets: bucketFiles,
    failed: {},
  });
  const text = new TextEncoder().encode(JSON.stringify(index));
  add(LIBRARY_BAKE_INDEX_FILE, text);
  return { files, pin: { file: LIBRARY_BAKE_INDEX_FILE, sha256: sha256(text) }, parts };
}

const HTTP_UNAVAILABLE = 503;

function serving(
  files: ReadonlyMap<string, Uint8Array>,
  requests: string[] = [],
  failing: (file: string) => boolean = () => false,
): FetchFunction {
  return async (url) => {
    requests.push(url);
    const file = url.slice(BASE_URL.length);
    if (failing(file)) return new Response(null, { status: HTTP_UNAVAILABLE });
    const bytes = files.get(file);
    return bytes === undefined
      ? new Response(null, { status: HTTP_NOT_FOUND })
      : new Response(bytes.slice());
  };
}

function memoryCache(): IByteCache & { readonly held: Map<string, Uint8Array> } {
  const held = new Map<string, Uint8Array>();
  return {
    held,
    get: async (key) => held.get(key),
    put: async (key, bytes) => void held.set(key, bytes),
  };
}

it("finds the pinned parts asked for, verifies their bytes and serves them again from the cache", async () => {
  const { files, pin, parts } = served();
  const cache = memoryCache();
  const requests: string[] = [];
  const store = new LibraryBakeStore(BASE_URL, pin, serving(files, requests), cache);

  const found = await store.lookup(["ldraw:3001", "ldraw:3626c", "ldraw:not-pinned"], OPTIONS);

  expect(found).toEqual(
    new Map([
      ["ldraw:3001", parts.get("ldraw:3001")],
      ["ldraw:3626c", parts.get("ldraw:3626c")],
    ]),
  );
  const part = found.get("ldraw:3001");
  if (!part) throw new Error("3001 not found");
  expect(new TextDecoder().decode(await store.bytes(part.record))).toBe("record 3001");
  expect(new TextDecoder().decode(await store.bytes(part.glb))).toBe("glb 3001");
  const again = new LibraryBakeStore(BASE_URL, pin, serving(files, requests), cache);
  const before = requests.length;
  await again.lookup(["ldraw:3001"], OPTIONS);
  expect(new TextDecoder().decode(await again.bytes(part.glb))).toBe("glb 3001");
  expect(requests.length).toBe(before);
  expect(again.stats().fetched).toBe(0);
});

it("offers nothing when the served index is not the pinned one", async () => {
  const { files, pin } = served();
  const other = { ...pin, sha256: sha256("another index") };
  const store = new LibraryBakeStore(BASE_URL, other, serving(files), memoryCache());

  expect(await store.lookup(PARTS, OPTIONS)).toEqual(new Map());
});

it("offers nothing for an import compiled with other stud primitives, allowlist, Technic primitive table or LDraw source", async () => {
  const { files, pin } = served();
  const store = new LibraryBakeStore(BASE_URL, pin, serving(files), memoryCache());

  expect(await store.lookup(PARTS, { ...OPTIONS, studPrimitives: ["stud.dat"] })).toEqual(
    new Map(),
  );
  expect(await store.lookup(PARTS, { ...OPTIONS, unofficialAllowlist: ["x.dat"] })).toEqual(
    new Map(),
  );
  expect(await store.lookup(PARTS, { ...OPTIONS, source: { ...SOURCE, commit: "other" } })).toEqual(
    new Map(),
  );
  expect(await store.lookup(PARTS, { ...OPTIONS, primitives: null })).toEqual(new Map());
  expect(
    await store.lookup(PARTS, { ...OPTIONS, primitives: { ...PRIMITIVES, license: "other" } }),
  ).toEqual(new Map());
  expect((await store.lookup(PARTS, OPTIONS)).size).toBe(PARTS.length);
});

it("refuses and never caches bytes that differ from their content address", async () => {
  const { files, pin, parts } = served();
  const part = parts.get("ldraw:3002");
  if (!part) throw new Error("3002 missing");
  files.set(part.record, new TextEncoder().encode("tampered"));
  const cache = memoryCache();
  const store = new LibraryBakeStore(BASE_URL, pin, serving(files), cache);

  await store.lookup(PARTS, OPTIONS);
  await expect(store.bytes(part.record)).rejects.toThrow("differs from its content address");
  expect(cache.held.has(part.record)).toBe(false);
});

it("finds nothing in a bucket that is not served, and still finds the rest", async () => {
  const { files, pin } = served();
  const missing = libraryBakeBucket("ldraw:3001");
  const store = new LibraryBakeStore(
    BASE_URL,
    pin,
    serving(
      new Map(
        [...files].filter(
          ([file]) => !file.startsWith(`buckets/${String(missing).padStart(3, "0")}.`),
        ),
      ),
    ),
    memoryCache(),
  );

  const found = await store.lookup(PARTS, OPTIONS);
  expect(found.has("ldraw:3001")).toBe(false);
  expect(found.size).toBe(PARTS.filter((id) => libraryBakeBucket(id) !== missing).length);
});

it("replaces a cached record whose bytes no longer match its content address", async () => {
  const { files, pin, parts } = served();
  const part = parts.get("ldraw:3001");
  if (!part) throw new Error("3001 missing");
  const cache = memoryCache();
  cache.held.set(part.record, new TextEncoder().encode("poisoned"));
  const store = new LibraryBakeStore(BASE_URL, pin, serving(files), cache);

  await store.lookup(PARTS, OPTIONS);

  expect(new TextDecoder().decode(await store.bytes(part.record))).toBe("record 3001");
  expect(new TextDecoder().decode(cache.held.get(part.record))).toBe("record 3001");
});

it("reads the pinned index from the server again when the cached copy fails its pin", async () => {
  const { files, pin } = served();
  const indexFile = contentAddressedFile(pin.file, pin.sha256);
  const cache = memoryCache();
  cache.held.set(indexFile, new TextEncoder().encode("poisoned"));
  const store = new LibraryBakeStore(BASE_URL, pin, serving(files), cache);

  expect((await store.lookup(PARTS, OPTIONS)).size).toBe(PARTS.length);
  expect(cache.held.get(indexFile)).toEqual(files.get(indexFile));
});

it("tries a failed index or bucket download again on the next lookup", async () => {
  const { files, pin } = served();
  const indexFile = contentAddressedFile(pin.file, pin.sha256);
  let failing = (file: string): boolean => file === indexFile;
  const store = new LibraryBakeStore(
    BASE_URL,
    pin,
    serving(files, [], (file) => failing(file)),
    memoryCache(),
  );

  const indexDown = await store.lookup(PARTS, OPTIONS);
  failing = (file) => file.startsWith("buckets/");
  const bucketsDown = await store.lookup(PARTS, OPTIONS);
  failing = () => false;
  const recovered = await store.lookup(PARTS, OPTIONS);

  expect([indexDown.size, bucketsDown.size, recovered.size]).toEqual([0, 0, PARTS.length]);
});
