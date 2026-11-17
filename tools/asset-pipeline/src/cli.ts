import { BundleLod, BundleManifest, TrackCatalog, type Palette } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { bundleInputKey, remoteManifestFile } from "./bundle-key.ts";
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
import {
  producedColors,
  readProducedColorInputs,
  REBRICKABLE_EXPORT,
} from "./catalog/produced-colors.ts";
import { readPalette } from "./palette.ts";
import { MANIFEST_FILE, publishBundle } from "./publish.ts";
import { R2ObjectStore, sha256Hex } from "./r2.ts";
import {
  isPartBundlePublished,
  unservedManifests,
  uploadPartBundle,
  waitUntilServed,
} from "./remote-bundle.ts";
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
const bundleRoot = join(toolRoot, "dist", "bundle");

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

const CATALOG_ROLES: ReadonlySet<string> = new Set(["ground", "road"]);

function producedColorSource(): string {
  const files = Object.values(REBRICKABLE_EXPORT)
    .map(({ file, sha256 }) => `${file} sha256 ${sha256}`)
    .join(", ");
  return `Rebrickable database export (${files}), docs/verified-facts.md S13; a colour counts only when its Rebrickable id and name equal an LDConfig code and name`;
}

async function colorsCommand(
  rebrickableDirectory: string | undefined,
  check: boolean,
): Promise<void> {
  if (rebrickableDirectory === undefined) {
    throw new Error("usage: cli.ts colors <directory with the S13 Rebrickable export> [--check]");
  }
  const palette = await readPalette(palettePath);
  const catalogParts = palette.parts.filter((part) => CATALOG_ROLES.has(part.role));
  const report = producedColors(
    await readProducedColorInputs(
      rebrickableDirectory,
      ldrawRoot,
      catalogParts.map((part) => part.id),
    ),
  );
  for (const excluded of report.excluded) {
    process.stdout.write(
      `excluded ${excluded.part} colour ${excluded.rebrickableColor}: ${excluded.reason}\n`,
    );
  }
  const unproduced = [...report.parts].filter(([, entry]) => entry.colors.length === 0);
  if (unproduced.length > 0) {
    throw new Error(
      `no produced colour for ${unproduced.map(([id, entry]) => `${id} (${entry.rebrickable})`).join(", ")}`,
    );
  }
  const updated: Palette = {
    ...palette,
    producedColorSource: producedColorSource(),
    parts: palette.parts.map((part) => {
      const entry = report.parts.get(part.id);
      return entry ? { ...part, producedColors: entry } : part;
    }),
  };
  const text = `${JSON.stringify(updated, null, 2)}\n`;
  if (check) {
    if (JSON.stringify(updated) !== JSON.stringify(palette)) {
      process.stderr.write("palette.json producedColors differ from the Rebrickable export\n");
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(palettePath, text);
  process.stdout.write(`produced colours for ${report.parts.size} catalog parts\n`);
}

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
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestPath, "utf8"));
  const catalogPath = join(verifiedFactsRoot, TRACK_CATALOG_FILE);
  const catalog: Record<string, unknown> = JSON.parse(await readFile(catalogPath, "utf8"));
  const bundled = new Set(
    decodedOrThrow(decode(v.pick(BundleManifest, ["parts"]), manifest), manifestPath).parts.map(
      (part) => part.id,
    ),
  );
  const missing = decodedOrThrow(decode(TrackCatalog, catalog), catalogPath)
    .pieces.filter((piece) => !bundled.has(piece.id))
    .map((piece) => piece.id);
  if (missing.length > 0) {
    throw new Error(`track catalog pieces missing from the bundle: ${missing}`);
  }
  const bundledCatalog = { n: catalog["n"], pieces: catalog["pieces"] };
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, trackCatalog: bundledCatalog }, null, 2)}\n`,
  );
}

async function bundleCommand(): Promise<void> {
  await restoreCommand();
  await verifyCommand();
  if (process.exitCode) return;
  const palette = await readPalette(palettePath);
  const inputs = {
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
  const coverCache = join(toolRoot, "dist", "cover-cache");
  await rm(coverCache, { recursive: true, force: true });
  for (const lod of BundleLod.options) {
    const out = join(bundleRoot, lod);
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
      "--cover-cache",
      coverCache,
    ]);
    await addTrackCatalog(out);
    const { bundleVersion, files } = await publishBundle(out, inputs);
    process.stdout.write(
      `bundle ${lod} ${bundleVersion}: ${files} content-addressed files in ${out}\n`,
    );
  }
}

const partBundleStorePath = join(repoRoot, "infra", "cloudflare", "part-bundles.json");
const DEFAULT_WAIT_MINUTES = 20;
const WAIT_INTERVAL_MS = 15_000;
const MS_PER_MINUTE = 60_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function partBundleBucket(): Promise<string> {
  const store = await readFile(partBundleStorePath, "utf8").catch(() => {
    throw new Error(
      `${partBundleStorePath} is missing: apply the infra/cloudflare Terraform that creates the bucket first`,
    );
  });
  const { bucket_name: bucket } = JSON.parse(store) as { readonly bucket_name?: string };
  if (bucket === undefined) throw new Error(`${partBundleStorePath} has no bucket_name`);
  return bucket;
}

async function partBundleStore(): Promise<R2ObjectStore | undefined> {
  const tokenId = process.env["CLOUDFLARE_API_TOKEN_ID"];
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!tokenId || !token) return undefined;
  const secretAccessKey = sha256Hex(token);
  if (process.env["GITHUB_ACTIONS"]) process.stdout.write(`::add-mask::${secretAccessKey}\n`);
  const endpoint =
    process.env["PART_BUNDLE_R2_ENDPOINT"] ||
    `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  return new R2ObjectStore({
    endpoint,
    bucket: await partBundleBucket(),
    credentials: { accessKeyId: tokenId, secretAccessKey },
  });
}

