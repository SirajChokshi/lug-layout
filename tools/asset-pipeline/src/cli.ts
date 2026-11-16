import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAuditInputs,
  fetchClosure,
  renderAttribution,
  renderModelAttribution,
  restoreFiles,
  verifyAuditInputs,
  verifyClosure,
  verifyModels,
  type InputLock,
} from "./fetch-ldraw.ts";
import { LdrawLibrary } from "./ldraw/library.ts";
import { readPalette } from "./palette.ts";
import { geometryReports, licenseAuditReport, readSources, writeReports } from "./verify/facts.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(toolRoot, "..", "..");
const palettePath = join(toolRoot, "palette.json");
const lockPath = join(toolRoot, "ldraw.lock.json");
const fixturesRoot = join(repoRoot, "packages", "test-fixtures");
const ldrawRoot = join(repoRoot, ".cache", "ldraw");
const auditRoot = join(repoRoot, ".cache", "ldraw-audit");
const connectivityRoot = join(repoRoot, ".cache", "ldcad-shadow");
const verifiedFactsRoot = join(repoRoot, "docs", "verified-facts");

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
  const closure = await fetchClosure(palette, ldrawRoot, modelSources);
  const audit = await fetchAuditInputs(palette, auditRoot, connectivityRoot);
  const lock: InputLock = { ...closure, audit };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const attribution = [
    await renderAttribution(lock, ldrawRoot),
    await renderModelAttribution(palette, fixturesRoot),
  ].join("\n");
  await writeFile(join(fixturesRoot, "ATTRIBUTION.md"), attribution);
  process.stdout.write(`pinned ${Object.keys(lock.files).length} files\n`);
}

async function restoreCommand(): Promise<void> {
  const lock = await readLock();
  const targets = [
    { name: "bundle closure", source: lock.source, files: lock.files, directory: ldrawRoot },
    ...(lock.audit === undefined
      ? []
      : [
          {
            name: "audit closure",
            source: lock.source,
            files: lock.audit.files,
            directory: auditRoot,
          },
          {
            name: "LDCad patches",
            source: lock.audit.connectivity.source,
            files: lock.audit.connectivity.files,
            directory: connectivityRoot,
          },
        ]),
  ];
  for (const { name, source, files, directory } of targets) {
    const { present, downloaded } = await restoreFiles(source, files, directory);
    process.stdout.write(`${name}: ${present} present, ${downloaded} downloaded\n`);
  }
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

async function factsCommand(check: boolean): Promise<void> {
  const lock = await readLock();
  const palette = await readPalette(palettePath);
  const { audit } = lock;
  if (audit === undefined) throw new Error("ldraw.lock.json has no audit inputs; run fetch-ldraw");
  const problems = [
    ...(await verifyClosure(lock, ldrawRoot)),
    ...(await verifyAuditInputs(audit, auditRoot, connectivityRoot)),
  ];
  if (problems.length > 0) {
    process.stderr.write(
      `${problems.join("\n")}\nrun restore-ldraw to download the pinned inputs\n`,
    );
    process.exitCode = 1;
    return;
  }
  const auditLibrary = new LdrawLibrary([auditRoot]);
  const shadowLibrary = new LdrawLibrary([connectivityRoot]);
  const reports = [
    licenseAuditReport({
      lock,
      audit,
      palette,
      bundleSources: await readSources(ldrawRoot, lock.files),
      auditSources: await readSources(auditRoot, audit.files),
      shadowSources: await readSources(connectivityRoot, audit.connectivity.files),
      auditLibrary,
      shadowLibrary,
    }),
    ...geometryReports(lock.source, auditLibrary, shadowLibrary),
  ];
  if (await writeReports(reports, verifiedFactsRoot, check)) process.exitCode = 1;
}

const BUNDLE_LODS = ["standard", "low"] as const;

function runCargo(args: ReadonlyArray<string>): void {
  const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`cargo ${args.join(" ")} exited with ${result.status}`);
}

async function bundleCommand(): Promise<void> {
  await restoreCommand();
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
  case "restore":
    await restoreCommand();
    break;
  case "verify":
    await verifyCommand();
    break;
  case "bundle":
    await bundleCommand();
    break;
  case "facts":
    await factsCommand(process.argv.includes("--check"));
    break;
  default:
    process.stderr.write("usage: cli.ts fetch|restore|verify|bundle|facts [--check]\n");
    process.exitCode = 2;
}
