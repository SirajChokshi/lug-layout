import { BundleLod, type GithubMirror } from "@brr/schema/bundle";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { partBundlePointer } from "../pointer/part-bundle-pointer.ts";
import { movePointer, pruneUnreferenced } from "../publication/pinned-publication.ts";
import { sha256Hex, type PrunableStore, type StoredObject } from "../r2.ts";
import { libraryIndexKey, libraryObjectKey } from "./ldraw-library.ts";
import { ldrawLibraryPointer, liveBundleSources } from "./library-pointer.ts";

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

function mirror(commit: string): GithubMirror {
  return { kind: "github-mirror", repo: "kulits/ldraw-parts", commit, root: "ldraw" };
}

function publishLibrary(objects: MemoryStore, commit: string, parts: ReadonlyArray<string>) {
  const source = mirror(commit);
  const files: Record<string, string> = {};
  const keys: string[] = [];
  for (const part of parts) {
    const text = `0 ${part} at ${commit}\n`;
    const path = `parts/${part}.dat`;
    files[path] = sha256Hex(text);
    objects.objects.set(libraryObjectKey(source, path), encoder.encode(text));
    keys.push(libraryObjectKey(source, path));
  }
  const index = {
    format: 1,
    source,
    archive: { file: `${commit}.tar.gz`, sha256: sha256Hex(commit) },
    files,
  };
  objects.objects.set(libraryIndexKey(source), encoder.encode(JSON.stringify(index)));
  keys.push(libraryIndexKey(source));
  return keys;
}

function manifestFile(version: string): string {
  return `manifest.${sha256Hex(version).slice(0, 16)}.json`;
}

function publishBundle(bundles: MemoryStore, version: string, commit: string): void {
  for (const lod of BundleLod.options) {
    const manifest = JSON.stringify({ bundleVersion: version, source: mirror(commit) });
    bundles.objects.set(`${lod}/${manifestFile(version)}`, encoder.encode(manifest));
  }
}

async function fallbackNaming(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "library-fallback-"));
  roots.push(root);
  const path = join(root, "bundle-fallback.json");
  await writeFile(path, JSON.stringify({ manifest_file: manifestFile(version) }));
  return path;
}

async function pointBundles(bundles: MemoryStore, versions: ReadonlyArray<string>): Promise<void> {
  const adapter = partBundlePointer("/unused");
  for (const version of versions) {
    const previous = (await bundles.get(adapter.key)) ?? null;
    const pointer = {
      current: manifestFile(version),
      previous: previous === null ? null : adapter.decode(previous).current,
    };
    await bundles.put(adapter.key, adapter.encode(pointer));
  }
}

it("references a commit's index and every file it lists by full SHA-256, and refuses an index for another commit", async () => {
  const objects = new MemoryStore();
  const keys = publishLibrary(objects, "a".repeat(40), ["3001", "3002"]);
  const adapter = ldrawLibraryPointer(async () => []);
  const read = (key: string) => objects.get(key);

  const references = await adapter.references(mirror("a".repeat(40)), read);
  expect([...references.indexes, ...references.files.map((file) => file.key)].toSorted()).toEqual(
    keys.toSorted(),
  );
  expect(references.files.every((file) => file.sha256Prefix.length === 64)).toBe(true);

  const other = objects.objects.get(libraryIndexKey(mirror("a".repeat(40))));
  if (other === undefined) throw new Error("no index");
  objects.objects.set(libraryIndexKey(mirror("b".repeat(40))), other);
  await expect(adapter.references(mirror("b".repeat(40)), read)).rejects.toThrow(
    `indexes kulits/ldraw-parts@${"a".repeat(40)}/ldraw, not kulits/ldraw-parts@${"b".repeat(40)}/ldraw`,
  );
  await expect(adapter.references(mirror("c".repeat(40)), read)).rejects.toThrow("is not stored");
});

it("reads the commits the current, previous and committed fallback bundles name, and refuses without the bundle pointer or a manifest", async () => {
  const bundles = new MemoryStore();
  const read = (key: string) => bundles.get(key);
  const fallback = await fallbackNaming("fallback");
  await expect(liveBundleSources(read, fallback)).rejects.toThrow(
    "current/latest.json is not served",
  );
  publishBundle(bundles, "fallback", "f".repeat(40));
  publishBundle(bundles, "a", "1".repeat(40));
  publishBundle(bundles, "b", "2".repeat(40));
  publishBundle(bundles, "c", "2".repeat(40));
  await pointBundles(bundles, ["a", "b", "c"]);

  expect(await liveBundleSources(read, fallback)).toEqual([
    mirror("2".repeat(40)),
    mirror("f".repeat(40)),
  ]);

  bundles.objects.delete(`low/${manifestFile("fallback")}`);
  await expect(liveBundleSources(read, fallback)).rejects.toThrow(
    `low/${manifestFile("fallback")} is not served`,
  );
});

it("prunes the bucket to the current and previous commits and those the live bundles name, and refuses while one of those is missing", async () => {
  const objects = new MemoryStore();
  const bundled = publishLibrary(objects, "0".repeat(40), ["3001"]);
  const first = publishLibrary(objects, "1".repeat(40), ["3001", "3002"]);
  const second = publishLibrary(objects, "2".repeat(40), ["3001", "3003"]);
  const third = publishLibrary(objects, "3".repeat(40), ["3001", "3004"]);
  objects.objects.set("stray/left-over.dat", encoder.encode("left over"));
  let retained = [mirror("0".repeat(40))];
  const adapter = ldrawLibraryPointer(async () => retained);
  for (const commit of ["1", "2", "3"])
    await movePointer(adapter, objects, mirror(commit.repeat(40)));

  const outcome = await pruneUnreferenced(adapter, objects, false);

  const kept = [...bundled, ...second, ...third, adapter.key].toSorted();
  expect([...objects.objects.keys()].toSorted()).toEqual(kept);
  expect(outcome.doomed.map((object) => object.key).toSorted()).toEqual(
    [...first, "stray/left-over.dat"].toSorted(),
  );
  expect((await pruneUnreferenced(adapter, objects, false)).deleted).toBe(0);

  retained = [mirror("9".repeat(40))];
  await expect(pruneUnreferenced(adapter, objects, false)).rejects.toThrow("is not stored");
  expect([...objects.objects.keys()].toSorted()).toEqual(kept);
});
