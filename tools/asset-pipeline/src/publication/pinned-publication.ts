import { decode, decodedOrThrow } from "@brr/schema/decode";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type * as v from "valibot";
import { httpReader, publicObjectUrl, type ObjectReader } from "../library/ldraw-library.ts";
import { contentAddressedName } from "../publish.ts";
import { R2ObjectStore, sha256Hex, type ObjectStore } from "../r2.ts";
import { isContentAddressed, type UploadResult } from "../remote-bundle.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";
const CONCURRENCY = 16;
const WAIT_TIMEOUT_MS = 20 * 60_000;
const WAIT_INTERVAL_MS = 15_000;

export interface PinnedIndex {
  readonly file: string;
  readonly sha256: string;
}

export interface ListedIndex {
  readonly file: string;
  readonly leaves?: number;
}

export interface IndexListing {
  readonly indexes: ReadonlyArray<ListedIndex>;
  readonly leaves: ReadonlyArray<string>;
}

export interface Publication<TPin> {
  readonly prefix: string;
  readonly indexFile: string;
  readonly leafNoun: string;
  readonly rebuildCommand: string;
  pinnedIndex(pin: TPin): PinnedIndex;
  list(file: string, bytes: Uint8Array, pin: TPin): IndexListing;
  contentType(file: string): string;
}

export type ServedScope = "indexes" | "all";

export function decodeJsonFile<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  bytes: Uint8Array,
  label: string,
): v.InferOutput<TSchema> {
  return decodedOrThrow(decode(schema, JSON.parse(new TextDecoder().decode(bytes))), label);
}

export function publicationIndexKey<TPin>(publication: Publication<TPin>, pin: TPin): string {
  const { file, sha256 } = publication.pinnedIndex(pin);
  return `${publication.prefix}/${contentAddressedName(file, sha256)}`;
}

function objectKey<TPin>(publication: Publication<TPin>, file: string): string {
  return `${publication.prefix}/${file}`;
}

