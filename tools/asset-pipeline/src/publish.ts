import {
  BundleIndex,
  ConnectorIndexFile,
  ConnectorRecordFile,
  type ConnectorPackage,
  CreditTableFile,
  CrosswalkFile,
  FarMeshGltfDocument,
  GltfDocument,
  LibraryBakePin,
  LibraryConnectorsPin,
  ModelFile,
  PartShape,
  PartTableFile,
  RollingDiagnosticsFile,
  rollingDiagnosticsFit,
  type RollingDiagnosticsRef,
  SectionVocabularyFile,
  type SectionVocabularyRef,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import * as v from "valibot";
import {
  connectorPackageIssues,
  sectionVocabularyIssues,
  sectionVocabularyValues,
} from "./connector-license.ts";
import { readPngHeader } from "./thumbnails/png.ts";
import { THUMBNAIL_PX } from "./thumbnails/rasterizer.ts";

export const MANIFEST_FILE = "manifest.json";
export const CROSSWALK_FILE = "crosswalk.json";
export const SECTION_VOCABULARY_FILE = "section-vocabulary.json";
export const ROLLING_DIAGNOSTICS_FILE = "rolling-diagnostics.json";
const LEAKED_PATHS_SHOWN = 3;
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

function refuseSectionVocabularyValues(raw: unknown, label: string): void {
  const paths = sectionVocabularyValues(raw);
  if (paths.length === 0) return;
  const shown = paths.slice(0, LEAKED_PATHS_SHOWN).join(", ");
  const more =
    paths.length > LEAKED_PATHS_SHOWN ? ` and ${paths.length - LEAKED_PATHS_SHOWN} more` : "";
  throw new Error(
    `${label} carries section vocabulary values at ${shown}${more}; they ship only in the CC BY-SA section vocabulary asset`,
  );
}

function decodeDeclared<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: unknown,
  label: string,
): v.InferOutput<TSchema> {
  refuseSectionVocabularyValues(raw, label);
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

async function attachCompilerPin(
  directory: string,
  field: "libraryBake" | "libraryConnectors",
  index: { readonly file: string; readonly sha256: string },
): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(compiled)) throw new Error(`${manifestPath} is not a compiled bundle`);
  const { compiler } = compiled;
  if (compiler === null) return;
  if (!isRecord(compiler)) throw new Error(`${manifestPath} has no compiler section`);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...compiled, compiler: { ...compiler, [field]: index } }, null, 2)}\n`,
  );
}

export async function attachLibraryBake(directory: string, pinPath: string): Promise<void> {
  const pin = decodedOrThrow(
    decode(LibraryBakePin, JSON.parse(await readFile(pinPath, "utf8"))),
    pinPath,
  );
  await attachCompilerPin(directory, "libraryBake", pin.index);
}

export async function attachLibraryConnectors(directory: string, pinPath: string): Promise<void> {
  const pin = decodedOrThrow(
    decode(LibraryConnectorsPin, JSON.parse(await readFile(pinPath, "utf8"))),
    pinPath,
  );
  await attachCompilerPin(directory, "libraryConnectors", pin.index);
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

async function stampedJson(path: string, sectionVocabulary: string): Promise<unknown> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path} is not a JSON object`);
  return { ...raw, sectionVocabulary };
}

export async function stampSectionVocabulary(
  directory: string,
  indexFile: string,
  sectionVocabulary: string,
): Promise<void> {
  const indexPath = join(directory, indexFile);
  const index = decodedOrThrow(
    decode(ConnectorIndexFile, await stampedJson(indexPath, sectionVocabulary)),
    indexPath,
  );
  await writeFile(indexPath, JSON.stringify(index));
  for (const record of Object.values(index.parts)) {
    if (record === null) continue;
    const recordPath = join(dirname(indexPath), record.file);
    await writeFile(recordPath, JSON.stringify(await stampedJson(recordPath, sectionVocabulary)));
  }
}

export async function attachSectionVocabulary(
  directory: string,
  vocabularyPath: string,
): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(compiled)) throw new Error(`${manifestPath} is not a compiled bundle`);
  const { compiler } = compiled;
  if (compiler === null) return;
  if (!isRecord(compiler)) throw new Error(`${manifestPath} has no compiler section`);
  const bytes = await readFile(vocabularyPath);
  await writeFile(join(directory, SECTION_VOCABULARY_FILE), bytes);
  const sectionVocabulary: SectionVocabularyRef = {
    file: SECTION_VOCABULARY_FILE,
    sha256: sha256(bytes),
  };
  const connectors = compiled["connectors"];
  if (!isRecord(connectors) || typeof connectors["file"] !== "string") {
    throw new Error(`${manifestPath} names no connectors package`);
  }
  await stampSectionVocabulary(directory, connectors["file"], sectionVocabulary.sha256);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...compiled, compiler: { ...compiler, sectionVocabulary } }, null, 2)}\n`,
  );
}

export async function attachRollingDiagnostics(directory: string): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(compiled)) throw new Error(`${manifestPath} is not a compiled bundle`);
  const rollingDiagnostics: RollingDiagnosticsRef = {
    file: ROLLING_DIAGNOSTICS_FILE,
    sha256: sha256(await readFile(join(directory, ROLLING_DIAGNOSTICS_FILE))),
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...compiled, rollingDiagnostics }, null, 2)}\n`,
  );
}

