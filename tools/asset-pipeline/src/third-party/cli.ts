import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_DATA_FILES } from "../bundle-data.ts";
import {
  pinThirdPartyFiles,
  readThirdPartyTrack,
  restoreAllThirdParty,
  THIRD_PARTY_CACHE_DIRECTORY,
  verifyAllThirdParty,
} from "./third-party-sources.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const trackPath = join(repoRoot, BUNDLE_DATA_FILES.thirdPartyTrack);
const cacheRoot = join(repoRoot, THIRD_PARTY_CACHE_DIRECTORY);

async function fetchCommand(): Promise<void> {
  const file = await readThirdPartyTrack(trackPath);
  const sources = [];
  for (const source of file.sources) {
    const files = await pinThirdPartyFiles(source);
    sources.push({ ...source, files });
    process.stdout.write(`${source.id}: pinned ${Object.keys(files).length} files\n`);
  }
  await writeFile(trackPath, `${JSON.stringify({ sources }, null, 2)}\n`);
  await restoreAllThirdParty(await readThirdPartyTrack(trackPath), cacheRoot);
}

switch (process.argv[2]) {
  case "fetch":
    await fetchCommand();
    break;
  case "restore":
    await restoreAllThirdParty(await readThirdPartyTrack(trackPath), cacheRoot);
    break;
  case "verify": {
    const problems = await verifyAllThirdParty(await readThirdPartyTrack(trackPath), cacheRoot);
    process.stdout.write(
      problems.length === 0 ? "third-party track matches its pins\n" : `${problems.join("\n")}\n`,
    );
    if (problems.length > 0) process.exitCode = 1;
    break;
  }
  default:
    process.stderr.write("usage: third-party/cli.ts fetch|restore|verify\n");
    process.exitCode = 2;
}
