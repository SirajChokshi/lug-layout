import {
  BundleIndex,
  BundleLod,
  BundleManifest,
  SectionVocabularyFile,
  TablePlane,
  TrackCatalog,
  type CatalogSourceUse,
  type CrosswalkFile,
  type Palette,
  type PaletteModel,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";
import { BUNDLE_DATA_DIRECTORIES, BUNDLE_DATA_FILES, FIXTURES_DIRECTORY } from "./bundle-data.ts";
import { bundleInputKey, remoteManifestFile } from "./bundle-key.ts";
import {
  bundleBuildKey,
  forgetBundleBuild,
  isBundleBuiltFrom,
  recordBundleBuild,
  type BundleBuildKey,
} from "./built-bundle.ts";
import { deriveCrosswalk, type LdrawPartFacts } from "./catalog/crosswalk.ts";
import { crosswalkSources, readCrosswalkInputs } from "./catalog/inputs.ts";
import { bomCheck } from "./catalog/bom-check.ts";
import {
  attachPartCategories,
  paletteCategoryProblems,
  PART_CATEGORY_SOURCE,
  readLdrawCategories,
  type LdrawCategories,
} from "./catalog/part-categories.ts";
import {
  catalogSourceDirectory,
  fetchAuditInputs,
  fetchCatalogSources,
  fetchClosure,
  modelPath,
  omrFiles,
  renderAttribution,
  renderModelAttribution,
  renderTestDataAttribution,
  restoreFiles,
  verifyAuditInputs,
  verifyCatalogSources,
  verifyClosure,
  verifyConnectivity,
  verifyModels,
  type CatalogLock,
  type ConnectivityLock,
  type InputLock,
  type ModelRoots,
} from "./fetch-ldraw.ts";
import { LdrawLibrary } from "./ldraw/library.ts";
import {
  producedColors,
  readProducedColorInputs,
  REBRICKABLE_EXPORT,
} from "./catalog/produced-colors.ts";
import { readFixtureModels, readPalette } from "./palette.ts";
import {
  attachCrosswalk,
  attachLibraryBake,
  attachLibraryConnectors,
  attachRollingDiagnostics,
  attachSectionVocabulary,
  MANIFEST_FILE,
  publishBundle,
} from "./publish.ts";
import { attachRecords } from "./records.ts";
import {
  extractShadowArchive,
  pinnedShadowArchive,
  sectionVocabularyFile,
} from "./section-vocabulary.ts";
import { R2ObjectStore, sha256Hex } from "./r2.ts";
import { attachThumbnails, type RenderedThumbnail } from "./thumbnails/catalog-thumbnails.ts";
import {
  isPartBundlePublished,
  unservedManifests,
  uploadPartBundle,
  waitUntilServed,
} from "./remote-bundle.ts";
import {
  geometryReports,
  licenseAuditReport,
  magnetSeatReports,
  readSources,
  trackCatalogReports,
  writeReports,
} from "./verify/facts.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(toolRoot, "..", "..");
const palettePath = join(repoRoot, BUNDLE_DATA_FILES.palette);
const fixtureModelsPath = join(repoRoot, BUNDLE_DATA_FILES.fixtureModels);
const lockPath = join(repoRoot, BUNDLE_DATA_FILES.lock);
const fixturesRoot = join(repoRoot, FIXTURES_DIRECTORY);
const ldrawRoot = join(repoRoot, ".cache", "ldraw");
const auditRoot = join(repoRoot, ".cache", "ldraw-audit");
const connectivityRoot = join(repoRoot, ".cache", "ldcad-shadow");
const bundleConnectivityRoot = join(repoRoot, ".cache", "ldcad-shadow-bundle");
const shadowLibraryRoot = join(repoRoot, ".cache", "ldcad-shadow-library");
const omrRoot = join(repoRoot, ".cache", "omr");
const catalogRoot = join(repoRoot, ".cache", "catalog");
const modelRoots: ModelRoots = { omr: omrRoot, generated: fixturesRoot };
const TEST_DATA_DIRECTORIES = [join("packages", "import", "test-data")];
const verifiedFactsRoot = join(repoRoot, "docs", "verified-facts");
const bundleRoot = join(toolRoot, "dist", "bundle");
const inferredConnectorsPath = join(toolRoot, "inferred-connectors.json");

const InferredConnectors = v.object({
  cavityProbe: v.string(),
  axleProbe: v.string(),
  vocabularySnaps: v.array(v.string()),
});

async function inferredConnectors(): Promise<v.InferOutput<typeof InferredConnectors>> {
  return v.parse(InferredConnectors, JSON.parse(await readFile(inferredConnectorsPath, "utf8")));
}
const fixtureBundleRoot = join(toolRoot, "fixture-bundle");
const FIXTURE_LOD: BundleLod = "standard";

async function readLock(): Promise<InputLock> {
  return JSON.parse(await readFile(lockPath, "utf8")) as InputLock;
}

async function paletteAndFixtureModels(palette: Palette): Promise<ReadonlyArray<PaletteModel>> {
  return [...palette.models, ...(await readFixtureModels(fixtureModelsPath)).models];
}

async function restoreModels(palette: Palette): Promise<void> {
  const { present, downloaded, pruned } = await restoreFiles(
    palette.omrSource,
    omrFiles(await paletteAndFixtureModels(palette)),
    omrRoot,
  );
  process.stdout.write(
    `OMR models: ${present} present, ${downloaded} downloaded, ${pruned} pruned\n`,
  );
}

async function fetchCommand(): Promise<void> {
  const palette = await readPalette(palettePath);
  await restoreModels(palette);
  const models = await paletteAndFixtureModels(palette);
  const modelProblems = await verifyModels(models, modelRoots);
  if (modelProblems.length > 0) throw new Error(modelProblems.join("\n"));
  const modelSources = await Promise.all(
    models.map((model) => readFile(modelPath(model, modelRoots), "utf8")),
  );
  const inferred = await inferredConnectors();
  const { closure, connectivity } = await fetchClosure(
    palette,
    ldrawRoot,
    bundleConnectivityRoot,
    modelSources,
    [inferred.cavityProbe, inferred.axleProbe],
  );
  const audit = await fetchAuditInputs(
    palette,
    auditRoot,
    connectivityRoot,
    inferred.vocabularySnaps,
  );
  const catalog = await fetchCatalogSources(palette.catalogSources, catalogRoot);
  const lock: InputLock = { ...closure, connectivity, audit, catalog };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await writeAttribution(lock, palette);
  process.stdout.write(`pinned ${Object.keys(lock.files).length} files\n`);
}

async function writeAttribution(lock: InputLock, palette: Palette): Promise<void> {
  const attribution = [
    await renderAttribution(lock, ldrawRoot),
    await renderModelAttribution(await paletteAndFixtureModels(palette), modelRoots),
    await renderTestDataAttribution(repoRoot, TEST_DATA_DIRECTORIES),
  ].join("\n");
  await writeFile(join(fixturesRoot, "ATTRIBUTION.md"), attribution);
}

async function attributionCommand(): Promise<void> {
  await writeAttribution(await readLock(), await readPalette(palettePath));
}

function connectivityLock(lock: InputLock): ConnectivityLock {
  if (lock.connectivity === undefined) {
    throw new Error("ldraw.lock.json pins no LDCad connectivity; run fetch-ldraw");
  }
  return lock.connectivity;
}

function catalogLock(lock: InputLock): CatalogLock {
  if (lock.catalog === undefined) {
    throw new Error("ldraw.lock.json has no catalog sources; run fetch-ldraw");
  }
  return lock.catalog;
}

async function restoreCatalog(lock: InputLock, use: CatalogSourceUse): Promise<void> {
  for (const [name, entry] of Object.entries(catalogLock(lock))) {
    if (entry.use !== use) continue;
    const { present, downloaded, pruned } = await restoreFiles(
      entry.source,
      entry.files,
      catalogSourceDirectory(catalogRoot, name),
    );
    process.stdout.write(
      `catalog ${name}: ${present} present, ${downloaded} downloaded, ${pruned} pruned\n`,
    );
  }
}

async function restoreCommand(): Promise<void> {
  const lock = await readLock();
  const targets = [
    { name: "bundle closure", source: lock.source, files: lock.files, directory: ldrawRoot },
    {
      name: "LDCad connectivity",
      source: connectivityLock(lock).source,
      files: connectivityLock(lock).files,
      directory: bundleConnectivityRoot,
    },
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
  await restoreCatalog(lock, "crosswalk");
  await restoreCatalog(lock, "categories");
  await restoreCatalog(lock, "connectors");
}

async function verifyCommand(): Promise<void> {
  const palette = await readPalette(palettePath);
  const lock = await readLock();
  const problems = [
    ...(await verifyClosure(lock, ldrawRoot)),
    ...(await verifyConnectivity(
      connectivityLock(lock),
      palette.connectivitySource,
      bundleConnectivityRoot,
      lock.files,
    )),
    ...(await verifyModels(await paletteAndFixtureModels(palette), modelRoots)),
    ...(await verifyCatalogSources(catalogLock(lock), catalogRoot, "crosswalk")),
    ...(await verifyCatalogSources(catalogLock(lock), catalogRoot, "categories")),
    ...(await verifyCatalogSources(catalogLock(lock), catalogRoot, "connectors")),
  ];
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("LDraw inputs match ldraw.lock.json\n");
}

async function sectionVocabularyCommand(check: boolean): Promise<void> {
  const lock = await readLock();
  await restoreCatalog(lock, "connectors");
  const archive = pinnedShadowArchive(catalogLock(lock));
  const files = await extractShadowArchive(
    join(catalogSourceDirectory(catalogRoot, archive.name), archive.file),
    archive.sha256,
    shadowLibraryRoot,
  );
  const derivedPath = join(shadowLibraryRoot, "..", "section-vocabulary.derived.json");
  runCargo([
    "run",
    "--release",
    "--quiet",
    "-p",
    "brick-compile-cli",
    "--bin",
    "section-vocabulary",
    "--",
    "--shadow",
    shadowLibraryRoot,
    "--out",
    derivedPath,
  ]);
  const derived = sectionVocabularyFile(archive, JSON.parse(await readFile(derivedPath, "utf8")));
  const committedPath = join(repoRoot, BUNDLE_DATA_FILES.sectionVocabulary);
  const summary = `${derived.sizes.length} sizes and ${derived.lengths.length} lengths from ${files} shadow files of ${archive.source.repo}@${archive.source.commit}`;
  if (!check) {
    await writeFile(committedPath, `${JSON.stringify(derived, null, 2)}\n`);
    process.stdout.write(`wrote ${BUNDLE_DATA_FILES.sectionVocabulary}: ${summary}\n`);
    return;
  }
  const committed = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(committedPath, "utf8"))),
    committedPath,
  );
  if (!isDeepStrictEqual(committed, derived)) {
    process.stderr.write(
      `${BUNDLE_DATA_FILES.sectionVocabulary} differs from the vocabulary derived from the pinned shadow archive (${summary}); run section-vocabulary\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${BUNDLE_DATA_FILES.sectionVocabulary} matches: ${summary}\n`);
}