async function runAll<T>(items: ReadonlyArray<T>, work: (item: T) => Promise<void>): Promise<void> {
  const pending = [...items];
  const worker = async (): Promise<void> => {
    for (let item = pending.shift(); item !== undefined; item = pending.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

export async function publicationFiles<TPin>(
  publication: Publication<TPin>,
  root: string,
  pin: TPin,
): Promise<{ readonly index: Uint8Array; readonly files: ReadonlyArray<string> }> {
  const indexPath = join(root, publication.indexFile);
  const index = await readFile(indexPath);
  const pinned = publication.pinnedIndex(pin).sha256;
  if (sha256Hex(index) !== pinned) {
    throw new Error(
      `${indexPath} is not the pinned index ${pinned}; run ${publication.rebuildCommand}`,
    );
  }
  const files: string[] = [];
  const descend = async (listing: IndexListing): Promise<void> => {
    files.push(...listing.leaves);
    for (const { file } of listing.indexes) {
      files.push(file);
      await descend(publication.list(file, await readFile(join(root, file)), pin));
    }
  };
  await descend(publication.list(publication.indexFile, index, pin));
  return { index, files };
}

async function putIfAbsent<TPin>(
  publication: Publication<TPin>,
  store: ObjectStore,
  key: string,
  file: string,
  body: Uint8Array,
): Promise<boolean> {
  if (await store.has(key)) return false;
  await store.put(key, body, {
    "Content-Type": publication.contentType(file),
    "Cache-Control": IMMUTABLE,
  });
  return true;
}

export async function uploadPublication<TPin>(
  publication: Publication<TPin>,
  store: ObjectStore,
  root: string,
  pin: TPin,
): Promise<UploadResult> {
  const { index, files } = await publicationFiles(publication, root, pin);
  let uploaded = 0;
  let present = 0;
  await runAll(files, async (file) => {
    const bytes = await readFile(join(root, file));
    if (!isContentAddressed(file, bytes))
      throw new Error(`${file} is not named by its content hash`);
    if (await putIfAbsent(publication, store, objectKey(publication, file), file, bytes))
      uploaded += 1;
    else present += 1;
  });
  const key = publicationIndexKey(publication, pin);
  if (await putIfAbsent(publication, store, key, publication.indexFile, index)) uploaded += 1;
  else present += 1;
  return { uploaded, present };
}

export function isPublicationPublished<TPin>(
  publication: Publication<TPin>,
  store: ObjectStore,
  pin: TPin,
): Promise<boolean> {
  return store.has(publicationIndexKey(publication, pin));
}

export async function verifyServedPublication<TPin>(
  publication: Publication<TPin>,
  read: ObjectReader,
  pin: TPin,
  scope: ServedScope,
): Promise<string[]> {
  const key = publicationIndexKey(publication, pin);
  const bytes = await read(key);
  if (bytes === undefined) return [`${key} is not served`];
  if (sha256Hex(bytes) !== publication.pinnedIndex(pin).sha256) {
    return [`${key} differs from the pinned index`];
  }
  const problems: string[] = [];
  const leaves: string[] = [];
  const descend = async (listing: IndexListing): Promise<void> => {
    leaves.push(...listing.leaves);
    for (const { file, leaves: expected } of listing.indexes) {
      const served = await read(objectKey(publication, file));
      if (served === undefined) {
        problems.push(`${objectKey(publication, file)} is not served`);
        continue;
      }
      if (!isContentAddressed(file, served)) {
        problems.push(`${objectKey(publication, file)} differs from its content address`);
        continue;
      }
      const inner = publication.list(file, served, pin);
      if (expected !== undefined && inner.leaves.length !== expected) {
        problems.push(
          `${file} lists ${inner.leaves.length} ${publication.leafNoun}, the pin ${expected}`,
        );
      }
      await descend(inner);
    }
  };
  await descend(publication.list(publication.indexFile, bytes, pin));
  if (scope === "all") {
    await runAll(leaves, async (file) => {
      const leaf = await read(objectKey(publication, file));
      if (leaf === undefined) problems.push(`${objectKey(publication, file)} is not served`);
      else if (!isContentAddressed(file, leaf))
        problems.push(`${objectKey(publication, file)} differs from its content address`);
    });
  }
  return problems.toSorted();
}

export type PinCheck = "written" | "matches" | "differs";

export async function writeOrCheckPin<const TSchema extends v.GenericSchema>(
  path: string,
  schema: TSchema,
  rebuilt: v.InferOutput<TSchema>,
  check: boolean,
): Promise<PinCheck> {
  if (!check) {
    await writeFile(path, `${JSON.stringify(rebuilt, null, 2)}\n`);
    return "written";
  }
  const committed = decodeJsonFile(schema, await readFile(path), path);
  return isDeepStrictEqual(committed, rebuilt) ? "matches" : "differs";
}

export interface PublicationCommands<TPin> {
  readonly publication: Publication<TPin>;
  readonly storeConfigPath: string;
  readonly root: string;
  readPin(): Promise<TPin>;
  describeVerified(pin: TPin, scope: ServedScope): string;
}

interface StoreConfig {
  readonly bucket_name?: string;
  readonly public_base_url?: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function writeStepOutput(name: string, value: string): Promise<void> {
  const output = process.env["GITHUB_OUTPUT"];
  if (output) await appendFile(output, `${name}=${value}\n`);
}

async function readStoreConfig(path: string): Promise<StoreConfig> {
  return JSON.parse(await readFile(path, "utf8")) as StoreConfig;
}

async function bucketStore(storeConfigPath: string): Promise<R2ObjectStore | undefined> {
  const tokenId = process.env["CLOUDFLARE_API_TOKEN_ID"];
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!tokenId || !token) return undefined;
  const secretAccessKey = sha256Hex(token);
  if (process.env["GITHUB_ACTIONS"]) process.stdout.write(`::add-mask::${secretAccessKey}\n`);
  const { bucket_name: bucket } = await readStoreConfig(storeConfigPath);
  if (bucket === undefined) throw new Error(`${storeConfigPath} has no bucket_name`);
  return new R2ObjectStore({
    endpoint:
      process.env["PART_BUNDLE_R2_ENDPOINT"] ||
      `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket,
    credentials: { accessKeyId: tokenId, secretAccessKey },
  });
}

async function publicBaseUrl(storeConfigPath: string): Promise<string | undefined> {
  const fromEnv = process.env["PART_BUNDLE_BASE_URL"];
  if (fromEnv) return fromEnv;
  return (await readStoreConfig(storeConfigPath)).public_base_url ?? undefined;
}

async function isServed(url: string): Promise<boolean> {
  return fetch(url, { method: "HEAD" }).then(
    (response) => response.ok,
    () => false,
  );
}

async function waitUntilServed(url: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await isServed(url))) {
    if (Date.now() >= deadline) throw new Error(`${url} is not served`);
    process.stdout.write(`waiting for ${url}\n`);
    await sleep(WAIT_INTERVAL_MS);
  }
}

async function publishedCommand<TPin>(commands: PublicationCommands<TPin>): Promise<void> {
  const store = await bucketStore(commands.storeConfigPath);
  if (store === undefined) {
    process.stdout.write("part bundle store credentials are not set; nothing to publish to\n");
    await writeStepOutput("configured", "false");
    return;
  }
  const pin = await commands.readPin();
  const published = await isPublicationPublished(commands.publication, store, pin);
  process.stdout.write(
    `${publicationIndexKey(commands.publication, pin)}: ${published ? "published" : "not published"}\n`,
  );
  await writeStepOutput("configured", "true");
  await writeStepOutput("published", String(published));
}

async function uploadCommand<TPin>(commands: PublicationCommands<TPin>): Promise<void> {
  const store = await bucketStore(commands.storeConfigPath);
  if (store === undefined) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID");
  const pin = await commands.readPin();
  const started = performance.now();
  const { uploaded, present } = await uploadPublication(
    commands.publication,
    store,
    commands.root,
    pin,
  );
  const seconds = Math.round((performance.now() - started) / 1000);
  process.stdout.write(
    `${publicationIndexKey(commands.publication, pin)}: ${uploaded} uploaded, ${present} already present, in ${seconds} s\n`,
  );
}

async function servedCommand<TPin>(commands: PublicationCommands<TPin>): Promise<void> {
  const baseUrl = await publicBaseUrl(commands.storeConfigPath);
  if (baseUrl === undefined) {
    process.stdout.write(
      `the part bundle bucket has no public URL in ${commands.storeConfigPath}\n`,
    );
    await writeStepOutput("served", "false");
    return;
  }
  const pin = await commands.readPin();
  const url = publicObjectUrl(baseUrl, publicationIndexKey(commands.publication, pin));
  const served = await isServed(url);
  process.stdout.write(`${url}: ${served ? "served" : "not served"}\n`);
  await writeStepOutput("served", String(served));
}

async function verifyServedCommand<TPin>(
  commands: PublicationCommands<TPin>,
  scope: ServedScope,
  wait: boolean,
): Promise<void> {
  const baseUrl = await publicBaseUrl(commands.storeConfigPath);
  if (baseUrl === undefined) throw new Error("set PART_BUNDLE_BASE_URL");
  const pin = await commands.readPin();
  const key = publicationIndexKey(commands.publication, pin);
  if (wait) await waitUntilServed(publicObjectUrl(baseUrl, key));
  const problems = await verifyServedPublication(
    commands.publication,
    httpReader(baseUrl),
    pin,
    scope,
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${baseUrl}: ${commands.describeVerified(pin, scope)} match their content addresses\n`,
  );
}

export async function runPublicationCommand<TPin>(
  commands: PublicationCommands<TPin>,
  argv: ReadonlyArray<string>,
): Promise<boolean> {
  switch (argv[0]) {
    case "published":
      await publishedCommand(commands);
      return true;
    case "upload":
      await uploadCommand(commands);
      return true;
    case "served":
      await servedCommand(commands);
      return true;
    case "verify-served":
      await verifyServedCommand(
        commands,
        argv.includes("--all") ? "all" : "indexes",
        argv.includes("--wait"),
      );
      return true;
    default:
      return false;
  }
}
