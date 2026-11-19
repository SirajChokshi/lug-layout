import { LibraryConnectorsPin } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { BUNDLE_DATA_DIRECTORIES, BUNDLE_DATA_FILES } from "../bundle-data.ts";
import { catalogSourceDirectory, restoreFiles, type InputLock } from "../fetch-ldraw.ts";
import {
  extractLibrary,
  httpReader,
  pinnedArchive,
  publicObjectUrl,
} from "../library/ldraw-library.ts";
import { runPointerCommand } from "../publication/pinned-publication.ts";
import { R2ObjectStore, sha256Hex } from "../r2.ts";
import {
  CONNECTOR_SOURCE_USE,
  extractShadowArchive,
  pinnedShadowArchive,
} from "../section-vocabulary.ts";
import { assembleLibraryConnectors, LIBRARY_CONNECTORS_PIN } from "./assemble.ts";
import {
  areLibraryConnectorsPublished,
  libraryConnectorsIndexKey,
  libraryConnectorsPointer,
  uploadLibraryConnectors,
  verifyServedLibraryConnectors,
} from "./publish.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(toolRoot, "..", "..");
const catalogRoot = join(repoRoot, ".cache", "catalog");
const ldrawLibraryRoot = join(repoRoot, ".cache", "ldraw-library");
const shadowLibraryRoot = join(repoRoot, ".cache", "ldcad-shadow-library");
const buildRoot = join(repoRoot, ".cache", "library-connectors-build");
const outRoot = join(toolRoot, "dist", "library-connectors");
const binary = join(repoRoot, "target", "release", "library-connectors");
const storeConfigPath = join(repoRoot, "infra", "cloudflare", "part-bundles.json");

interface StoreConfig {
  readonly bucket_name?: string;
  readonly public_base_url?: string | null;
}

async function readLock(): Promise<InputLock> {
  return JSON.parse(await readFile(join(repoRoot, BUNDLE_DATA_FILES.lock), "utf8")) as InputLock;
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function runCargo(args: ReadonlyArray<string>): void {
  const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`cargo ${args.join(" ")} exited with ${result.status}`);
}

function runShard(args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`library-connectors ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function restoreInputs(lock: InputLock): Promise<ReturnType<typeof pinnedShadowArchive>> {
  const archive = pinnedArchive(lock);
  const archiveDirectory = catalogSourceDirectory(catalogRoot, archive.name);
  await restoreFiles(archive.location, { [archive.file]: archive.sha256 }, archiveDirectory);
  const extracted = await extractLibrary(
    join(archiveDirectory, archive.file),
    lock,
    ldrawLibraryRoot,
  );
  if (extracted.problems.length > 0) throw new Error(extracted.problems.join("; "));
  if (lock.catalog === undefined) throw new Error("ldraw.lock.json has no catalog sources");
  const shadow = pinnedShadowArchive(lock.catalog);
  const shadowDirectory = catalogSourceDirectory(catalogRoot, shadow.name);
  const entry = lock.catalog[shadow.name];
  if (entry?.use !== CONNECTOR_SOURCE_USE) throw new Error(`${shadow.name} is not pinned`);
  await restoreFiles(entry.source, entry.files, shadowDirectory);
  await extractShadowArchive(join(shadowDirectory, shadow.file), shadow.sha256, shadowLibraryRoot);
  return shadow;
}

async function precompute(check: boolean): Promise<void> {
  const lock = await readLock();
  const shadow = await restoreInputs(lock);
  runCargo([
    "build",
    "--release",
    "--quiet",
    "-p",
    "brick-compile-cli",
    "--bin",
    "library-connectors",
  ]);
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  const shards = availableParallelism();
  const started = performance.now();
  await Promise.all(
    Array.from({ length: shards }, (_, shard) =>
      runShard([
        "--ldraw",
        ldrawLibraryRoot,
        "--shadow",
        shadowLibraryRoot,
        "--patches",
        join(repoRoot, BUNDLE_DATA_DIRECTORIES.shadowPatches),
        "--primitives",
        join(repoRoot, BUNDLE_DATA_FILES.primitiveConnectors),
        "--inferred",
        join(repoRoot, BUNDLE_DATA_FILES.inferredConnectors),
        "--vocabulary",
        join(repoRoot, BUNDLE_DATA_FILES.sectionVocabulary),
        "--out",
        buildRoot,
        "--shard",
        `${shard}/${shards}`,
      ]),
    ),
  );
  const pin = await assembleLibraryConnectors({
    build: buildRoot,
    out: outRoot,
    ldraw: lock.source,
    shadow: shadow.source,
    sectionVocabulary: await fileSha256(join(repoRoot, BUNDLE_DATA_FILES.sectionVocabulary)),
  });
  const seconds = Math.round((performance.now() - started) / 1000);
  const summary = `${pin.parts} parts in ${seconds} s on ${shards} shards: ${pin.records.connectivity} connectivity and ${pin.records.connectors} connector records, index ${pin.index.sha256}`;
  const pinPath = join(repoRoot, LIBRARY_CONNECTORS_PIN);
  if (!check) {
    await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
    process.stdout.write(`wrote ${LIBRARY_CONNECTORS_PIN}: ${summary}\n`);
    return;
  }
  const committed = decodedOrThrow(
    decode(LibraryConnectorsPin, JSON.parse(await readFile(pinPath, "utf8"))),
    pinPath,
  );
  if (!isDeepStrictEqual(committed, pin)) {
    process.stderr.write(
      `${LIBRARY_CONNECTORS_PIN} differs from the records the pinned inputs and this code produce (${summary}); run library-connectors\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${LIBRARY_CONNECTORS_PIN} matches: ${summary}\n`);
}

async function readPin(): Promise<LibraryConnectorsPin> {
  const path = join(repoRoot, LIBRARY_CONNECTORS_PIN);
  return decodedOrThrow(
    decode(LibraryConnectorsPin, JSON.parse(await readFile(path, "utf8"))),
    path,
  );
}

async function readStoreConfig(): Promise<StoreConfig> {
  return JSON.parse(await readFile(storeConfigPath, "utf8")) as StoreConfig;
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

async function bucketStore(): Promise<R2ObjectStore | undefined> {
  const tokenId = process.env["CLOUDFLARE_API_TOKEN_ID"];
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!tokenId || !token) return undefined;
  const secretAccessKey = sha256Hex(token);
  if (process.env["GITHUB_ACTIONS"]) process.stdout.write(`::add-mask::${secretAccessKey}\n`);
  const { bucket_name: bucket } = await readStoreConfig();
  if (bucket === undefined) throw new Error(`${storeConfigPath} has no bucket_name`);
  return new R2ObjectStore({
    endpoint:
      process.env["PART_BUNDLE_R2_ENDPOINT"] ||
      `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket,
    credentials: { accessKeyId: tokenId, secretAccessKey },
  });
}

