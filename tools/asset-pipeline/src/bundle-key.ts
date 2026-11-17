import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_HASH_HEX_DIGITS } from "./publish.ts";

const PIPELINE_DIRECTORY = "tools/asset-pipeline";
const PIPELINE_BUILD_TASK = "@brr/asset-pipeline#build";
const TURBO_ROOT_PREFIX = "$TURBO_ROOT$/";
const NEGATION_PREFIX = "!";

interface TurboConfig {
  readonly tasks: Readonly<Record<string, { readonly inputs?: ReadonlyArray<string> }>>;
}

function bundleInputGlobs(repoRoot: string): ReadonlyArray<string> {
  const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as TurboConfig;
  const inputs = turbo.tasks[PIPELINE_BUILD_TASK]?.inputs;
  if (inputs === undefined || inputs.length === 0) {
    throw new Error(`turbo.json declares no inputs for ${PIPELINE_BUILD_TASK}`);
  }
  return inputs;
}

function gitPathspec(turboGlob: string): string {
  const excluded = turboGlob.startsWith(NEGATION_PREFIX);
  const glob = excluded ? turboGlob.slice(NEGATION_PREFIX.length) : turboGlob;
  const fromRoot = glob.startsWith(TURBO_ROOT_PREFIX)
    ? glob.slice(TURBO_ROOT_PREFIX.length)
    : `${PIPELINE_DIRECTORY}/${glob}`;
  return `:(top,glob${excluded ? ",exclude" : ""})${fromRoot}`;
}

function listBundleInputs(repoRoot: string, options: ReadonlyArray<string>): ReadonlyArray<string> {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", ...options, "--", ...bundleInputGlobs(repoRoot).map(gitPathspec)],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return listing
    .split("\0")
    .filter((path) => path !== "")
    .toSorted();
}

function bundleInputFiles(repoRoot: string): ReadonlyArray<string> {
  return listBundleInputs(repoRoot, []);
}

export function untrackedBundleInputs(repoRoot: string): ReadonlyArray<string> {
  return listBundleInputs(repoRoot, ["--others", "--exclude-standard"]);
}

export function bundleInputKey(repoRoot: string): string {
  const files = bundleInputFiles(repoRoot);
  if (files.length === 0) throw new Error("git lists no part bundle inputs");
  const key = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(join(repoRoot, file)))
      .digest("hex");
    key.update(`${file}\0${digest}\n`);
  }
  return key.digest("hex").slice(0, CONTENT_HASH_HEX_DIGITS);
}

export function remoteManifestFile(inputKey: string): string {
  return `manifest.${inputKey}.json`;
}
