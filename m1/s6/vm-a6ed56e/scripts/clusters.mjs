import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

export function components(pathA, pathB) {
  const a = PNG.sync.read(readFileSync(pathA));
  const b = PNG.sync.read(readFileSync(pathB));
  const w = a.width;
  const h = a.height;
  const mask = new Uint8Array(w * h);
  const delta = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
    delta[i] = d;
    if (d) mask[i] = 1;
  }
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let max = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    while (stack.length) {
      const p = stack.pop();
      n++;
      max = Math.max(max, delta[p]);
      const x = p % w;
      const y = (p / w) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx;
          const qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
    }
    comps.push({ n, max, box: [minX, minY, maxX, maxY], width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  comps.sort((p, q) => q.n - p.n);
  return comps;
}

if (process.argv[1].endsWith("clusters.mjs")) {
  const [beforeDir, afterDir, outPath] = process.argv.slice(2);
  const rows = [];
  for (const name of readdirSync(afterDir).filter((f) => f.endsWith(".png")).sort()) {
    const comps = components(join(beforeDir, name), join(afterDir, name));
    const pixels = comps.reduce((s, c) => s + c.n, 0);
    const largest = comps[0] ?? null;
    const thin = comps.filter((c) => c.width <= 2 || c.height <= 2).reduce((s, c) => s + c.n, 0);
    rows.push({ frame: name, pixels, components: comps.length, thinPixels: thin, largest, top3: comps.slice(0, 3) });
    console.log(name.padEnd(16), String(pixels).padStart(5), String(comps.length).padStart(4), "thin", String(thin).padStart(5), "largest", JSON.stringify(largest));
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(rows, null, 2));
}
