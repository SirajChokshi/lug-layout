import { readFile, writeFile } from "node:fs/promises";
import { deriveCrosswalk } from "./tools/asset-pipeline/src/catalog/crosswalk.ts";
import { crosswalkSources, readCrosswalkInputs } from "./tools/asset-pipeline/src/catalog/inputs.ts";

const [catalogDir, ldrawDir, out] = process.argv.slice(2);
const lock = JSON.parse(await readFile("./tools/asset-pipeline/ldraw.lock.json", "utf8"));
const crosswalk = deriveCrosswalk(
  await readCrosswalkInputs(lock.catalog, catalogDir, lock.source, ldrawDir),
  crosswalkSources(lock.catalog),
);
await writeFile(out, JSON.stringify(crosswalk));
console.log(out, Object.keys(crosswalk.parts).length);
