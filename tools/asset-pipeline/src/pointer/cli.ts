import { BundleLod } from "@brr/schema/bundle";
import {
  BUNDLE_POINTER_CACHE_CONTROL,
  BUNDLE_POINTER_FILE,
  BundlePointer,
  isContentAddressedPath,
} from "@brr/schema/bundle-pointer";
import { decode } from "@brr/schema/decode";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInputKey, remoteManifestFile } from "../bundle-key.ts";
import { R2ObjectStore, sha256Hex } from "../r2.ts";
import { waitUntilServed } from "../remote-bundle.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const storeConfigPath = join(repoRoot, "infra", "cloudflare", "part-bundles.json");
const SERVED_WAIT_MS = 5 * 60_000;
const SERVED_POLL_MS = 15_000;

interface StoreConfig {
  readonly bucket_name?: string;
  readonly public_base_url?: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function storeConfig(): Promise<StoreConfig> {
  return JSON.parse(await readFile(storeConfigPath, "utf8")) as StoreConfig;
}

async function publicBaseUrl(): Promise<string> {
  const base = process.env["PART_BUNDLE_BASE_URL"] || (await storeConfig()).public_base_url;
  if (!base) throw new Error(`set PART_BUNDLE_BASE_URL or public_base_url in ${storeConfigPath}`);
  return base.endsWith("/") ? base : `${base}/`;
}

async function writeStepOutput(name: string, value: string): Promise<void> {
  const output = process.env["GITHUB_OUTPUT"];
  if (output) await appendFile(output, `${name}=${value}\n`);
}

async function servedPointer(baseUrl: string): Promise<string | undefined> {
  const response = await fetch(new URL(BUNDLE_POINTER_FILE, baseUrl));
  if (!response.ok) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    return undefined;
  }
  const pointer = decode(BundlePointer, json, BUNDLE_POINTER_FILE);
  return pointer.ok ? pointer.value.manifestFile : undefined;
}

async function currentCommand(): Promise<void> {
  const manifestFile = remoteManifestFile(bundleInputKey(repoRoot));
  const served = await servedPointer(await publicBaseUrl());
  process.stdout.write(
    `${BUNDLE_POINTER_FILE} names ${served ?? "nothing"}; this commit needs ${manifestFile}\n`,
  );
  await writeStepOutput("current", String(served === manifestFile));
}

async function writeCommand(): Promise<void> {
  if (isContentAddressedPath(BUNDLE_POINTER_FILE)) {
    throw new Error(
      `${BUNDLE_POINTER_FILE} looks content-addressed, so caches would keep it forever`,
    );
  }
  const manifestFile = remoteManifestFile(bundleInputKey(repoRoot));
  const baseUrl = await publicBaseUrl();
  await waitUntilServed(baseUrl, BundleLod.options, manifestFile, {
    timeoutMs: SERVED_WAIT_MS,
    intervalMs: SERVED_POLL_MS,
    onWait: (missing) => process.stderr.write(`waiting for ${missing.join(", ")}\n`),
  });
  const tokenId = requiredEnv("CLOUDFLARE_API_TOKEN_ID");
  const secretAccessKey = sha256Hex(requiredEnv("CLOUDFLARE_API_TOKEN"));
  if (process.env["GITHUB_ACTIONS"]) process.stdout.write(`::add-mask::${secretAccessKey}\n`);
  const bucket = (await storeConfig()).bucket_name;
  if (!bucket) throw new Error(`${storeConfigPath} has no bucket_name`);
  const store = new R2ObjectStore({
    endpoint:
      process.env["PART_BUNDLE_R2_ENDPOINT"] ||
      `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket,
    credentials: { accessKeyId: tokenId, secretAccessKey },
  });
  const pointer: BundlePointer = { manifestFile };
  await store.put(BUNDLE_POINTER_FILE, new TextEncoder().encode(`${JSON.stringify(pointer)}\n`), {
    "Content-Type": "application/json",
    "Cache-Control": BUNDLE_POINTER_CACHE_CONTROL,
  });
  process.stdout.write(`${BUNDLE_POINTER_FILE} now names ${manifestFile}\n`);
}

const command = process.argv[2];
switch (command) {
  case "current":
    await currentCommand();
    break;
  case "write":
    await writeCommand();
    break;
  default:
    process.stderr.write("usage: pointer/cli.ts current|write\n");
    process.exitCode = 2;
}
