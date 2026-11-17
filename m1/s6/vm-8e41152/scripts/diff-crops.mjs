import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const [pathA, pathB, outPrefix, countArg] = process.argv.slice(2);
const a = PNG.sync.read(readFileSync(pathA));
const b = PNG.sync.read(readFileSync(pathB));
const diffs = [];
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const o = (y * a.width + x) * 4;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[o + c] - b.data[o + c]));
    if (d) diffs.push([x, y, d]);
  }
}
const clusters = [];
for (const [x, y, d] of diffs) {
  const c = clusters.find((k) => Math.abs(k.x - x) < 12 && Math.abs(k.y - y) < 12);
  if (c) {
    c.n++;
    c.max = Math.max(c.max, d);
  } else clusters.push({ x, y, n: 1, max: d });
}
clusters.sort((p, q) => q.n - p.n);
console.log(clusters.length, "clusters", JSON.stringify(clusters.slice(0, 12)));
const R = Number(process.env.R ?? 14);
const S = Number(process.env.S ?? 12);
const count = Number(countArg ?? 4);
for (let k = 0; k < Math.min(count, clusters.length); k++) {
  const { x: cx, y: cy } = clusters[k];
  const out = new PNG({ width: (2 * R + 1) * S * 2 + S, height: (2 * R + 1) * S });
  for (let side = 0; side < 2; side++) {
    const img = side === 0 ? a : b;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const sx = Math.min(Math.max(cx + dx, 0), img.width - 1);
        const sy = Math.min(Math.max(cy + dy, 0), img.height - 1);
        const o = (sy * img.width + sx) * 4;
        for (let py = 0; py < S; py++) {
          for (let px = 0; px < S; px++) {
            const tx = side * ((2 * R + 1) * S + S) + (dx + R) * S + px;
            const ty = (dy + R) * S + py;
            const t = (ty * out.width + tx) * 4;
            out.data[t] = img.data[o];
            out.data[t + 1] = img.data[o + 1];
            out.data[t + 2] = img.data[o + 2];
            out.data[t + 3] = 255;
          }
        }
      }
    }
  }
  writeFileSync(`${outPrefix}-${k}.png`, PNG.sync.write(out));
}
