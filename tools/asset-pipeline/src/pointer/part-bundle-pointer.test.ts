import { BundleLod } from "@brr/schema/bundle";
import { BUNDLE_POINTER_FILE, BundlePointer } from "@brr/schema/bundle-pointer";
import { decode } from "@brr/schema/decode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { movePointer, pruneUnreferenced } from "../publication/pinned-publication.ts";
import { contentAddressedName } from "../publish.ts";
import { sha256Hex, type PrunableStore, type StoredObject } from "../r2.ts";
import { partBundlePointer } from "./part-bundle-pointer.ts";

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

const encoder = new TextEncoder();

function store(objects: MemoryStore, lod: string, file: string, text: string): string {
  const name = contentAddressedName(file, sha256Hex(text));
  objects.objects.set(`${lod}/${name}`, encoder.encode(text));
  return name;
}

function manifestFile(version: string): string {
  return `manifest.${sha256Hex(version).slice(0, 16)}.json`;
}

const TOP_SURFACE_44343P02 = {
  stepsPerLdu: 16,
  top: 0,
  origin: [-5120, -5120],
  size: [32, 2],
  cells: [".ffffffffffffffffffffffffffffff.", "fffffff.ffffffffffffffff.fffffff"],
};

function publish(objects: MemoryStore, version: string, parts: ReadonlyArray<string>): string[] {
  const file = manifestFile(version);
  const keys: string[] = [];
  for (const lod of BundleLod.options) {
    const glbs = parts.map((part) => store(objects, lod, `${part}.glb`, `${lod} mesh ${part}`));
    const shapes = parts.map((part) =>
      store(
        objects,
        lod,
        `shape-${part}.json`,
        JSON.stringify({ id: part, topSurface: TOP_SURFACE_44343P02 }),
      ),
    );
    const glyphs = parts.map((part) =>
      store(objects, lod, `${part}.glyph`, `${lod} glyph ${part}`),
    );
    const table = store(
      objects,
      lod,
      "parts.json",
      JSON.stringify({ parts: glbs, shapes, glyphs }),
    );
    const thumb = store(objects, lod, "thumb/ground.png", `${lod} thumb ${parts.length}`);
    const manifest = JSON.stringify({ bundleVersion: version, partTable: table, thumbs: [thumb] });
    objects.objects.set(`${lod}/${file}`, encoder.encode(manifest));
    keys.push(`${lod}/${file}`, `${lod}/${table}`, `${lod}/${thumb}`);
    keys.push(...glbs.map((glb) => `${lod}/${glb}`), ...shapes.map((shape) => `${lod}/${shape}`));
    keys.push(...glyphs.map((glyph) => `${lod}/${glyph}`));
  }
  return keys;
}

async function fallbackNaming(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundle-fallback-"));
  roots.push(root);
  const path = join(root, "bundle-fallback.json");
  await writeFile(path, JSON.stringify({ manifest_file: manifestFile(version) }));
  return path;
}

it("writes a pointer every deployed app still reads, and reads the pointer they wrote before", () => {
  const adapter = partBundlePointer("/unused");
  const written = adapter.encode({ current: manifestFile("b"), previous: manifestFile("a") });
  const read = decode(BundlePointer, JSON.parse(new TextDecoder().decode(written)), "pointer");
  expect(read.ok && read.value.manifestFile).toBe(manifestFile("b"));
  const legacy = encoder.encode(JSON.stringify({ manifestFile: manifestFile("a") }));
  expect(adapter.decode(legacy)).toEqual({ current: manifestFile("a"), previous: null });
});

it("keeps every file the three LOD manifests reach, through nested JSON, without taking a top-surface row for a file name, and refuses a missing or altered index", async () => {
  const objects = new MemoryStore();
  const keys = publish(objects, "a", ["3001", "3002"]);
  const adapter = partBundlePointer("/unused");
  const read = (key: string) => objects.get(key);
  const references = await adapter.references(manifestFile("a"), read);
  expect([...references.indexes, ...references.files.map((file) => file.key)].toSorted()).toEqual(
    keys.toSorted(),
  );

  const table = keys.find((key) => key.startsWith("low/parts."));
  const original = table === undefined ? undefined : objects.objects.get(table);
  if (table === undefined || original === undefined) throw new Error("no low part table");
  objects.objects.set(table, encoder.encode(JSON.stringify({ parts: [] })));
  await expect(adapter.references(manifestFile("a"), read)).rejects.toThrow(
    `${table} differs from its content address`,
  );
  objects.objects.delete(table);
  await expect(adapter.references(manifestFile("a"), read)).rejects.toThrow(
    `${table} is not stored`,
  );
  objects.objects.set(table, original);
  objects.objects.delete(`far/${manifestFile("a")}`);
  await expect(adapter.references(manifestFile("a"), read)).rejects.toThrow(
    `far/${manifestFile("a")} is not stored`,
  );
});

it("prunes the bundle prefixes to the current, previous and committed fallback bundles, leaving shared files, the pointer and other prefixes", async () => {
  const objects = new MemoryStore();
  const fallback = publish(objects, "fallback", ["3001", "3003"]);
  const first = publish(objects, "a", ["3001", "3004"]);
  const second = publish(objects, "b", ["3001", "3005"]);
  const third = publish(objects, "c", ["3001", "3006"]);
  objects.objects.set("library-bake/latest.json", encoder.encode("{}"));
  const adapter = partBundlePointer(await fallbackNaming("fallback"));
  for (const version of ["a", "b", "c"]) await movePointer(adapter, objects, manifestFile(version));

  const outcome = await pruneUnreferenced(adapter, objects, false);

  const kept = new Set([...fallback, ...second, ...third, BUNDLE_POINTER_FILE]);
  const gone = first.filter((key) => !kept.has(key));
  expect(gone.length).toBeGreaterThan(0);
  expect(outcome.doomed.map((object) => object.key).toSorted()).toEqual(gone.toSorted());
  expect([...objects.objects.keys()].toSorted()).toEqual(
    [...kept, "library-bake/latest.json"].toSorted(),
  );
  expect((await pruneUnreferenced(adapter, objects, false)).deleted).toBe(0);
});

it("refuses to prune, deleting nothing, while the committed fallback's manifests are missing", async () => {
  const objects = new MemoryStore();
  publish(objects, "a", ["3001"]);
  publish(objects, "b", ["3002"]);
  const adapter = partBundlePointer(await fallbackNaming("fallback"));
  for (const version of ["a", "b"]) await movePointer(adapter, objects, manifestFile(version));
  const before = [...objects.objects.keys()];

  await expect(pruneUnreferenced(adapter, objects, false)).rejects.toThrow(
    `standard/${manifestFile("fallback")} is not stored`,
  );
  expect([...objects.objects.keys()]).toEqual(before);
});
