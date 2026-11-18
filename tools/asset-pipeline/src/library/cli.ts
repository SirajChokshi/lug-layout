import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSourceDirectory, restoreFiles, type InputLock } from "../fetch-ldraw.ts";
import { R2ObjectStore, sha256Hex } from "../r2.ts";
import {
  CONNECTOR_SOURCE_USE,
  extractShadowArchive,
  pinnedShadowArchive,
} from "../section-vocabulary.ts";
import {
  extractLibrary,
  httpReader,
  isLibraryPublished,
  libraryIndexKey,
  pinnedArchive,
  publicObjectUrl,
  uploadLibrary,
  verifyServedLibrary,
} from "./ldraw-library.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(toolRoot, "..", "..");
const lockPath = join(toolRoot, "ldraw.lock.json");
const catalogRoot = join(repoRoot, ".cache", "catalog");
const extractRoot = join(repoRoot, ".cache", "ldraw-library");
const shadowLibraryRoot = join(repoRoot, ".cache", "ldcad-shadow-library");
const storeConfigPath = join(repoRoot, "infra", "cloudflare", "ldraw-library.json");
const shadowPatchesRoot = join(toolRoot, "shadow-patches");
const sectionVocabularyPath = join(toolRoot, "section-vocabulary.json");
const inferredConnectorsPath = join(toolRoot, "inferred-connectors.json");
const HTTP_NOT_FOUND = 404;

interface StoreConfig {
  readonly bucket_name?: string;
  readonly public_base_url?: string | null;
}

async function readLock(): Promise<InputLock> {
  return JSON.parse(await readFile(lockPath, "utf8")) as InputLock;
}

async function readStoreConfig(): Promise<StoreConfig> {
  return JSON.parse(await readFile(storeConfigPath, "utf8")) as StoreConfig;
}

