import { CONNECTIVITY_LICENSE, ShadowLibraryIndex } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publicationIndexKey, uploadPublication } from "../publication/pinned-publication.ts";
import type { ObjectStore } from "../r2.ts";
import { assembleShadowLibrary, SHADOW_LIBRARY_INDEX } from "./assemble.ts";
import { shadowLibraryPublication } from "./publish.ts";

const archive = {
  name: "ldcad-shadow-library",
  file: "ldcad-shadow-library.tar.gz",
  sha256: "a".repeat(64),
  source: { kind: "github-archive" as const, repo: "owner/shadow", commit: "def", root: "" },
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brr-shadow-"));
  directories.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

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

it("indexes every shadow and patch file by its library path under its content address, and publishes them all under shadow-library/ with the pinned index under its pinned hash", async () => {
  const shadowRoot = await tree({
    "parts/s/3001s01.dat": "0 !LDCAD SNAP_CYL [gender=M]\n",
    "p/stud.dat": "0 !LDCAD SNAP_CYL [gender=M]\n",
  });
  const patchesRoot = await tree({
    "parts/2959.dat": "0 !LDCAD SNAP_CYL [gender=F]\n",
    "manifest.json": '{"ldraw":{},"patches":[{"part":"2959","status":"verified"}]}',
    "LICENSE.md": "Attribution-ShareAlike 4.0 International\n",
  });
  const out = await mkdtemp(join(tmpdir(), "brr-shadow-out-"));
  directories.push(out);

  const pin = await assembleShadowLibrary({ shadowRoot, patchesRoot, out, archive });
  const index = decodedOrThrow(
    decode(ShadowLibraryIndex, JSON.parse(await readFile(join(out, SHADOW_LIBRARY_INDEX), "utf8"))),
    SHADOW_LIBRARY_INDEX,
  );
  expect(pin.files).toEqual({ shadow: 2, patches: 1 });
  expect(index.license).toBe(CONNECTIVITY_LICENSE);
  expect(Object.keys(index.shadow).toSorted()).toEqual(["p/stud.dat", "parts/s/3001s01.dat"]);
  expect(index.shadow["parts/s/3001s01.dat"]).toMatch(
    /^shadow\/parts\/s\/3001s01\.[0-9a-f]{16}\.dat$/u,
  );
  expect(Object.keys(index.patches)).toEqual(["parts/2959.dat"]);
  expect(await readFile(join(out, index.patchManifest.file), "utf8")).toBe(
    await readFile(join(patchesRoot, "manifest.json"), "utf8"),
  );

  const store = new RecordingStore();
  await uploadPublication(shadowLibraryPublication, store, out, pin);
  const written = (await readdir(out, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(out, join(entry.parentPath, entry.name)))
    .filter((file) => file !== SHADOW_LIBRARY_INDEX);
  const indexKey = `shadow-library/shadow-library.${pin.index.sha256.slice(0, 16)}.json`;
  expect(publicationIndexKey(shadowLibraryPublication, pin)).toBe(indexKey);
  expect([...store.types.keys()].toSorted()).toEqual(
    [...written.map((file) => `shadow-library/${file}`), indexKey].toSorted(),
  );
  expect(store.types.get(`shadow-library/${index.patchManifest.file}`)).toBe("application/json");
  expect(store.types.get(`shadow-library/${index.shadow["p/stud.dat"]}`)).toBe(
    "text/plain; charset=utf-8",
  );
});
