import { decode, decodedOrThrow } from "@brr/schema/decode";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";
import { httpReader, publicObjectUrl, type ObjectReader } from "../library/ldraw-library.ts";
import { CONTENT_HASH_HEX_DIGITS, contentAddressedName } from "../publish.ts";
import {
  R2ObjectStore,
  sha256Hex,
  type ObjectStore,
  type PrunableStore,
  type StoredObject,
} from "../r2.ts";
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

async function publicationFiles<TPin>(
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
  const seen = new Set<string>([publication.indexFile]);
  const descend = async (listing: IndexListing): Promise<void> => {
    files.push(...listing.leaves);
    for (const { file } of listing.indexes) {
      if (seen.has(file)) throw new Error(`${file} is listed by more than one index`);
      seen.add(file);
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

function isPublicationPublished<TPin>(
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
  const seen = new Set<string>([publication.indexFile]);
  const descend = async (listing: IndexListing): Promise<void> => {
    leaves.push(...listing.leaves);
    for (const { file, leaves: expected } of listing.indexes) {
      if (seen.has(file)) {
        problems.push(`${file} is listed by more than one index`);
        continue;
      }
      seen.add(file);
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

export interface PublicationPointer<TManifest> {
  readonly current: TManifest;
  readonly previous: TManifest | null;
}

export interface ReferencedFile {
  readonly key: string;
  readonly sha256Prefix: string;
}

export interface ManifestReferences {
  readonly indexes: ReadonlyArray<string>;
  readonly files: ReadonlyArray<ReferencedFile>;
}

export interface PointerAdapter<TManifest> {
  readonly key: string;
  readonly prefixes: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string>>;
  decode(bytes: Uint8Array): PublicationPointer<TManifest>;
  encode(pointer: PublicationPointer<TManifest>): Uint8Array;
  sameManifest(a: TManifest, b: TManifest): boolean;
  describeManifest(manifest: TManifest): string;
  references(manifest: TManifest, read: ObjectReader): Promise<ManifestReferences>;
  retained(): Promise<ReadonlyArray<TManifest>>;
}

export function nextPointer<TManifest>(
  adapter: PointerAdapter<TManifest>,
  existing: PublicationPointer<TManifest> | null,
  manifest: TManifest,
): PublicationPointer<TManifest> {
  if (existing !== null && adapter.sameManifest(existing.current, manifest)) return existing;
  return { current: manifest, previous: existing?.current ?? null };
}

export async function readPointer<TManifest>(
  adapter: PointerAdapter<TManifest>,
  read: ObjectReader,
): Promise<PublicationPointer<TManifest> | null> {
  const bytes = await read(adapter.key);
  return bytes === undefined ? null : adapter.decode(bytes);
}

async function keptManifests<TManifest>(
  adapter: PointerAdapter<TManifest>,
  pointer: PublicationPointer<TManifest>,
): Promise<TManifest[]> {
  const kept: TManifest[] = [];
  const previous = pointer.previous === null ? [] : [pointer.previous];
  const candidates = [pointer.current, ...previous, ...(await adapter.retained())];
  for (const manifest of candidates) {
    if (!kept.some((known) => adapter.sameManifest(known, manifest))) kept.push(manifest);
  }
  return kept;
}

const HEX = /^[0-9a-f]+$/u;
const SHA256_HEX_DIGITS = 64;

function contentAddressOf(file: string): string {
  const extension = extname(file);
  const stem = file.slice(0, file.length - extension.length);
  const digest = stem.slice(stem.lastIndexOf(".") + 1);
  if (extension === "" || digest.length !== CONTENT_HASH_HEX_DIGITS || !HEX.test(digest)) {
    throw new Error(`${file} is not content-addressed`);
  }
  return digest;
}

function digestProblem(file: ReferencedFile, bytes: Uint8Array): string | undefined {
  const prefix = file.sha256Prefix;
  if (
    prefix.length < CONTENT_HASH_HEX_DIGITS ||
    prefix.length > SHA256_HEX_DIGITS ||
    !HEX.test(prefix)
  ) {
    return `${file.key} names no usable SHA-256 prefix`;
  }
  return sha256Hex(bytes).startsWith(prefix) ? undefined : `${file.key} differs from its SHA-256`;
}

export function pinnedIndexReferences<TPin>(
  publication: Publication<TPin>,
  list: (file: string, bytes: Uint8Array) => IndexListing,
): (manifest: PinnedIndex, read: ObjectReader) => Promise<ManifestReferences> {
  return async (manifest, read) => {
    const top = objectKey(publication, contentAddressedName(manifest.file, manifest.sha256));
    const bytes = await read(top);
    if (bytes === undefined) throw new Error(`${top} is not stored`);
    if (sha256Hex(bytes) !== manifest.sha256) {
      throw new Error(`${top} differs from its pinned SHA-256`);
    }
    const indexes = [top];
    const files: ReferencedFile[] = [];
    const seen = new Set<string>([manifest.file]);
    const descend = async (listing: IndexListing): Promise<void> => {
      files.push(
        ...listing.leaves.map((file) => ({
          key: objectKey(publication, file),
          sha256Prefix: contentAddressOf(file),
        })),
      );
      for (const { file } of listing.indexes) {
        if (seen.has(file)) throw new Error(`${file} is listed by more than one index`);
        seen.add(file);
        const key = objectKey(publication, file);
        const inner = await read(key);
        if (inner === undefined) throw new Error(`${key} is not stored`);
        if (!isContentAddressed(file, inner)) {
          throw new Error(`${key} differs from its content address`);
        }
        indexes.push(key);
        await descend(list(file, inner));
      }
    };
    await descend(list(manifest.file, bytes));
    return { indexes, files };
  };
}

export function pinnedIndexPointer<TPin>(
  publication: Publication<TPin>,
  list: (file: string, bytes: Uint8Array) => IndexListing,
  file: string,
): PointerAdapter<PinnedIndex> {
  const PinnedIndexEntry = v.strictObject({
    file: v.string(),
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  });
  const PointerFile = v.strictObject({
    current: PinnedIndexEntry,
    previous: v.nullable(PinnedIndexEntry),
  });
  const key = objectKey(publication, file);
  return {
    key,
    prefixes: [`${publication.prefix}/`],
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    decode: (bytes) => decodeJsonFile(PointerFile, bytes, key),
    encode: (pointer) => new TextEncoder().encode(JSON.stringify(pointer)),
    sameManifest: (a, b) => a.file === b.file && a.sha256 === b.sha256,
    describeManifest: (manifest) =>
      `${manifest.file} ${manifest.sha256.slice(0, CONTENT_HASH_HEX_DIGITS)}`,
    references: pinnedIndexReferences(publication, list),
    retained: async () => [],
  };
}

export interface PointerMove<TManifest> {
  readonly pointer: PublicationPointer<TManifest>;
  readonly moved: boolean;
}

export async function movePointer<TManifest>(
  adapter: PointerAdapter<TManifest>,
  store: PrunableStore,
  manifest: TManifest,
): Promise<PointerMove<TManifest>> {
  const read = (key: string) => store.get(key);
  await adapter.references(manifest, read);
  const existing = await readPointer(adapter, read);
  const pointer = nextPointer(adapter, existing, manifest);
  const moved = pointer !== existing;
  if (moved) await store.put(adapter.key, adapter.encode(pointer), adapter.headers);
  return { pointer, moved };
}

export async function verifyServedPointer<TManifest>(
  adapter: PointerAdapter<TManifest>,
  read: ObjectReader,
  scope: ServedScope,
): Promise<string[]> {
  const pointer = await readPointer(adapter, read).catch((error: unknown) => {
    throw new Error(`${adapter.key}: ${String(error)}`);
  });
  if (pointer === null) return [`${adapter.key} is not served`];
  const problems: string[] = [];
  for (const manifest of await keptManifests(adapter, pointer)) {
    const listed = await adapter
      .references(manifest, read)
      .catch((error: unknown): ManifestReferences => {
        problems.push(`${adapter.describeManifest(manifest)}: ${String(error)}`);
        return { indexes: [], files: [] };
      });
    if (scope !== "all") continue;
    await runAll(listed.files, async (file) => {
      const bytes = await read(file.key);
      const problem =
        bytes === undefined ? `${file.key} is not served` : digestProblem(file, bytes);
      if (problem !== undefined) problems.push(problem);
    });
  }
  return problems.toSorted();
}

export interface PruneOutcome {
  readonly live: number;
  readonly doomed: ReadonlyArray<StoredObject>;
  readonly deleted: number;
}

export async function pruneUnreferenced<TManifest>(
  adapter: PointerAdapter<TManifest>,
  store: PrunableStore,
  dryRun: boolean,
): Promise<PruneOutcome> {
  const read = (key: string) => store.get(key);
  const pointerBytes = await read(adapter.key);
  if (pointerBytes === undefined) {
    throw new Error(`${adapter.key} is not stored, so nothing says what is live`);
  }
  const pointer = adapter.decode(pointerBytes);
  const live = new Set<string>();
  for (const manifest of await keptManifests(adapter, pointer)) {
    const { indexes, files } = await adapter.references(manifest, read);
    for (const key of indexes) live.add(key);
    for (const file of files) live.add(file.key);
  }
  if (live.size === 0) throw new Error(`the manifests ${adapter.key} names reference nothing`);
  live.add(adapter.key);
  const stored = (await Promise.all(adapter.prefixes.map((prefix) => store.list(prefix)))).flat();
  const pointerAfterListing = await read(adapter.key);
  if (pointerAfterListing === undefined || !isDeepStrictEqual(pointerAfterListing, pointerBytes)) {
    throw new Error(`${adapter.key} changed during the prune, so nothing was deleted`);
  }
  const doomed = stored.filter((object) => !live.has(object.key));
  if (!dryRun) await store.delete(doomed.map((object) => object.key));
  return { live: live.size, doomed, deleted: dryRun ? 0 : doomed.length };
}

export interface PointerCommands<TPin, TManifest> extends PublicationCommands<TPin> {
  readonly pointer: PointerAdapter<TManifest>;
  manifestOf(pin: TPin): TManifest;
}

async function pointCommand<TPin, TManifest>(
  commands: PointerCommands<TPin, TManifest>,
): Promise<void> {
  const store = await bucketStore(commands.storeConfigPath);
  if (store === undefined) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID");
  const { pointer, moved } = await movePointer(
    commands.pointer,
    store,
    commands.manifestOf(await commands.readPin()),
  );
  const previous =
    pointer.previous === null ? "none" : commands.pointer.describeManifest(pointer.previous);
  process.stdout.write(
    `${commands.pointer.key}: current ${commands.pointer.describeManifest(pointer.current)}, previous ${previous}${moved ? "" : " (unchanged)"}\n`,
  );
}

async function currentCommand<TPin, TManifest>(
  commands: PointerCommands<TPin, TManifest>,
): Promise<void> {
  const baseUrl = await publicBaseUrl(commands.storeConfigPath);
  const pointer =
    baseUrl === undefined
      ? null
      : await readPointer(commands.pointer, httpReader(baseUrl)).catch(() => null);
  const manifest = commands.manifestOf(await commands.readPin());
  const current = pointer !== null && commands.pointer.sameManifest(pointer.current, manifest);
  process.stdout.write(
    `${commands.pointer.key}: ${current ? "names" : "does not name"} the pinned manifest as current\n`,
  );
  await writeStepOutput("current", String(current));
}

async function verifyPointerCommand<TPin, TManifest>(
  commands: PointerCommands<TPin, TManifest>,
  scope: ServedScope,
  wait: boolean,
): Promise<void> {
  const baseUrl = await publicBaseUrl(commands.storeConfigPath);
  if (baseUrl === undefined) throw new Error("set PART_BUNDLE_BASE_URL");
  if (wait) await waitUntilServed(publicObjectUrl(baseUrl, commands.pointer.key));
  const problems = await verifyServedPointer(commands.pointer, httpReader(baseUrl), scope);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${baseUrl}: the current and previous manifests ${commands.pointer.key} names, and ${scope === "all" ? "every file they reference" : "their index files"}, and every manifest the adapter retains, match their pins and SHA-256 digests\n`,
  );
}

async function pruneCommand<TPin, TManifest>(
  commands: PointerCommands<TPin, TManifest>,
  dryRun: boolean,
): Promise<void> {
  const store = await bucketStore(commands.storeConfigPath);
  if (store === undefined) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID");
  const { live, doomed, deleted } = await pruneUnreferenced(commands.pointer, store, dryRun);
  const bytes = doomed.reduce((sum, object) => sum + object.size, 0);
  if (dryRun) {
    for (const object of doomed)
      process.stdout.write(`would delete ${object.key} ${object.size}\n`);
  }
  process.stdout.write(
    `${commands.pointer.prefixes.join(", ")}: ${live} objects live; ${dryRun ? "would delete" : "deleted"} ${dryRun ? doomed.length : deleted} objects, ${bytes} bytes\n`,
  );
}

function pointerFlags(argv: ReadonlyArray<string>, allowed: ReadonlyArray<string>): Set<string> {
  const given = argv.slice(1);
  const unknown = given.filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0) {
    const accepted = allowed.length === 0 ? "no flags" : allowed.join(", ");
    throw new Error(`${argv[0]} takes ${accepted}; it does not take ${unknown.join(", ")}`);
  }
  return new Set(given);
}

export async function runPointerCommand<TPin, TManifest>(
  commands: PointerCommands<TPin, TManifest>,
  argv: ReadonlyArray<string>,
): Promise<boolean> {
  switch (argv[0]) {
    case "point":
      pointerFlags(argv, []);
      await pointCommand(commands);
      return true;
    case "current":
      pointerFlags(argv, []);
      await currentCommand(commands);
      return true;
    case "verify-pointer": {
      const flags = pointerFlags(argv, ["--all", "--wait"]);
      await verifyPointerCommand(
        commands,
        flags.has("--all") ? "all" : "indexes",
        flags.has("--wait"),
      );
      return true;
    }
    case "prune":
      await pruneCommand(commands, pointerFlags(argv, ["--dry-run"]).has("--dry-run"));
      return true;
    default:
      return false;
  }
}
