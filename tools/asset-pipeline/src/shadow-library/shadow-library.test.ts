import {
  CONNECTIVITY_LICENSE,
  SHADOW_LIBRARY_INDEX_FILE,
  ShadowLibraryIndex,
  ShadowLibraryPin,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { PATCH_ATTRIBUTION } from "../library-connectors/assemble.ts";
import { publicationIndexKey, uploadPublication } from "../publication/pinned-publication.ts";
import { contentAddressedName } from "../publish.ts";
import type { ObjectStore } from "../r2.ts";
import { assembleShadowLibrary, SHADOW_LIBRARY_PIN } from "./assemble.ts";
import { shadowLibraryPublication } from "./publish.ts";

const archive = {
  name: "ldcad-shadow-library",
  file: "ldcad-shadow-library.tar.gz",
  sha256: "a".repeat(64),
  source: { kind: "github-archive" as const, repo: "owner/shadow", commit: "def", root: "" },
};
const SHADOW_FILES = {
  "parts/s/3001s01.dat": "0 !LDCAD SNAP_CYL [gender=M]\n",
  "p/stud.dat": "0 !LDCAD SNAP_CYL [gender=M]\n",
};
const PATCH_FILES = {
  "parts/2959.dat": "0 !LDCAD SNAP_CYL [gender=F]\n",
  "manifest.json": '{"ldraw":{},"patches":[{"part":"2959","status":"verified"}]}',
  "LICENSE.md": "Attribution-ShareAlike 4.0 International\n",
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

async function assembled() {
  const patchesRoot = await tree(PATCH_FILES);
  const out = await mkdtemp(join(tmpdir(), "brr-shadow-out-"));
  directories.push(out);
  const pin = await assembleShadowLibrary({
    shadowRoot: await tree(SHADOW_FILES),
    patchesRoot,
    out,
    archive,
  });
  return { pin, out, patchesRoot };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function publishedType(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
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

it("indexes every shadow and patch file by its library path under its content address, under CC BY-SA with the connectivity package's attribution", async () => {
  const { pin, out, patchesRoot } = await assembled();
  const indexText = await readFile(join(out, SHADOW_LIBRARY_INDEX_FILE), "utf8");
  const index = decodedOrThrow(decode(ShadowLibraryIndex, JSON.parse(indexText)), "index");

  expect(pin).toEqual({
    index: { file: SHADOW_LIBRARY_INDEX_FILE, sha256: sha256(indexText) },
    archive: { file: archive.file, sha256: archive.sha256 },
    patchManifest: sha256(PATCH_FILES["manifest.json"]),
    files: { shadow: 2, patches: 1 },
  });
  expect(
    await readFile(
      join(out, contentAddressedName(SHADOW_LIBRARY_INDEX_FILE, pin.index.sha256)),
      "utf8",
    ),
  ).toBe(indexText);
  expect(index.license).toBe(CONNECTIVITY_LICENSE);
  expect(index.attribution).toEqual([
    `LDCad Shadow Library by Roland Melkert and the LDCad Shadow Library contributors, github.com/owner/shadow at def, ${CONNECTIVITY_LICENSE}`,
    PATCH_ATTRIBUTION,
  ]);
  for (const [folder, files, listed] of [
    ["shadow", SHADOW_FILES, index.shadow],
    ["patches", { "parts/2959.dat": PATCH_FILES["parts/2959.dat"] }, index.patches],
  ] as const) {
    expect(Object.keys(listed).toSorted()).toEqual(Object.keys(files).toSorted());
    for (const [path, text] of Object.entries(files)) {
      const file = listed[path] ?? "";
      expect(file).toBe(
        `${folder}/${path.replace(/\.dat$/u, "")}.${sha256(text).slice(0, 16)}.dat`,
      );
      expect(await readFile(join(out, file), "utf8")).toBe(text);
    }
  }
  expect(await readFile(join(out, index.patchManifest.file), "utf8")).toBe(
    await readFile(join(patchesRoot, "manifest.json"), "utf8"),
  );
  expect(await readFile(join(out, index.licenseText.file), "utf8")).toBe(PATCH_FILES["LICENSE.md"]);
});

it("publishes every file the assembly wrote under shadow-library/, with the pinned index under its pinned hash", async () => {
  const { pin, out } = await assembled();
  const store = new RecordingStore();

  await uploadPublication(shadowLibraryPublication, store, out, pin);

  const pinnedIndex = contentAddressedName(SHADOW_LIBRARY_INDEX_FILE, pin.index.sha256);
  const indexKey = `shadow-library/${pinnedIndex}`;
  expect(publicationIndexKey(shadowLibraryPublication, pin)).toBe(indexKey);
  const written = (await readdir(out, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(out, join(entry.parentPath, entry.name)))
    .filter((file) => file !== SHADOW_LIBRARY_INDEX_FILE && file !== pinnedIndex);
  expect(new Map([...store.types].toSorted())).toEqual(
    new Map(
      [
        ...written.map((file): [string, string] => [`shadow-library/${file}`, publishedType(file)]),
        [indexKey, "application/json"] as [string, string],
      ].toSorted(),
    ),
  );
});

it("routes the CLI's served command to the committed pin's index under shadow-library/", async () => {
  const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pinPath = join(toolRoot, "..", "..", SHADOW_LIBRARY_PIN);
  const committed = decodedOrThrow(
    decode(ShadowLibraryPin, JSON.parse(await readFile(pinPath, "utf8"))),
    pinPath,
  );
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(`${request.method} ${request.url}`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/shadow-library/cli.ts", "served"],
      {
        cwd: toolRoot,
        env: {
          ...process.env,
          PART_BUNDLE_BASE_URL: `http://127.0.0.1:${port}/`,
          GITHUB_OUTPUT: "",
        },
      },
    );
    const indexPath = `/shadow-library/shadow-library.${committed.index.sha256.slice(0, 16)}.json`;
    expect(requested).toEqual([`HEAD ${indexPath}`]);
    expect(stdout).toBe(`http://127.0.0.1:${port}${indexPath}: served\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
