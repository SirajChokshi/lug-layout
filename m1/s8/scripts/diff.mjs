import { load, save } from "./img.mjs";
const [a, b, out] = process.argv.slice(2);
const A = load(a), B = load(b);
let n = 0, max = 0;
const D = load(a);
for (let i = 0; i < A.data.length; i += 4) {
  const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
  if (d > 0) n++;
  max = Math.max(max, d);
  const v = Math.min(255, d * 4);
  D.data[i] = v; D.data[i + 1] = v; D.data[i + 2] = v; D.data[i + 3] = 255;
}
if (out) save(D, out);
console.log(JSON.stringify({ differing: n, of: A.data.length / 4, maxDelta: max }));
