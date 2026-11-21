import {
  CONNECTIVITY_LICENSE,
  SHADOW_LIBRARY_FORMAT,
  SHADOW_LIBRARY_INDEX_FILE,
  type ShadowLibraryIndex,
  type ShadowLibraryPin,
} from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { PATCH_ATTRIBUTION, shadowLibraryAttribution } from "../library-connectors/assemble.ts";
import { contentAddressedName } from "../publish.ts";
import type { PinnedShadowArchive } from "../section-vocabulary.ts";

export const SHADOW_LIBRARY_PIN = "tools/asset-pipeline/shadow-library.json";
const PATCH_MANIFEST = "manifest.json";
const PATCH_LICENSE = "LICENSE.md";
const LIBRARY_FILE_EXTENSION = ".dat";

export interface ShadowLibraryInputs {
  readonly shadowRoot: string;
  readonly patchesRoot: string;
  readonly out: string;
  readonly archive: PinnedShadowArchive;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function libraryFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(LIBRARY_FILE_EXTENSION))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
}

async function addressed(out: string, file: string, bytes: Uint8Array): Promise<string> {
  const name = contentAddressedName(file, sha256(bytes));
  await mkdir(dirname(join(out, name)), { recursive: true });
  await writeFile(join(out, name), bytes);
  return name;
}

async function addressedTree(
  root: string,
  out: string,
  folder: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await libraryFiles(root)) {
    files[path] = await addressed(out, `${folder}/${path}`, await readFile(join(root, path)));
  }
  return files;
}

export async function assembleShadowLibrary(
  inputs: ShadowLibraryInputs,
): Promise<ShadowLibraryPin> {
  const { shadowRoot, patchesRoot, out, archive } = inputs;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const manifest = await readFile(join(patchesRoot, PATCH_MANIFEST));
  const index: ShadowLibraryIndex = {
    format: SHADOW_LIBRARY_FORMAT,
    source: archive.source,
    license: CONNECTIVITY_LICENSE,
    attribution: [shadowLibraryAttribution(archive.source), PATCH_ATTRIBUTION],
    shadow: await addressedTree(shadowRoot, out, "shadow"),
    patches: await addressedTree(patchesRoot, out, "patches"),
    patchManifest: { file: await addressed(out, `patches/${PATCH_MANIFEST}`, manifest) },
    licenseText: {
      file: await addressed(
        out,
        `patches/${PATCH_LICENSE}`,
        await readFile(join(patchesRoot, PATCH_LICENSE)),
      ),
    },
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(index)}\n`);
  await writeFile(join(out, SHADOW_LIBRARY_INDEX_FILE), bytes);
  await addressed(out, SHADOW_LIBRARY_INDEX_FILE, bytes);
  return {
    index: { file: SHADOW_LIBRARY_INDEX_FILE, sha256: sha256(bytes) },
    archive: { file: archive.file, sha256: archive.sha256 },
    patchManifest: sha256(manifest),
    files: { shadow: Object.keys(index.shadow).length, patches: Object.keys(index.patches).length },
  };
}
