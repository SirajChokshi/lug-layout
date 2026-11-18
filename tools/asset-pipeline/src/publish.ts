import {
  BundleIndex,
  CreditTableFile,
  CrosswalkFile,
  FarMeshGltfDocument,
  GltfDocument,
  ModelFile,
  PartShape,
  PartTableFile,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import * as v from "valibot";
import { readPngHeader } from "./thumbnails/png.ts";
import { THUMBNAIL_PX } from "./thumbnails/rasterizer.ts";

export const MANIFEST_FILE = "manifest.json";
export const CROSSWALK_FILE = "crosswalk.json";
export const CONTENT_HASH_HEX_DIGITS = 16;

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_LENGTH_OFFSET = 12;
const GLB_JSON_OFFSET = 20;

const CompiledIndex = v.omit(BundleIndex, ["bundleVersion", "inputs"]);

export interface PublishedBundle {
  readonly bundleVersion: string;
  readonly files: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function glbJson(bytes: Buffer, label: string): unknown {
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${label} is not a GLB file`);
  const length = bytes.readUInt32LE(GLB_JSON_LENGTH_OFFSET);
  return JSON.parse(bytes.subarray(GLB_JSON_OFFSET, GLB_JSON_OFFSET + length).toString("utf8"));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function undeclaredKeys(raw: unknown, decoded: unknown, path: string): ReadonlyArray<string> {
  if (Array.isArray(raw) && Array.isArray(decoded)) {
    return raw.flatMap((item, index) => undeclaredKeys(item, decoded[index], `${path}[]`));
  }
  if (!isRecord(raw) || !isRecord(decoded)) return [];
  return Object.entries(raw).flatMap(([key, value]) =>
    key in decoded ? undeclaredKeys(value, decoded[key], `${path}.${key}`) : [`${path}.${key}`],
  );
}

function decodeDeclared<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: unknown,
  label: string,
): v.InferOutput<TSchema> {
  const value = decodedOrThrow(decode(schema, raw), label);
  const undeclared = [...new Set(undeclaredKeys(raw, value, "$"))];
  if (undeclared.length > 0) {
    throw new Error(`${label}: no schema declares ${undeclared.join(", ")}`);
  }
  return value;
}

export async function bundleFiles(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
}

export function contentAddressedName(file: string, digest: string): string {
  const extension = extname(file);
  return `${file.slice(0, -extension.length)}.${digest.slice(0, CONTENT_HASH_HEX_DIGITS)}${extension}`;
}

export async function attachCrosswalk(directory: string, crosswalk: unknown): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof compiled !== "object" || compiled === null) {
    throw new Error(`${manifestPath} is not a compiled bundle`);
  }
  await writeFile(join(directory, CROSSWALK_FILE), JSON.stringify(crosswalk));
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...compiled, crosswalk: { file: CROSSWALK_FILE } }, null, 2)}\n`,
  );
}

function addressedFiles(raw: unknown, renamed: ReadonlyMap<string, string>): unknown {
  return JSON.parse(
    JSON.stringify(raw, (key, value: unknown) =>
      key === "file" && typeof value === "string" ? (renamed.get(value) ?? value) : value,
    ),
  );
}

export async function publishBundle(
  directory: string,
  inputs: v.InferInput<typeof BundleIndex>["inputs"],
): Promise<PublishedBundle> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = decodeDeclared(CompiledIndex, compiled, manifestPath);
  const renamed = new Map<string, string>();
  const publish = async (file: string): Promise<Buffer> => {
    const bytes = await readFile(join(directory, file));
    const name = contentAddressedName(file, sha256(bytes));
    await rename(join(directory, file), join(directory, name));
    renamed.set(file, name);
    return bytes;
  };
  const readJson = async <const TSchema extends v.GenericSchema>(
    schema: TSchema,
    file: string,
  ): Promise<{ readonly raw: unknown; readonly value: v.InferOutput<TSchema> }> => {
    const raw: unknown = JSON.parse(await readFile(join(directory, file), "utf8"));
    return { raw, value: decodeDeclared(schema, raw, file) };
  };
  const publishJson = async (schema: v.GenericSchema, file: string): Promise<void> => {
    const { raw } = await readJson(schema, file);
    await writeFile(join(directory, file), JSON.stringify(addressedFiles(raw, renamed)));
    await publish(file);
  };
  const { value: partTable } = await readJson(PartTableFile, manifest.partTable.file);
  for (const { file } of [...manifest.studPrimitives, ...partTable.parts]) {
    decodeDeclared(GltfDocument, glbJson(await publish(file), file), file);
  }
  for (const { file } of manifest.thumbnails) {
    const { width, height } = readPngHeader(await publish(file), file);
    if (width !== THUMBNAIL_PX || height !== THUMBNAIL_PX) {
      throw new Error(`${file} is ${width}×${height}, not ${THUMBNAIL_PX}×${THUMBNAIL_PX}`);
    }
  }
  await publishJson(PartTableFile, manifest.partTable.file);
  for (const { file } of manifest.models) await publishJson(ModelFile, file);
  for (const { farMesh } of manifest.models) {
    if (farMesh) {
      decodeDeclared(
        FarMeshGltfDocument,
        glbJson(await publish(farMesh.file), farMesh.file),
        farMesh.file,
      );
    }
  }
  if (manifest.compiler !== null) await publish(manifest.compiler.file);
  decodeDeclared(
    CrosswalkFile,
    JSON.parse((await publish(manifest.crosswalk.file)).toString("utf8")),
    manifest.crosswalk.file,
  );
  for (const { shape } of manifest.catalogParts) await publishJson(PartShape, shape.file);
  await publishJson(CreditTableFile, manifest.creditTable.file);
  const published = new Set(renamed.values());
  const unreferenced = (await bundleFiles(directory)).filter(
    (name) => name !== MANIFEST_FILE && !published.has(name),
  );
  if (unreferenced.length > 0) {
    throw new Error(`${directory} has files the manifest does not reference: ${unreferenced}`);
  }
  const addressed = addressedFiles(compiled, renamed);
  if (!isRecord(addressed)) throw new Error(`${manifestPath} is not a bundle index`);
  const body = { ...addressed, inputs };
  const bundleVersion = sha256(JSON.stringify(body)).slice(0, CONTENT_HASH_HEX_DIGITS);
  const publishedManifest = { bundleVersion, ...body };
  decodeDeclared(BundleIndex, publishedManifest, manifestPath);
  await writeFile(manifestPath, `${JSON.stringify(publishedManifest, null, 2)}\n`);
  return { bundleVersion, files: published.size };
}