async function factsCommand(check: boolean): Promise<void> {
  const lock = await readLock();
  const palette = await readPalette(palettePath);
  const { audit } = lock;
  if (audit === undefined) throw new Error("ldraw.lock.json has no audit inputs; run fetch-ldraw");
  const connectivity = connectivityLock(lock);
  const omrModels = palette.models.filter((model) => model.origin === "omr");
  const problems = [
    ...(await verifyClosure(lock, ldrawRoot)),
    ...(await verifyAuditInputs(audit, auditRoot, connectivityRoot)),
    ...(await verifyConnectivity(
      connectivity,
      palette.connectivitySource,
      bundleConnectivityRoot,
      lock.files,
    )),
    ...(await verifyModels(omrModels, modelRoots)),
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
    ...magnetSeatReports(
      lock,
      connectivity,
      new LdrawLibrary([ldrawRoot]),
      new LdrawLibrary([bundleConnectivityRoot]),
      await Promise.all(
        omrModels.map(async (model) => ({
          name: model.file,
          sha256: model.sha256,
          source: await readFile(modelPath(model, modelRoots), "utf8"),
        })),
      ),
    ),
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
  "brick_compile_wasm.wasm",
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

async function addVerifiedFacts(directory: string): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestPath, "utf8"));
  const catalogPath = join(repoRoot, BUNDLE_DATA_FILES.trackCatalog);
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
  const geometryPath = join(repoRoot, BUNDLE_DATA_FILES.geometry);
  const geometry: Record<string, unknown> = JSON.parse(await readFile(geometryPath, "utf8"));
  const tablePlane = decodedOrThrow(decode(TablePlane, geometry["tablePlane"]), geometryPath);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, trackCatalog: bundledCatalog, tablePlane }, null, 2)}\n`,
  );
}

const BYTES_PER_KB = 1024;
const MS_PER_SECOND = 1000;

function kb(bytes: number): string {
  return (bytes / BYTES_PER_KB).toFixed(1);
}

function reportThumbnails(
  lod: string,
  rendered: ReadonlyArray<RenderedThumbnail>,
  startedMs: number,
): void {
  if (rendered.length === 0) return;
  const bytes = rendered.reduce((sum, thumbnail) => sum + thumbnail.bytes, 0);
  const sizes = rendered.map((thumbnail) => thumbnail.bytes).toSorted((a, b) => a - b);
  const slowest = rendered.reduce((a, b) => (b.ms > a.ms ? b : a));
  process.stdout.write(
    `thumbnails ${lod}: ${rendered.length} items in ${((performance.now() - startedMs) / MS_PER_SECOND).toFixed(1)} s, ${kb(bytes)} KB total, ${kb(sizes[0] ?? 0)}–${kb(sizes.at(-1) ?? 0)} KB each (mean ${kb(bytes / rendered.length)} KB), slowest ${slowest.item} ${(slowest.ms / MS_PER_SECOND).toFixed(1)} s\n`,
  );
}

async function reportReusedBundle(buildKey: BundleBuildKey): Promise<void> {
  for (const lod of BundleLod.options) {
    const manifestPath = join(bundleRoot, lod, MANIFEST_FILE);
    const { bundleVersion } = decodedOrThrow(
      decode(
        v.pick(BundleIndex, ["bundleVersion"]),
        JSON.parse(await readFile(manifestPath, "utf8")),
      ),
      manifestPath,
    );
    process.stdout.write(
      `bundle ${lod} ${bundleVersion}: already built from input key ${buildKey.inputKey} in ${join(bundleRoot, lod)}\n`,
    );
  }
}

interface LodBuild {
  readonly palette: string;
  readonly out: string;
  readonly lod: BundleLod;
}

interface SharedBuild {
  readonly inputs: Omit<v.InferInput<typeof BundleIndex>["inputs"], "paletteSha256">;
  readonly crosswalk: CrosswalkFile;
  readonly coverCache: string;
  readonly ldrawParts: ReadonlyMap<string, LdrawPartFacts>;
  readonly categories: LdrawCategories;
}

async function compileLod({ palette, out, lod }: LodBuild, shared: SharedBuild): Promise<void> {
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
    join(repoRoot, BUNDLE_DATA_FILES.geometry),
    "--palette",
    palette,
    "--primitives",
    join(repoRoot, BUNDLE_DATA_FILES.primitiveConnectors),
    "--inferred",
    join(repoRoot, BUNDLE_DATA_FILES.inferredConnectors),
    "--vocabulary",
    join(repoRoot, BUNDLE_DATA_FILES.sectionVocabulary),
    "--shadow",
    bundleConnectivityRoot,
    "--patches",
    join(repoRoot, BUNDLE_DATA_DIRECTORIES.shadowPatches),
    "--out",
    out,
    "--lod",
    lod,
    "--compiler",
    compilerWasm,
    "--cover-cache",
    shared.coverCache,
  ]);
  await attachSectionVocabulary(out, join(repoRoot, BUNDLE_DATA_FILES.sectionVocabulary));
  await attachPartCategories(join(out, MANIFEST_FILE), shared.ldrawParts, shared.categories);
  await addVerifiedFacts(out);
  await attachCrosswalk(out, shared.crosswalk);
  await attachRecords(out);
  await attachLibraryBake(out, join(repoRoot, BUNDLE_DATA_FILES.libraryBakePin));
  await attachLibraryConnectors(out, join(repoRoot, BUNDLE_DATA_FILES.libraryConnectorsPin));
  await attachRollingDiagnostics(out);
  const started = performance.now();
  reportThumbnails(lod, await attachThumbnails(out, lod, () => performance.now()), started);
  const inputs = { ...shared.inputs, paletteSha256: await fileSha256(palette) };
  const { bundleVersion, files } = await publishBundle(out, inputs);
  process.stdout.write(
    `bundle ${lod} ${bundleVersion}: ${files} content-addressed files in ${out}\n`,
  );
}

async function writeFixturePalette(palette: Palette, path: string): Promise<void> {
  const fixtures = await readFixtureModels(fixtureModelsPath);
  await rm(fixtureBundleRoot, { recursive: true, force: true });
  await mkdir(fixtureBundleRoot, { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...palette, models: fixtures.models }, null, 2)}\n`);
}

