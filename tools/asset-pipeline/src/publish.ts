import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Palette } from "./palette.ts";

export const MANIFEST_FILE = "manifest.json";
export const CONTENT_HASH_HEX_DIGITS = 16;

export interface BundleInputs {
  readonly ldraw: Palette["source"];
  readonly omr: Palette["source"];
  readonly lockSha256: string;
  readonly paletteSha256: string;
}

interface FileReference {
  file: string;
}

interface CompiledManifest {
  parts: FileReference[];
  studPrimitives: FileReference[];
  models: FileReference[];
  compiler: FileReference | null;
  [key: string]: unknown;
}

export interface PublishedBundle {
  readonly bundleVersion: string;
  readonly files: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isFileReferenceList(value: unknown): value is FileReference[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)["file"] === "string",
    )
  );
}

function isCompiledManifest(value: unknown): value is CompiledManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isFileReferenceList(candidate["parts"]) &&
    isFileReferenceList(candidate["studPrimitives"]) &&
    isFileReferenceList(candidate["models"]) &&
    (candidate["compiler"] === null || isFileReferenceList([candidate["compiler"]]))
  );
}

export function contentAddressedName(file: string, digest: string): string {
  const extension = extname(file);
  return `${file.slice(0, -extension.length)}.${digest.slice(0, CONTENT_HASH_HEX_DIGITS)}${extension}`;
}

export async function publishBundle(
  directory: string,
  inputs: BundleInputs,
): Promise<PublishedBundle> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isCompiledManifest(compiled)) throw new Error(`${manifestPath} is not a compiled bundle`);
  const references = [
    ...compiled.studPrimitives,
    ...compiled.parts,
    ...compiled.models,
    ...(compiled.compiler ? [compiled.compiler] : []),
  ];
  const published = new Set<string>();
  for (const reference of references) {
    const digest = sha256(await readFile(join(directory, reference.file)));
    const name = contentAddressedName(reference.file, digest);
    await rename(join(directory, reference.file), join(directory, name));
    reference.file = name;
    published.add(name);
  }
  const unreferenced = (await readdir(directory)).filter(
    (name) => name !== MANIFEST_FILE && !published.has(name),
  );
  if (unreferenced.length > 0) {
    throw new Error(`${directory} has files the manifest does not reference: ${unreferenced}`);
  }
  const body = { ...compiled, inputs };
  const bundleVersion = sha256(JSON.stringify(body)).slice(0, CONTENT_HASH_HEX_DIGITS);
  await writeFile(manifestPath, `${JSON.stringify({ bundleVersion, ...body }, null, 2)}\n`);
  return { bundleVersion, files: published.size };
}
