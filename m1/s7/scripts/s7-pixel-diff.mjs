import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => PNG.sync.read(readFileSync(f)));
let px = 0, max = 0;
for (let i = 0; i < a.data.length; i += 4) {
  let d = 0;
  for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
  if (d > 0) px++;
  max = Math.max(max, d);
}
console.log(`${process.argv[2].split("/").pop()}: ${a.width}x${a.height}, differing pixels ${px}, max channel delta ${max}`);
