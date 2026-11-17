import { BundleManifest, FarMeshGltfDocument, GltfDocument, ModelFile } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as v from "valibot";

export const MANIFEST_FILE = "manifest.json";
export const CONTENT_HASH_HEX_DIGITS = 16;

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_LENGTH_OFFSET = 12;
const GLB_JSON_OFFSET = 20;

const CompiledManifest = v.omit(BundleManifest, ["bundleVersion", "inputs"]);

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

export function contentAddressedName(file: string, digest: string): string {
  const extension = extname(file);
  return `${file.slice(0, -extension.length)}.${digest.slice(0, CONTENT_HASH_HEX_DIGITS)}${extension}`;
}

export async function publishBundle(
  directory: string,
  inputs: v.InferInput<typeof BundleManifest>["inputs"],
): Promise<PublishedBundle> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = decodeDeclared(CompiledManifest, compiled, manifestPath);
  const renamed = new Map<string, string>();
  const publish = async (file: string): Promise<Buffer> => {
    const bytes = await readFile(join(directory, file));
    const name = contentAddressedName(file, sha256(bytes));
    await rename(join(directory, file), join(directory, name));
    renamed.set(file, name);
    return bytes;
  };
  for (const { file } of [...manifest.studPrimitives, ...manifest.parts]) {
    decodeDeclared(GltfDocument, glbJson(await publish(file), file), file);
  }
  for (const { file } of manifest.models) {
    decodeDeclared(ModelFile, JSON.parse((await publish(file)).toString("utf8")), file);
  }
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
  const published = new Set(renamed.values());
  const unreferenced = (await readdir(directory)).filter(
    (name) => name !== MANIFEST_FILE && !published.has(name),
  );
  if (unreferenced.length > 0) {
    throw new Error(`${directory} has files the manifest does not reference: ${unreferenced}`);
  }
  const addressed: Record<string, unknown> = JSON.parse(
    JSON.stringify(compiled, (key, value: unknown) =>
      key === "file" && typeof value === "string" ? (renamed.get(value) ?? value) : value,
    ),
  );
  const body = { ...addressed, inputs };
  const bundleVersion = sha256(JSON.stringify(body)).slice(0, CONTENT_HASH_HEX_DIGITS);
  const publishedManifest = { bundleVersion, ...body };
  decodeDeclared(BundleManifest, publishedManifest, manifestPath);
  await writeFile(manifestPath, `${JSON.stringify(publishedManifest, null, 2)}\n`);
  return { bundleVersion, files: published.size };
}
