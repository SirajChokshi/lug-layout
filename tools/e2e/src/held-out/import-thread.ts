import { parentPort } from "node:worker_threads";
import { openBundle } from "./bundle.ts";
import { cachingFetch, importThroughWorkerPath, type HeldOutInput } from "./import-path.ts";

const [bundleRoot, ldrawCache, recordsRoot, libraryConnectorsRoot] = process.argv.slice(2);
if (
  !parentPort ||
  bundleRoot === undefined ||
  ldrawCache === undefined ||
  recordsRoot === undefined ||
  libraryConnectorsRoot === undefined
) {
  throw new Error(
    "the import thread runs as a worker given a bundle root, an LDraw cache, a records root and a library connectors root",
  );
}
const port = parentPort;
const bundle = await openBundle(bundleRoot, recordsRoot, libraryConnectorsRoot);
const fetchUrl = cachingFetch(ldrawCache);
port.on("message", async (input: HeldOutInput) => {
  port.postMessage(await importThroughWorkerPath(bundle, fetchUrl, input));
});
port.postMessage("ready");
