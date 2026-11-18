import { parentPort } from "node:worker_threads";
import { openBundle } from "./bundle.ts";
import { cachingFetch, importThroughWorkerPath, type HeldOutInput } from "./import-path.ts";

const [bundleRoot, ldrawCache] = process.argv.slice(2);
if (!parentPort || bundleRoot === undefined || ldrawCache === undefined) {
  throw new Error("the import thread runs as a worker given a bundle root and an LDraw cache");
}
const port = parentPort;
const bundle = await openBundle(bundleRoot);
const fetchUrl = cachingFetch(ldrawCache);
port.on("message", async (input: HeldOutInput) => {
  port.postMessage(await importThroughWorkerPath(bundle, fetchUrl, input));
});
port.postMessage("ready");
