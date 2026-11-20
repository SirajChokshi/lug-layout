import {
  ConnectorIndexFile,
  LIBRARY_CONNECTORS_INDEX_FILE,
  LibraryConnectorsIndex,
  type ConnectorPackage,
  type LibraryConnectorsPin,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as v from "valibot";
import type { ObjectReader } from "../library/ldraw-library.ts";
import { contentAddressedName } from "../publish.ts";
import { sha256Hex, type ObjectStore } from "../r2.ts";
import { isContentAddressed, type UploadResult } from "../remote-bundle.ts";

export const LIBRARY_CONNECTORS_PREFIX = "library-connectors";
const IMMUTABLE = "public, max-age=31536000, immutable";
const JSON_CONTENT_TYPE = "application/json";
const CONCURRENCY = 16;
const PACKAGES: ReadonlyArray<ConnectorPackage> = ["connectivity", "connectors"];

export type LibraryConnectorsScope = "indexes" | "all";

export function libraryConnectorsIndexKey(pin: LibraryConnectorsPin): string {
  return `${LIBRARY_CONNECTORS_PREFIX}/${contentAddressedName(pin.index.file, pin.index.sha256)}`;
}

function objectKey(file: string): string {
  return `${LIBRARY_CONNECTORS_PREFIX}/${file}`;
}

function decodeJson<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  bytes: Uint8Array,
  label: string,
): v.InferOutput<TSchema> {
  return decodedOrThrow(decode(schema, JSON.parse(new TextDecoder().decode(bytes))), label);
}

function packageFiles(index: ConnectorIndexFile): string[] {
  return Object.values(index.parts).flatMap((entry) => (entry === null ? [] : [entry.file]));
}

async function runAll<T>(items: ReadonlyArray<T>, work: (item: T) => Promise<void>): Promise<void> {
  const pending = [...items];
  const worker = async (): Promise<void> => {
    for (let item = pending.shift(); item !== undefined; item = pending.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

export async function libraryConnectorFiles(
  root: string,
  pin: LibraryConnectorsPin,
): Promise<{ readonly index: Uint8Array; readonly files: ReadonlyArray<string> }> {
  const index = await readFile(join(root, LIBRARY_CONNECTORS_INDEX_FILE));
  if (sha256Hex(index) !== pin.index.sha256) {
    throw new Error(
      `${join(root, LIBRARY_CONNECTORS_INDEX_FILE)} is not the pinned index ${pin.index.sha256}; run library-connectors --check`,
    );
  }
  const top = decodeJson(LibraryConnectorsIndex, index, LIBRARY_CONNECTORS_INDEX_FILE);
  const files: string[] = [];
  for (const pkg of PACKAGES) {
    const { file } = top[pkg];
    const bytes = await readFile(join(root, file));
    files.push(file, ...packageFiles(decodeJson(ConnectorIndexFile, bytes, file)));
  }
  return { index, files };
}

async function putIfAbsent(store: ObjectStore, key: string, body: Uint8Array): Promise<boolean> {
  if (await store.has(key)) return false;
  await store.put(key, body, { "Content-Type": JSON_CONTENT_TYPE, "Cache-Control": IMMUTABLE });
  return true;
}

export async function uploadLibraryConnectors(
  store: ObjectStore,
  root: string,
  pin: LibraryConnectorsPin,
): Promise<UploadResult> {
  const { index, files } = await libraryConnectorFiles(root, pin);
  let uploaded = 0;
  let present = 0;
  await runAll(files, async (file) => {
    const bytes = await readFile(join(root, file));
    if (!isContentAddressed(file, bytes))
      throw new Error(`${file} is not named by its content hash`);
    if (await putIfAbsent(store, objectKey(file), bytes)) uploaded += 1;
    else present += 1;
  });
  if (await putIfAbsent(store, libraryConnectorsIndexKey(pin), index)) uploaded += 1;
  else present += 1;
  return { uploaded, present };
}

export function areLibraryConnectorsPublished(
  store: ObjectStore,
  pin: LibraryConnectorsPin,
): Promise<boolean> {
  return store.has(libraryConnectorsIndexKey(pin));
}

async function servedIndex(
  read: ObjectReader,
  key: string,
  problems: string[],
): Promise<ConnectorIndexFile | null> {
  const bytes = await read(objectKey(key));
  if (bytes === undefined) {
    problems.push(`${objectKey(key)} is not served`);
    return null;
  }
  if (!isContentAddressed(key, bytes)) {
    problems.push(`${objectKey(key)} differs from its content address`);
    return null;
  }
  return decodeJson(ConnectorIndexFile, bytes, key);
}

export async function verifyServedLibraryConnectors(
  read: ObjectReader,
  pin: LibraryConnectorsPin,
  scope: LibraryConnectorsScope,
): Promise<string[]> {
  const key = libraryConnectorsIndexKey(pin);
  const bytes = await read(key);
  if (bytes === undefined) return [`${key} is not served`];
  if (sha256Hex(bytes) !== pin.index.sha256) return [`${key} differs from the pinned index`];
  const top = decodeJson(LibraryConnectorsIndex, bytes, key);
  const problems: string[] = [];
  const records: string[] = [];
  for (const pkg of PACKAGES) {
    const index = await servedIndex(read, top[pkg].file, problems);
    if (index === null) continue;
    const files = packageFiles(index);
    if (files.length !== pin.records[pkg]) {
      problems.push(`${top[pkg].file} lists ${files.length} records, the pin ${pin.records[pkg]}`);
    }
    records.push(...files);
  }
  if (scope === "all") {
    await runAll(records, async (file) => {
      const record = await read(objectKey(file));
      if (record === undefined) problems.push(`${objectKey(file)} is not served`);
      else if (!isContentAddressed(file, record))
        problems.push(`${objectKey(file)} differs from its content address`);
    });
  }
  return problems.toSorted();
}