async function bundleCommand(): Promise<void> {
  await restoreCommand();
  await verifyCommand();
  if (process.exitCode) return;
  const buildKey = await bundleBuildKey(repoRoot);
  const fixturePalette = join(fixtureBundleRoot, "palette.json");
  const builds: ReadonlyArray<LodBuild> = [
    ...BundleLod.options.map((lod) => ({ palette: palettePath, out: join(bundleRoot, lod), lod })),
    { palette: fixturePalette, out: join(fixtureBundleRoot, FIXTURE_LOD), lod: FIXTURE_LOD },
  ];
  const outputs = builds.map((build) => build.out);
  if (await isBundleBuiltFrom(repoRoot, bundleRoot, outputs, buildKey)) {
    await reportReusedBundle(buildKey);
    return;
  }
  await forgetBundleBuild(bundleRoot);
  const palette = await readPalette(palettePath);
  const lock = await readLock();
  const catalog = catalogLock(lock);
  const crosswalkInputs = await readCrosswalkInputs(catalog, catalogRoot, lock.source, ldrawRoot);
  const crosswalk = deriveCrosswalk(crosswalkInputs, crosswalkSources(catalog));
  const categories = await readLdrawCategories(
    catalogSourceDirectory(catalogRoot, PART_CATEGORY_SOURCE),
  );
  const misfiled = paletteCategoryProblems(palette, crosswalkInputs.ldrawParts, categories);
  if (misfiled.length > 0) {
    throw new Error(`palette parts are uncategorized or misfiled:\n${misfiled.join("\n")}`);
  }
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
  await writeFixturePalette(palette, fixturePalette);
  const inputs = {
    ldraw: palette.source,
    omr: palette.omrSource,
    lockSha256: await fileSha256(lockPath),
  };
  const ldrawParts = crosswalkInputs.ldrawParts;
  const shared = { inputs, crosswalk, coverCache, ldrawParts, categories };
  for (const build of builds) await compileLod(build, shared);
  await recordBundleBuild(bundleRoot, buildKey);
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
  case "bom-check": {
    const exportDirectory = process.argv[3];
    const outIndex = process.argv.indexOf("--out");
    const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
    if (exportDirectory === undefined || out === undefined) {
      process.stderr.write("usage: cli.ts bom-check <export-directory> --out <report.json>\n");
      process.exitCode = 2;
      break;
    }
    const lock = await readLock();
    await restoreCatalog(lock, "inventory-check");
    const problems = await verifyCatalogSources(catalogLock(lock), catalogRoot, "inventory-check");
    if (problems.length > 0) throw new Error(problems.join("\n"));
    process.stdout.write(
      await bomCheck({
        exportDirectory,
        out,
        inventoryDirectory: catalogSourceDirectory(catalogRoot, "rebrickable-inventories"),
        partsCsv: join(catalogSourceDirectory(catalogRoot, "rebrickable-dump"), "parts.csv.gz"),
      }),
    );
    break;
  }
  case "facts":
    await factsCommand(process.argv.includes("--check"));
    break;
  case "section-vocabulary":
    await sectionVocabularyCommand(process.argv.includes("--check"));
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
      "usage: cli.ts fetch|restore|attribution|verify|bundle|facts|colors [--check]|manifest-file|served|published|upload|await-served|bom-check <dir> --out <file>\n",
    );
    process.exitCode = 2;
}
