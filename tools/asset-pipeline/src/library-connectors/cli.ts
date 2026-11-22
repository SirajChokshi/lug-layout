import { LibraryConnectorsPin } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_DATA_DIRECTORIES, BUNDLE_DATA_FILES } from "../bundle-data.ts";
import { catalogSourceDirectory, restoreFiles, type InputLock } from "../fetch-ldraw.ts";
import { extractLibrary, httpReader, pinnedArchive } from "../library/ldraw-library.ts";
import { bundleBaseUrl, liveBundleLibraryConnectorsIndexes } from "../pointer/live-bundles.ts";
import {
  CONNECTOR_SOURCE_USE,
  extractShadowArchive,
  pinnedShadowArchive,
} from "../section-vocabulary.ts";
import {
  runPointerCommand,
  runPublicationCommand,
  writeOrCheckPin,
  type ServedScope,
} from "../publication/pinned-publication.ts";
import { assembleLibraryConnectors, LIBRARY_CONNECTORS_PIN } from "./assemble.ts";
import { libraryConnectorsPointer, libraryConnectorsPublication } from "./publish.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(toolRoot, "..", "..");
const catalogRoot = join(repoRoot, ".cache", "catalog");
const ldrawLibraryRoot = join(repoRoot, ".cache", "ldraw-library");
const shadowLibraryRoot = join(repoRoot, ".cache", "ldcad-shadow-library");
const buildRoot = join(repoRoot, ".cache", "library-connectors-build");
const outRoot = join(toolRoot, "dist", "library-connectors");
const binary = join(repoRoot, "target", "release", "library-connectors");
const storeConfigPath = join(repoRoot, "infra", "cloudflare", "part-bundles.json");
const bundleFallbackPath = join(repoRoot, "infra", "cloudflare", "bundle-fallback.json");

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
  const outcome = await writeOrCheckPin(
    join(repoRoot, LIBRARY_CONNECTORS_PIN),
    LibraryConnectorsPin,
    pin,
    check,
  );
  if (outcome === "written") {
    process.stdout.write(`wrote ${LIBRARY_CONNECTORS_PIN}: ${summary}\n`);
  } else if (outcome === "differs") {
    process.stderr.write(
      `${LIBRARY_CONNECTORS_PIN} differs from the records the pinned inputs and this code produce (${summary}); run library-connectors\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`${LIBRARY_CONNECTORS_PIN} matches: ${summary}\n`);
  }
}

async function readPin(): Promise<LibraryConnectorsPin> {
  const path = join(repoRoot, LIBRARY_CONNECTORS_PIN);
  return decodedOrThrow(
    decode(LibraryConnectorsPin, JSON.parse(await readFile(path, "utf8"))),
    path,
  );
}

const commands = {
  publication: libraryConnectorsPublication,
  storeConfigPath,
  root: outRoot,
  readPin,
  describeVerified: (pin: LibraryConnectorsPin, scope: ServedScope) =>
    scope === "all"
      ? `the index, both package indexes and all ${pin.records.connectivity + pin.records.connectors} records`
      : "the index and both package indexes",
};

const libraryConnectorsPointerRetainingLiveBundles = {
  ...libraryConnectorsPointer,
  retained: async () =>
    liveBundleLibraryConnectorsIndexes(
      httpReader(await bundleBaseUrl(storeConfigPath)),
      bundleFallbackPath,
    ),
};

switch (process.argv[2]) {
  case "published":
  case "upload":
  case "served":
  case "verify-served":
    await runPublicationCommand(commands, process.argv.slice(2));
    break;
  case "point":
  case "current":
  case "verify-pointer":
  case "prune":
    await runPointerCommand(
      {
        storeConfigPath,
        readPin,
        pointer: libraryConnectorsPointerRetainingLiveBundles,
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
