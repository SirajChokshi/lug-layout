import { CONNECTIVITY_LICENSE, SHADOW_LIBRARY_FORMAT } from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ShadowMirror } from "./shadow-mirror.ts";

const BASE = "https://bucket.example/shadow-library/";
const STUD = "0 !LDCAD SNAP_CYL [gender=M]\n";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function served(files: Readonly<Record<string, string>>) {
  const requested: string[] = [];
  const fetchUrl = async (url: string): Promise<Response> => {
    requested.push(url);
    const text = files[url.slice(BASE.length)];
    return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
  };
  return { fetchUrl, requested };
}

function indexNaming(studFile: string): string {
  return JSON.stringify({
    format: SHADOW_LIBRARY_FORMAT,
    source: { kind: "github-archive", repo: "owner/shadow", commit: "def", root: "" },
    license: CONNECTIVITY_LICENSE,
    attribution: ["LDCad Shadow Library"],
    shadow: { "p/stud.dat": studFile },
    patches: {},
    patchManifest: { file: "patches/manifest.0000000000000000.json" },
    licenseText: { file: "patches/LICENSE.0000000000000000.md" },
  });
}

it("fetches a listed shadow file once its content matches its address, reports an unlisted one absent without a request, and refuses an index that is not the pinned one", async () => {
  const studFile = `shadow/p/stud.${sha256(STUD).slice(0, 16)}.dat`;
  const index = indexNaming(studFile);
  const { fetchUrl, requested } = served({ "shadow-library.json": index, [studFile]: STUD });
  const mirror = new ShadowMirror(
    { indexUrl: `${BASE}shadow-library.json`, sha256: sha256(index) },
    fetchUrl,
  );

  const probe = await mirror.probe(["shadow:p/stud.dat", "shadow:parts/3001.dat"], 4);

  expect([...probe.found]).toEqual([["shadow:p/stud.dat", STUD]]);
  expect(probe.absent).toEqual(["shadow:parts/3001.dat"]);
  expect(requested).toEqual([`${BASE}shadow-library.json`, `${BASE}${studFile}`]);

  const other = new ShadowMirror(
    { indexUrl: `${BASE}shadow-library.json`, sha256: "0".repeat(64) },
    fetchUrl,
  );
  await expect(other.probe(["shadow:p/stud.dat"], 1)).rejects.toThrow("not the pinned");
});

it("refuses a shadow file whose content is not the one its address names", async () => {
  const studFile = `shadow/p/stud.${sha256(STUD).slice(0, 16)}.dat`;
  const index = indexNaming(studFile);
  const { fetchUrl } = served({ "shadow-library.json": index, [studFile]: "0 tampered\n" });
  const mirror = new ShadowMirror(
    { indexUrl: `${BASE}shadow-library.json`, sha256: sha256(index) },
    fetchUrl,
  );

  await expect(mirror.probe(["shadow:p/stud.dat"], 1)).rejects.toThrow(
    `${studFile} is not named by its content hash`,
  );
});
