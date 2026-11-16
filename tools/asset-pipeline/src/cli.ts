import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchClosure,
  renderAttribution,
  renderModelAttribution,
  verifyClosure,
  verifyModels,
  type InputLock,
} from "./fetch-ldraw.ts";
import { readPalette } from "./palette.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(toolRoot, "..", "..");
const palettePath = join(toolRoot, "palette.json");
const lockPath = join(toolRoot, "ldraw.lock.json");
const fixturesRoot = join(repoRoot, "packages", "test-fixtures");
const ldrawRoot = join(fixturesRoot, "ldraw");

async function readLock(): Promise<InputLock> {
  return JSON.parse(await readFile(lockPath, "utf8")) as InputLock;
}

async function fetchCommand(): Promise<void> {
  const palette = await readPalette(palettePath);
  const modelProblems = await verifyModels(palette, fixturesRoot);
  if (modelProblems.length > 0) throw new Error(modelProblems.join("\n"));
  const modelSources = await Promise.all(
    palette.models.map((model) => readFile(join(fixturesRoot, model.file), "utf8")),
  );
  const lock = await fetchClosure(palette, ldrawRoot, modelSources);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const attribution = [
    await renderAttribution(lock, ldrawRoot),
    await renderModelAttribution(palette, fixturesRoot),
  ].join("\n");
  await writeFile(join(fixturesRoot, "ATTRIBUTION.md"), attribution);
  process.stdout.write(`pinned ${Object.keys(lock.files).length} files\n`);
}

async function verifyCommand(): Promise<void> {
  const palette = await readPalette(palettePath);
  const problems = [
    ...(await verifyClosure(await readLock(), ldrawRoot)),
    ...(await verifyModels(palette, fixturesRoot)),
  ];
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("LDraw inputs match ldraw.lock.json\n");
}

const BUNDLE_LODS = ["standard", "low"] as const;

function runCargo(args: ReadonlyArray<string>): void {
  const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`cargo ${args.join(" ")} exited with ${result.status}`);
}

async function bundleCommand(): Promise<void> {
  await verifyCommand();
  if (process.exitCode) return;
  runCargo(["build", "--release", "--quiet", "-p", "brick-compile-cli"]);
  for (const lod of BUNDLE_LODS) {
    const out = join(toolRoot, "dist", "bundle", lod);
    await rm(out, { recursive: true, force: true });
    runCargo([
      "run",
      "--release",
      "--quiet",
      "-p",
      "brick-compile-cli",
      "--",
      "--ldraw",
      ldrawRoot,
      "--fixtures",
      fixturesRoot,
      "--palette",
      palettePath,
      "--out",
      out,
      "--lod",
      lod,
    ]);
    process.stdout.write(`bundle ${lod} written to ${out}\n`);
  }
}

const command = process.argv[2];
switch (command) {
  case "fetch":
    await fetchCommand();
    break;
  case "verify":
    await verifyCommand();
    break;
  case "bundle":
    await bundleCommand();
    break;
  default:
    process.stderr.write("usage: cli.ts fetch|verify|bundle\n");
    process.exitCode = 2;
}
