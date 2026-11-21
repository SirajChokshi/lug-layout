import {
  CONNECTIVITY_LICENSE,
  contentAddressedFile,
  SHADOW_LIBRARY_FORMAT,
  SHADOW_LIBRARY_INDEX_FILE,
} from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ShadowMirror } from "./shadow-mirror.ts";
import { NO_BYTE_CACHE } from "./verified-files.ts";

const BASE = "https://bucket.example/shadow-library";
const STUD = "0 !LDCAD SNAP_CYL [gender=M]\n";
const MANIFEST = '{"patches":[{"part":"2959","status":"verified"}]}';
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function addressed(file: string, text: string): string {
  return contentAddressedFile(file, sha256(text));
}

const STUD_FILE = addressed("shadow/p/stud.dat", STUD);
const MANIFEST_FILE = addressed("patches/manifest.json", MANIFEST);

const INDEX = JSON.stringify({
  format: SHADOW_LIBRARY_FORMAT,
  source: { kind: "github-archive", repo: "owner/shadow", commit: "def", root: "" },
  license: CONNECTIVITY_LICENSE,
  attribution: ["LDCad Shadow Library"],
  shadow: { "p/stud.dat": STUD_FILE },
  patches: {},
  patchManifest: { file: MANIFEST_FILE },
  licenseText: { file: "patches/LICENSE.0000000000000000.md" },
});
const PIN = { file: SHADOW_LIBRARY_INDEX_FILE, sha256: sha256(INDEX) };
const INDEX_FILE = contentAddressedFile(PIN.file, PIN.sha256);

function served(files: Readonly<Record<string, string>>) {
  const requested: string[] = [];
  let unavailable = 0;
  const fetchUrl = async (url: string): Promise<Response> => {
    const file = url.slice(BASE.length + 1);
    requested.push(file);
    if (unavailable > 0) {
      unavailable--;
      return new Response(null, { status: HTTP_UNAVAILABLE });
    }
    const text = files[file];
    return text === undefined ? new Response(null, { status: HTTP_NOT_FOUND }) : new Response(text);
  };
  return {
    fetchUrl,
    requested,
    failNext: (count: number) => {
      unavailable = count;
    },
  };
}

it("fetches a listed shadow file once its content matches its address, and reports a path the index does not list absent without a request", async () => {
  const { fetchUrl, requested } = served({ [INDEX_FILE]: INDEX, [STUD_FILE]: STUD });
  const mirror = new ShadowMirror(BASE, PIN, fetchUrl, NO_BYTE_CACHE);

  const probe = await mirror.probe(
    ["shadow:p/stud.dat", "shadow:parts/3001.dat", "shadow-patch:parts/3001.dat"],
    4,
  );

  expect([...probe.found]).toEqual([["shadow:p/stud.dat", STUD]]);
  expect(probe.absent.toSorted()).toEqual(["shadow-patch:parts/3001.dat", "shadow:parts/3001.dat"]);
  expect(requested).toEqual([INDEX_FILE, STUD_FILE]);
});

it("hands back the patch manifest the pinned index names", async () => {
  const { fetchUrl } = served({ [INDEX_FILE]: INDEX, [MANIFEST_FILE]: MANIFEST });
  const mirror = new ShadowMirror(BASE, PIN, fetchUrl, NO_BYTE_CACHE);

  expect(await mirror.manifest()).toEqual(JSON.parse(MANIFEST));
});

it("refuses an index that is not the pinned one, and a shadow file whose content is not the one its address names", async () => {
  const other = served({ [contentAddressedFile(PIN.file, "0".repeat(64))]: INDEX });
  const unpinned = new ShadowMirror(
    BASE,
    { ...PIN, sha256: "0".repeat(64) },
    other.fetchUrl,
    NO_BYTE_CACHE,
  );
  await expect(unpinned.probe(["shadow:p/stud.dat"], 1)).rejects.toThrow("differs from its pinned");

  const tampered = served({ [INDEX_FILE]: INDEX, [STUD_FILE]: "0 tampered\n" });
  const mirror = new ShadowMirror(BASE, PIN, tampered.fetchUrl, NO_BYTE_CACHE);
  await expect(mirror.probe(["shadow:p/stud.dat"], 1)).rejects.toThrow(
    `${STUD_FILE} differs from its content address`,
  );
});

it("reads the index again on the next probe after a failed read", async () => {
  const { fetchUrl, requested, failNext } = served({ [INDEX_FILE]: INDEX, [STUD_FILE]: STUD });
  const mirror = new ShadowMirror(BASE, PIN, fetchUrl, NO_BYTE_CACHE);
  failNext(1);

  await expect(mirror.probe(["shadow:p/stud.dat"], 1)).rejects.toThrow(`${HTTP_UNAVAILABLE}`);
  const probe = await mirror.probe(["shadow:p/stud.dat"], 1);

  expect([...probe.found]).toEqual([["shadow:p/stud.dat", STUD]]);
  expect(requested).toEqual([INDEX_FILE, INDEX_FILE, STUD_FILE]);
});