function rollingDiagnosticsIssues(
  diagnostics: RollingDiagnosticsFile,
  served: ReadonlyMap<string, v.InferOutput<typeof GltfDocument>>,
): ReadonlyArray<string> {
  const issues: string[] = [];
  for (const [partId, document] of served) {
    const bands = document.extras.rolling?.unread ?? [];
    const rows = diagnostics.parts[partId];
    if (rows === undefined) {
      if (bands.length > 0)
        issues.push(`${partId} serves ${bands.length} unread bands but has no rows`);
    } else if (!rollingDiagnosticsFit(bands, rows)) {
      issues.push(
        `${partId}'s ${rows.length} rows don't match its ${bands.length} served unread bands index by index`,
      );
    }
  }
  for (const partId of Object.keys(diagnostics.parts)) {
    if (!served.has(partId)) issues.push(`${partId} has rows but the bundle has no such part`);
  }
  return issues;
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
  for (const { file } of manifest.studPrimitives) {
    decodeDeclared(GltfDocument, glbJson(await publish(file), file), file);
  }
  const servedParts = new Map<string, v.InferOutput<typeof GltfDocument>>();
  for (const { id, file } of partTable.parts) {
    servedParts.set(id, decodeDeclared(GltfDocument, glbJson(await publish(file), file), file));
  }
  const diagnosticsRef = manifest.rollingDiagnostics;
  if (diagnosticsRef === undefined) throw new Error(`${manifestPath} names no rolling diagnostics`);
  const diagnosticsBytes = await readFile(join(directory, diagnosticsRef.file));
  const diagnosticsIssues: string[] = [];
  if (sha256(diagnosticsBytes) !== diagnosticsRef.sha256) {
    diagnosticsIssues.push(
      `its SHA-256 is ${sha256(diagnosticsBytes)}, but the manifest references ${diagnosticsRef.sha256}`,
    );
  }
  diagnosticsIssues.push(
    ...rollingDiagnosticsIssues(
      decodeDeclared(
        RollingDiagnosticsFile,
        JSON.parse(diagnosticsBytes.toString("utf8")),
        diagnosticsRef.file,
      ),
      servedParts,
    ),
  );
  if (diagnosticsIssues.length > 0) {
    throw new Error(`${diagnosticsRef.file}: ${diagnosticsIssues.join("; ")}`);
  }
  await publish(diagnosticsRef.file);
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
  const publishSectionVocabulary = async (
    ref: SectionVocabularyRef,
    connectivity: v.InferOutput<typeof ConnectorIndexFile>,
  ): Promise<void> => {
    const bytes = await readFile(join(directory, ref.file));
    const digest = sha256(bytes);
    const vocabulary = decodedOrThrow(
      decode(SectionVocabularyFile, JSON.parse(bytes.toString("utf8"))),
      ref.file,
    );
    const issues = sectionVocabularyIssues(vocabulary, connectivity);
    if (digest !== ref.sha256) {
      issues.push(`its SHA-256 is ${digest}, but the manifest references ${ref.sha256}`);
    }
    if (issues.length > 0) throw new Error(`${ref.file}: ${issues.join("; ")}`);
    await publish(ref.file);
  };
  decodeDeclared(
    CrosswalkFile,
    JSON.parse((await publish(manifest.crosswalk.file)).toString("utf8")),
    manifest.crosswalk.file,
  );
  for (const { shape } of manifest.catalogParts) await publishJson(PartShape, shape.file);
  const packages: ReadonlyArray<readonly [ConnectorPackage, string]> = [
    ["connectors", manifest.connectors.file],
    ["connectivity", manifest.connectivity.file],
  ];
  const indexes = new Map<ConnectorPackage, v.InferOutput<typeof ConnectorIndexFile>>();
  for (const [expected, file] of packages) {
    const { value: index } = await readJson(ConnectorIndexFile, file);
    indexes.set(expected, index);
    const records = new Map<string, v.InferOutput<typeof ConnectorRecordFile>>();
    for (const [partId, record] of Object.entries(index.parts)) {
      if (record === null) continue;
      records.set(partId, (await readJson(ConnectorRecordFile, record.file)).value);
      await publish(record.file);
    }
    const issues = connectorPackageIssues(
      expected,
      index,
      records,
      manifest.compiler?.sectionVocabulary.sha256 ?? null,
    );
    if (issues.length > 0) throw new Error(`${file}: ${issues.join("; ")}`);
    await publishJson(ConnectorIndexFile, file);
  }
  const connectivity = indexes.get("connectivity");
  if (manifest.compiler !== null && connectivity !== undefined) {
    await publishSectionVocabulary(manifest.compiler.sectionVocabulary, connectivity);
  }
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
