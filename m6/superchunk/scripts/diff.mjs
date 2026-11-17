import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((p) => PNG.sync.read(readFileSync(p)));
let sum = 0, n = 0, big = 0;
for (let i = 0; i < a.data.length; i += 4) {
  const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
  sum += d; n++; if (d > 40) big++;
}
console.log(JSON.stringify({ meanAbsDiff: +(sum / n).toFixed(2), pixelsOver40: big, pixels: n }));
