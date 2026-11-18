import { LibraryBakePin, PrimitiveConnectorTable } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BUNDLE_DATA_FILES } from "../bundle-data.ts";
import { catalogSourceDirectory, restoreFiles, type InputLock } from "../fetch-ldraw.ts";
import { extractLibrary, pinnedArchive } from "../library/ldraw-library.ts";
import { assembleLibraryBake, LIBRARY_BAKE_PIN } from "./assemble.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(toolRoot, "..", "..");
const catalogRoot = join(repoRoot, ".cache", "catalog");
const ldrawLibraryRoot = join(repoRoot, ".cache", "ldraw-library");
const buildRoot = join(repoRoot, ".cache", "library-bake-build");
const outRoot = join(toolRoot, "dist", "library-bake");
const palettePath = join(toolRoot, "palette.json");
const primitivesPath = join(repoRoot, BUNDLE_DATA_FILES.primitiveConnectors);
const binary = join(repoRoot, "target", "release", "library-bake");

interface PaletteOptions {
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
}

async function readLock(): Promise<InputLock> {
  return JSON.parse(await readFile(join(repoRoot, BUNDLE_DATA_FILES.lock), "utf8")) as InputLock;
}

function runCargo(args: ReadonlyArray<string>): void {
  const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`cargo ${args.join(" ")} exited with ${result.status}`);
}

function runShard(args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`library-bake ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function restoreLibrary(lock: InputLock): Promise<void> {
  const archive = pinnedArchive(lock);
  const directory = catalogSourceDirectory(catalogRoot, archive.name);
  await restoreFiles(archive.location, { [archive.file]: archive.sha256 }, directory);
  const extracted = await extractLibrary(join(directory, archive.file), lock, ldrawLibraryRoot);
  if (extracted.problems.length > 0) throw new Error(extracted.problems.join("; "));
}

async function precompute(check: boolean): Promise<void> {
  const lock = await readLock();
  await restoreLibrary(lock);
  runCargo(["build", "--release", "--quiet", "-p", "brick-compile-cli", "--bin", "library-bake"]);
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  const shards = availableParallelism();
  const started = performance.now();
  await Promise.all(
    Array.from({ length: shards }, (_, shard) =>
      runShard([
        "--ldraw",
        ldrawLibraryRoot,
        "--palette",
        palettePath,
        "--primitives",
        primitivesPath,
        "--out",
        buildRoot,
        "--shard",
        `${shard}/${shards}`,
      ]),
    ),
  );
  const palette = JSON.parse(await readFile(palettePath, "utf8")) as PaletteOptions;
  const pin = await assembleLibraryBake({
    build: buildRoot,
    out: outRoot,
    source: pinnedArchive(lock).mirror,
    options: {
      studPrimitives: palette.studPrimitives,
      unofficialAllowlist: palette.unofficialAllowlist,
      primitives: decodedOrThrow(
        decode(PrimitiveConnectorTable, JSON.parse(await readFile(primitivesPath, "utf8"))),
        primitivesPath,
      ),
    },
  });
  await rm(buildRoot, { recursive: true, force: true });
  const seconds = Math.round((performance.now() - started) / 1000);
  const summary = `${pin.parts} parts in ${seconds} s on ${shards} shards: ${pin.records} records, ${pin.failed} failed, ${pin.refused.length} refused, index ${pin.index.sha256}`;
  if (pin.refused.length > 0) {
    process.stderr.write(
      `the licence gate refused ${pin.refused.map(({ part }) => part).join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const pinPath = join(repoRoot, LIBRARY_BAKE_PIN);
  if (!check) {
    await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
    process.stdout.write(`wrote ${LIBRARY_BAKE_PIN}: ${summary}\n`);
    return;
  }
  const committed = decodedOrThrow(
    decode(LibraryBakePin, JSON.parse(await readFile(pinPath, "utf8"))),
    pinPath,
  );
  if (!isDeepStrictEqual(committed, pin)) {
    process.stderr.write(
      `${LIBRARY_BAKE_PIN} differs from the records the pinned inputs and this code produce (${summary}); run library-bake\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${LIBRARY_BAKE_PIN} matches: ${summary}\n`);
}

switch (process.argv[2]) {
  case undefined:
  case "--check":
    await precompute(process.argv.includes("--check"));
    break;
  default:
    process.stderr.write("usage: library-bake [--check]\n");
    process.exitCode = 1;
}
