import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectorRecords } from "@brr/catalog/connector-records";
import { LibraryConnectorsIndex, LibraryConnectorsPin } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";

const PIN_FILE = "tools/asset-pipeline/library-connectors.json";
const OUTPUT_DIRECTORY = "tools/asset-pipeline/dist/library-connectors";

export async function openLibraryConnectors(repoRoot: string): Promise<ConnectorRecords> {
  const pinPath = join(repoRoot, PIN_FILE);
  const pin = decodedOrThrow(
    decode(LibraryConnectorsPin, JSON.parse(await readFile(pinPath, "utf8"))),
    pinPath,
  );
  const root = join(repoRoot, OUTPUT_DIRECTORY);
  const indexPath = join(root, pin.index.file);
  const bytes = await readFile(indexPath).catch(() => {
    throw new Error(
      `${indexPath} is missing; run pnpm --filter @brr/asset-pipeline library-connectors first`,
    );
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pin.index.sha256) {
    throw new Error(`${indexPath} has SHA-256 ${sha256}, not the pinned ${pin.index.sha256}`);
  }
  const index = decodedOrThrow(
    decode(LibraryConnectorsIndex, JSON.parse(bytes.toString("utf8"))),
    indexPath,
  );
  return new ConnectorRecords(
    async (path) => JSON.parse(await readFile(join(root, path), "utf8")),
    { connectivity: index.connectivity.file, connectors: index.connectors.file },
    index.sectionVocabulary,
  );
}
