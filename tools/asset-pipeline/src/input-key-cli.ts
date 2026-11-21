import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInputKey } from "./bundle-key.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
process.stdout.write(`${bundleInputKey(repoRoot)}\n`);