async function publicBaseUrl(): Promise<string | undefined> {
  const fromEnv = process.env["PART_BUNDLE_BASE_URL"];
  if (fromEnv) return fromEnv;
  return (await readStoreConfig()).public_base_url ?? undefined;
}

async function publishedCommand(): Promise<void> {
  const store = await bucketStore();
  if (store === undefined) {
    process.stdout.write("part bundle store credentials are not set; nothing to publish to\n");
    await writeStepOutput("configured", "false");
    return;
  }
  const pin = await readPin();
  const published = await areLibraryConnectorsPublished(store, pin);
  process.stdout.write(
    `${libraryConnectorsIndexKey(pin)}: ${published ? "published" : "not published"}\n`,
  );
  await writeStepOutput("configured", "true");
  await writeStepOutput("published", String(published));
}

async function uploadCommand(): Promise<void> {
  const store = await bucketStore();
  if (store === undefined) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID");
  const pin = await readPin();
  const started = performance.now();
  const { uploaded, present } = await uploadLibraryConnectors(store, outRoot, pin);
  const seconds = Math.round((performance.now() - started) / 1000);
  process.stdout.write(
    `${libraryConnectorsIndexKey(pin)}: ${uploaded} uploaded, ${present} already present, in ${seconds} s\n`,
  );
}

const WAIT_TIMEOUT_MS = 20 * 60_000;
const WAIT_INTERVAL_MS = 15_000;

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

async function servedCommand(): Promise<void> {
  const baseUrl = await publicBaseUrl();
  if (baseUrl === undefined) {
    process.stdout.write(`the part bundle bucket has no public URL in ${storeConfigPath}\n`);
    await writeStepOutput("served", "false");
    return;
  }
  const url = publicObjectUrl(baseUrl, libraryConnectorsIndexKey(await readPin()));
  const served = await isServed(url);
  process.stdout.write(`${url}: ${served ? "served" : "not served"}\n`);
  await writeStepOutput("served", String(served));
}

async function verifyServedCommand(all: boolean, wait: boolean): Promise<void> {
  const baseUrl = await publicBaseUrl();
  if (baseUrl === undefined) throw new Error("set PART_BUNDLE_BASE_URL");
  const pin = await readPin();
  if (wait) await waitUntilServed(publicObjectUrl(baseUrl, libraryConnectorsIndexKey(pin)));
  const problems = await verifyServedLibraryConnectors(
    httpReader(baseUrl),
    pin,
    all ? "all" : "indexes",
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  const checked = all
    ? `the index, both package indexes and all ${pin.records.connectivity + pin.records.connectors} records`
    : "the index and both package indexes";
  process.stdout.write(`${baseUrl}: ${checked} match their content addresses\n`);
}

switch (process.argv[2]) {
  case "published":
    await publishedCommand();
    break;
  case "upload":
    await uploadCommand();
    break;
  case "served":
    await servedCommand();
    break;
  case "verify-served":
    await verifyServedCommand(process.argv.includes("--all"), process.argv.includes("--wait"));
    break;
  case "point":
  case "current":
  case "verify-pointer":
  case "prune":
    await runPointerCommand(
      {
        storeConfigPath,
        readPin,
        pointer: libraryConnectorsPointer,
        manifestOf: (pin) => pin.index,
      },
      process.argv.slice(2),
    );
    break;
  case undefined:
  case "--check":
    await precompute(process.argv.includes("--check"));
    break;
  default:
    process.stderr.write(
      "usage: library-connectors [--check] | published | upload | served | verify-served [--all] [--wait] | point | current | verify-pointer [--all] [--wait] | prune [--dry-run]\n",
    );
    process.exitCode = 1;
}
