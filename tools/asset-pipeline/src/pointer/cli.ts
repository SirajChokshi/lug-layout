import { BundleLod } from "@brr/schema/bundle";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInputKey, remoteManifestFile } from "../bundle-key.ts";
import { httpReader } from "../library/ldraw-library.ts";
import {
  runPointerCommand,
  verifyServedManifest,
  type ServedScope,
} from "../publication/pinned-publication.ts";
import { waitUntilServed } from "../remote-bundle.ts";
import { bundleBaseUrl } from "./live-bundles.ts";
import { partBundlePointer } from "./part-bundle-pointer.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const storeConfigPath = join(repoRoot, "infra", "cloudflare", "part-bundles.json");
const fallbackPath = join(repoRoot, "infra", "cloudflare", "bundle-fallback.json");
const SERVED_WAIT_MS = 5 * 60_000;
const SERVED_POLL_MS = 15_000;
const VERIFY_SERVED_FLAGS = ["--all", "--wait"];

const pointer = partBundlePointer(fallbackPath);

function pinnedManifestFile(): string {
  return remoteManifestFile(bundleInputKey(repoRoot));
}

async function verifyServedCommand(flags: ReadonlyArray<string>): Promise<void> {
  const unknown = flags.filter((flag) => !VERIFY_SERVED_FLAGS.includes(flag));
  if (unknown.length > 0) {
    throw new Error(
      `verify-served takes ${VERIFY_SERVED_FLAGS.join(", ")}; it does not take ${unknown.join(", ")}`,
    );
  }
  const scope: ServedScope = flags.includes("--all") ? "all" : "indexes";
  const manifestFile = pinnedManifestFile();
  const baseUrl = await bundleBaseUrl(storeConfigPath);
  if (flags.includes("--wait")) {
    await waitUntilServed(baseUrl, BundleLod.options, manifestFile, {
      timeoutMs: SERVED_WAIT_MS,
      intervalMs: SERVED_POLL_MS,
      onWait: (missing) => process.stderr.write(`waiting for ${missing.join(", ")}\n`),
    });
  }
  const problems = await verifyServedManifest(pointer, httpReader(baseUrl), manifestFile, scope);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${baseUrl}: ${manifestFile} for ${BundleLod.options.join(", ")}, the JSON files it reaches${scope === "all" ? " and every file they name" : ""} match their content addresses\n`,
  );
}

const command = process.argv[2];
switch (command) {
  case "verify-served":
    await verifyServedCommand(process.argv.slice(3));
    break;
  case "point":
  case "current":
  case "verify-pointer":
  case "prune":
    await runPointerCommand(
      {
        storeConfigPath,
        pointer,
        readPin: async () => pinnedManifestFile(),
        manifestOf: (manifestFile: string) => manifestFile,
      },
      process.argv.slice(2),
    );
    break;
  default:
    process.stderr.write(
      "usage: pointer/cli.ts verify-served [--all] [--wait] | point | current | verify-pointer [--all] [--wait] | prune [--dry-run]\n",
    );
    process.exitCode = 2;
}