async function writeStepOutput(name: string, value: string): Promise<void> {
  const output = process.env["GITHUB_OUTPUT"];
  if (output) await appendFile(output, `${name}=${value}\n`);
}

function currentManifestFile(): string {
  return remoteManifestFile(bundleInputKey(repoRoot));
}

async function publishedCommand(): Promise<void> {
  const manifestFile = currentManifestFile();
  await writeStepOutput("manifest_file", manifestFile);
  const store = await partBundleStore();
  if (store === undefined) {
    process.stdout.write("part bundle store credentials are not set; nothing to publish to\n");
    await writeStepOutput("configured", "false");
    return;
  }
  const published = await isPartBundlePublished(store, BundleLod.options, manifestFile);
  process.stdout.write(`${manifestFile}: ${published ? "published" : "not published"}\n`);
  await writeStepOutput("configured", "true");
  await writeStepOutput("published", String(published));
}

async function uploadCommand(): Promise<void> {
  const store = await partBundleStore();
  if (store === undefined) {
    throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID");
  }
  const manifestFile = currentManifestFile();
  const { uploaded, present } = await uploadPartBundle(
    store,
    bundleRoot,
    BundleLod.options,
    manifestFile,
  );
  process.stdout.write(`${manifestFile}: ${uploaded} uploaded, ${present} already present\n`);
}

async function servedCommand(): Promise<void> {
  const manifestFile = currentManifestFile();
  const baseUrl = process.env["PART_BUNDLE_BASE_URL"];
  if (!baseUrl) {
    process.stdout.write(
      "PART_BUNDLE_BASE_URL is not set; the publish job checks the bucket itself\n",
    );
    await writeStepOutput("served", "false");
    return;
  }
  const missing = await unservedManifests(baseUrl, BundleLod.options, manifestFile);
  process.stdout.write(
    missing.length === 0
      ? `${manifestFile}: served from ${baseUrl}\n`
      : `${manifestFile}: not served: ${missing.join(", ")}\n`,
  );
  await writeStepOutput("served", String(missing.length === 0));
}

async function awaitServedCommand(): Promise<void> {
  const baseUrl = requiredEnv("VITE_BUNDLE_BASE_URL");
  const manifestFile = currentManifestFile();
  const minutes = Number(process.env["PART_BUNDLE_WAIT_MINUTES"] ?? DEFAULT_WAIT_MINUTES);
  await waitUntilServed(baseUrl, BundleLod.options, manifestFile, {
    timeoutMs: minutes * MS_PER_MINUTE,
    intervalMs: WAIT_INTERVAL_MS,
    onWait: (missing) =>
      process.stderr.write(
        `waiting for CI to publish ${missing.length} manifests ${manifestFile}\n`,
      ),
  });
  process.stdout.write(`${manifestFile}\n`);
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
  case "colors":
    await colorsCommand(
      process.argv.slice(3).find((arg) => !arg.startsWith("--")),
      process.argv.includes("--check"),
    );
    break;
  case "manifest-file":
    process.stdout.write(`${currentManifestFile()}\n`);
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
  case "await-served":
    await awaitServedCommand();
    break;
  default:
    process.stderr.write(
      "usage: cli.ts fetch|restore|attribution|verify|bundle|facts|colors [--check]|manifest-file|served|published|upload|await-served\n",
    );
    process.exitCode = 2;
}
