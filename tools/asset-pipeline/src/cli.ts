import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAuditInputs,
  fetchClosure,
  modelPath,
  omrFiles,
  renderAttribution,
  renderModelAttribution,
  renderTestDataAttribution,
  restoreFiles,
  verifyAuditInputs,
  verifyClosure,
  verifyModels,
  type InputLock,
  type ModelRoots,
} from "./fetch-ldraw.ts";
import { LdrawLibrary } from "./ldraw/library.ts";
import { readPalette, type Palette } from "./palette.ts";
import { MANIFEST_FILE, publishBundle, type BundleInputs } from "./publish.ts";
import {
  geometryReports,
  licenseAuditReport,
  readSources,
  TRACK_CATALOG_FILE,
  trackCatalogReports,
  writeReports,
} from "./verify/facts.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(toolRoot, "..", "..");
const palettePath = join(toolRoot, "palette.json");
const lockPath = join(toolRoot, "ldraw.lock.json");
const fixturesRoot = join(repoRoot, "packages", "test-fixtures");
const ldrawRoot = join(repoRoot, ".cache", "ldraw");
const auditRoot = join(repoRoot, ".cache", "ldraw-audit");
const connectivityRoot = join(repoRoot, ".cache", "ldcad-shadow");
const omrRoot = join(repoRoot, ".cache", "omr");
const modelRoots: ModelRoots = { omr: omrRoot, generated: fixturesRoot };
const TEST_DATA_DIRECTORIES = [join("packages", "import", "test-data")];
const verifiedFactsRoot = join(repoRoot, "docs", "verified-facts");

async function readLock(): Promise<InputLock> {
  return JSON.parse(await readFile(lockPath, "utf8")) as InputLock;
}

async function restoreModels(palette: Palette): Promise<void> {
  const { present, downloaded, pruned } = await restoreFiles(
    palette.omrSource,
    omrFiles(palette),
    omrRoot,
  );
  process.stdout.write(
    `OMR models: ${present} present, ${downloaded} downloaded, ${pruned} pruned\n`,
  );
}

async function fetchCommand(): Promise<void> {
  const palette = await readPalette(palettePath);
  await restoreModels(palette);
  const modelProblems = await verifyModels(palette, modelRoots);
  if (modelProblems.length > 0) throw new Error(modelProblems.join("\n"));
  const modelSources = await Promise.all(
    palette.models.map((model) => readFile(modelPath(model, modelRoots), "utf8")),
  );
  const closure = await fetchClosure(palette, ldrawRoot, modelSources);
  const audit = await fetchAuditInputs(palette, auditRoot, connectivityRoot);
  const lock: InputLock = { ...closure, audit };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await writeAttribution(lock, palette);
  process.stdout.write(`pinned ${Object.keys(lock.files).length} files\n`);
}

async function writeAttribution(lock: InputLock, palette: Palette): Promise<void> {
  const attribution = [
    await renderAttribution(lock, ldrawRoot),
    await renderModelAttribution(palette, modelRoots),
    await renderTestDataAttribution(repoRoot, TEST_DATA_DIRECTORIES),
  ].join("\n");
  await writeFile(join(fixturesRoot, "ATTRIBUTION.md"), attribution);
}

async function attributionCommand(): Promise<void> {
  await writeAttribution(await readLock(), await readPalette(palettePath));
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
    const { present, downloaded, pruned } = await restoreFiles(source, files, directory);
    process.stdout.write(
      `${name}: ${present} present, ${downloaded} downloaded, ${pruned} pruned\n`,
    );
  }
  await restoreModels(await readPalette(palettePath));
}

async function verifyCommand(): Promise<void> {
  const palette = await readPalette(palettePath);
  const problems = [
    ...(await verifyClosure(await readLock(), ldrawRoot)),
    ...(await verifyModels(palette, modelRoots)),
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
    ...geometryReports(lock.source, auditLibrary, shadowLibrary, palette.studPrimitives),
    ...trackCatalogReports(auditLibrary, palette),
  ];
  if (await writeReports(reports, verifiedFactsRoot, check)) process.exitCode = 1;
}

const BUNDLE_LODS = ["standard", "low", "far"] as const;
const COMPILER_TARGET = "wasm32-wasip1";
const compilerWasm = join(
  repoRoot,
  "target",
  COMPILER_TARGET,
  "release",
  "brick-compile-wasm.wasm",
);

function runCargo(args: ReadonlyArray<string>): void {
  const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`cargo ${args.join(" ")} exited with ${result.status}`);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function addTrackCatalog(directory: string): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    parts: ReadonlyArray<{ id: string }>;
  };
  const catalog = JSON.parse(
    await readFile(join(verifiedFactsRoot, TRACK_CATALOG_FILE), "utf8"),
  ) as { n: number; pieces: ReadonlyArray<{ id: string }> };
  const bundled = new Set(manifest.parts.map((part) => part.id));
  const missing = catalog.pieces.filter((piece) => !bundled.has(piece.id));
  if (missing.length > 0) {
    throw new Error(`track catalog pieces missing from the bundle: ${missing.map((p) => p.id)}`);
  }
  const trackCatalog = { n: catalog.n, pieces: catalog.pieces };
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, trackCatalog }, null, 2)}\n`);
}

async function bundleCommand(): Promise<void> {
  await restoreCommand();
  await verifyCommand();
  if (process.exitCode) return;
  const palette = await readPalette(palettePath);
  const inputs: BundleInputs = {
    ldraw: palette.source,
    omr: palette.omrSource,
    lockSha256: await fileSha256(lockPath),
    paletteSha256: await fileSha256(palettePath),
  };
  runCargo(["build", "--release", "--quiet", "-p", "brick-compile-cli"]);
  runCargo([
    "build",
    "--release",
    "--quiet",
    "--target",
    COMPILER_TARGET,
    "-p",
    "brick-compile-wasm",
  ]);
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
      "--omr",
      omrRoot,
      "--geometry",
      join(repoRoot, "docs", "verified-facts", "geometry.json"),
      "--palette",
      palettePath,
      "--out",
      out,
      "--lod",
      lod,
      "--compiler",
      compilerWasm,
    ]);
    await addTrackCatalog(out);
    const { bundleVersion, files } = await publishBundle(out, inputs);
    process.stdout.write(
      `bundle ${lod} ${bundleVersion}: ${files} content-addressed files in ${out}\n`,
    );
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
  case "attribution":
    await attributionCommand();
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
    process.stderr.write("usage: cli.ts fetch|restore|attribution|verify|bundle|facts [--check]\n");
    process.exitCode = 2;
}
