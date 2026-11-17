import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
const [a, b, c, xs, ys, ws, hs, ss, out] = process.argv.slice(2);
const [x0, y0, w, h, s] = [xs, ys, ws, hs, ss].map(Number);
const imgs = [a, b, c].map((p) => PNG.sync.read(readFileSync(p)));
const gap = 6;
const png = new PNG({ width: (w * s + gap) * 3 - gap, height: h * s });
png.data.fill(255);
imgs.forEach((img, k) => {
  for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
    const src = ((y0 + Math.floor(y / s)) * img.width + x0 + Math.floor(x / s)) * 4;
    const dst = (y * png.width + k * (w * s + gap) + x) * 4;
    for (let ch = 0; ch < 3; ch++) png.data[dst + ch] = img.data[src + ch];
    png.data[dst + 3] = 255;
  }
});
writeFileSync(out, PNG.sync.write(png));