async function archivePath(lock: InputLock): Promise<string> {
  const archive = pinnedArchive(lock);
  const directory = catalogSourceDirectory(catalogRoot, archive.name);
  const { present, downloaded } = await restoreFiles(
    archive.location,
    { [archive.file]: archive.sha256 },
    directory,
  );
  process.stdout.write(`${archive.file}: ${present} present, ${downloaded} downloaded\n`);
  return join(directory, archive.file);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
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
      process.env["LDRAW_LIBRARY_R2_ENDPOINT"] ||
      `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket,
    credentials: { accessKeyId: tokenId, secretAccessKey },
  });
}

async function publicBaseUrl(): Promise<string | undefined> {
  const fromEnv = process.env["LDRAW_LIBRARY_BASE_URL"];
  if (fromEnv) return fromEnv;
  return (await readStoreConfig()).public_base_url ?? undefined;
}

async function writeStepOutput(name: string, value: string): Promise<void> {
  const output = process.env["GITHUB_OUTPUT"];
  if (output) await appendFile(output, `${name}=${value}\n`);
}

async function publishedCommand(): Promise<void> {
  const store = await bucketStore();
  if (store === undefined) {
    process.stdout.write("LDraw library store credentials are not set; nothing to publish to\n");
    await writeStepOutput("configured", "false");
    return;
  }
  const { mirror } = pinnedArchive(await readLock());
  const published = await isLibraryPublished(store, mirror);
  process.stdout.write(
    `${libraryIndexKey(mirror)}: ${published ? "published" : "not published"}\n`,
  );
  await writeStepOutput("configured", "true");
  await writeStepOutput("published", String(published));
}

async function uploadCommand(): Promise<void> {
  const store = await bucketStore();
  if (store === undefined) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID");
  const lock = await readLock();
  const { index, problems } = await extractLibrary(await archivePath(lock), lock, extractRoot);
  if (problems.length > 0) throw new Error(`refusing to publish:\n${problems.join("\n")}`);
  const { uploaded, present } = await uploadLibrary(store, index, extractRoot);
  process.stdout.write(
    `${libraryIndexKey(index.source)}: ${Object.keys(index.files).length} files, ${uploaded} uploaded, ${present} already present\n`,
  );
}

async function checkCommand(): Promise<void> {
  const lock = await readLock();
  const { index, problems } = await extractLibrary(await archivePath(lock), lock, extractRoot);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  process.stdout.write(
    `${Object.keys(index.files).length} files ready to publish in ${extractRoot}; the archive matches ldraw.lock.json\n`,
  );
}

async function restoreShadowLibrary(lock: InputLock): Promise<void> {
  if (lock.catalog === undefined) throw new Error("ldraw.lock.json has no catalog sources");
  const shadow = pinnedShadowArchive(lock.catalog);
  const entry = lock.catalog[shadow.name];
  if (entry?.use !== CONNECTOR_SOURCE_USE) throw new Error(`${shadow.name} is not pinned`);
  const directory = catalogSourceDirectory(catalogRoot, shadow.name);
  await restoreFiles(entry.source, entry.files, directory);
  await extractShadowArchive(join(directory, shadow.file), shadow.sha256, shadowLibraryRoot);
}

async function shadowPatchesCommand(check: boolean): Promise<void> {
  const lock = await readLock();
  const { problems } = await extractLibrary(await archivePath(lock), lock, extractRoot);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  await restoreShadowLibrary(lock);
  const run = spawnSync(
    "cargo",
    [
      "run",
      "--release",
      "--quiet",
      "-p",
      "brick-compile-cli",
      "--bin",
      "shadow-patches",
      "--",
      "--ldraw",
      extractRoot,
      "--patches",
      shadowPatchesRoot,
      "--lock",
      lockPath,
      "--shadow",
      shadowLibraryRoot,
      "--vocabulary",
      sectionVocabularyPath,
      "--inferred",
      inferredConnectorsPath,
      ...(check ? ["--check"] : []),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (run.status !== 0) throw new Error(`shadow-patches exited with ${String(run.status)}`);
}

type ServedState = "served" | "absent" | "unknown";

async function indexState(url: string): Promise<ServedState> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (response.ok) return "served";
    return response.status === HTTP_NOT_FOUND ? "absent" : "unknown";
  } catch {
    return "unknown";
  }
}

async function servedCommand(): Promise<void> {
  const baseUrl = await publicBaseUrl();
  const { mirror } = pinnedArchive(await readLock());
  if (baseUrl === undefined) {
    process.stdout.write(
      `the LDraw library has no public URL: set LDRAW_LIBRARY_BASE_URL or public_base_url in ${storeConfigPath}\n`,
    );
    await writeStepOutput("served", "false");
    await writeStepOutput("state", "absent");
    return;
  }
  const url = publicObjectUrl(baseUrl, libraryIndexKey(mirror));
  const state = await indexState(url);
  process.stdout.write(`${url}: ${state}\n`);
  await writeStepOutput("served", String(state === "served"));
  await writeStepOutput("state", state);
}

async function verifyServedCommand(scope: "pinned" | "all"): Promise<void> {
  const baseUrl = await publicBaseUrl();
  if (baseUrl === undefined) throw new Error("set LDRAW_LIBRARY_BASE_URL");
  const problems = await verifyServedLibrary(httpReader(baseUrl), await readLock(), scope);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${baseUrl}: ${scope === "all" ? "every published file" : "every lock-pinned file"} matches its SHA-256\n`,
  );
}

const command = process.argv[2];
switch (command) {
  case "check":
    await checkCommand();
    break;
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
    await verifyServedCommand(process.argv.includes("--all") ? "all" : "pinned");
    break;
  case "shadow-patches":
    await shadowPatchesCommand(process.argv.includes("--check"));
    break;
  default:
    process.stderr.write(
      "usage: library/cli.ts check|published|upload|served|verify-served [--all]|shadow-patches [--check]\n",
    );
    process.exitCode = 2;
}
