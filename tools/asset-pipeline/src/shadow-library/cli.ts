import { ShadowLibraryPin } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_DATA_DIRECTORIES, BUNDLE_DATA_FILES } from "../bundle-data.ts";
import { catalogSourceDirectory, restoreFiles, type InputLock } from "../fetch-ldraw.ts";
import {
  CONNECTOR_SOURCE_USE,
  extractShadowArchive,
  pinnedShadowArchive,
  type PinnedShadowArchive,
} from "../section-vocabulary.ts";
import {
  runPublicationCommand,
  writeOrCheckPin,
  type ServedScope,
} from "../publication/pinned-publication.ts";
import { assembleShadowLibrary, SHADOW_LIBRARY_PIN } from "./assemble.ts";
import { shadowLibraryPublication } from "./publish.ts";

const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(toolRoot, "..", "..");
const catalogRoot = join(repoRoot, ".cache", "catalog");
const shadowLibraryRoot = join(repoRoot, ".cache", "ldcad-shadow-library");
const outRoot = join(toolRoot, "dist", "shadow-library");
const storeConfigPath = join(repoRoot, "infra", "cloudflare", "part-bundles.json");

async function restoreShadowArchive(): Promise<PinnedShadowArchive> {
  const lock = JSON.parse(
    await readFile(join(repoRoot, BUNDLE_DATA_FILES.lock), "utf8"),
  ) as InputLock;
  if (lock.catalog === undefined) throw new Error("ldraw.lock.json has no catalog sources");
  const shadow = pinnedShadowArchive(lock.catalog);
  const entry = lock.catalog[shadow.name];
  if (entry?.use !== CONNECTOR_SOURCE_USE) throw new Error(`${shadow.name} is not pinned`);
  const shadowDirectory = catalogSourceDirectory(catalogRoot, shadow.name);
  await restoreFiles(entry.source, entry.files, shadowDirectory);
  await extractShadowArchive(join(shadowDirectory, shadow.file), shadow.sha256, shadowLibraryRoot);
  return shadow;
}

async function assemble(check: boolean): Promise<void> {
  const pin = await assembleShadowLibrary({
    shadowRoot: shadowLibraryRoot,
    patchesRoot: join(repoRoot, BUNDLE_DATA_DIRECTORIES.shadowPatches),
    out: outRoot,
    archive: await restoreShadowArchive(),
  });
  const summary = `${pin.files.shadow} shadow files and ${pin.files.patches} patch files, index ${pin.index.sha256}`;
  const outcome = await writeOrCheckPin(
    join(repoRoot, SHADOW_LIBRARY_PIN),
    ShadowLibraryPin,
    pin,
    check,
  );
  if (outcome === "written") {
    process.stdout.write(`wrote ${SHADOW_LIBRARY_PIN}: ${summary}\n`);
  } else if (outcome === "differs") {
    process.stderr.write(
      `${SHADOW_LIBRARY_PIN} differs from the files the pinned archive and shadow patches produce (${summary}); run shadow-library\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`${SHADOW_LIBRARY_PIN} matches: ${summary}\n`);
  }
}

async function readPin(): Promise<ShadowLibraryPin> {
  const path = join(repoRoot, SHADOW_LIBRARY_PIN);
  return decodedOrThrow(decode(ShadowLibraryPin, JSON.parse(await readFile(path, "utf8"))), path);
}

const commands = {
  publication: shadowLibraryPublication,
  storeConfigPath,
  root: outRoot,
  readPin,
  describeVerified: (pin: ShadowLibraryPin, scope: ServedScope) =>
    scope === "all"
      ? `the index, its ${pin.files.shadow} shadow files, ${pin.files.patches} patch files, patch manifest and licence`
      : "the pinned index's bytes",
};

switch (process.argv[2]) {
  case "published":
  case "upload":
  case "served":
  case "verify-served":
    await runPublicationCommand(commands, process.argv.slice(2));
    break;
  case undefined:
  case "--check":
    await assemble(process.argv.includes("--check"));
    break;
  default:
    process.stderr.write(
      "usage: shadow-library [--check] | published | upload | served | verify-served [--all] [--wait]\n",
    );
    process.exitCode = 1;
}
