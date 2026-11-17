import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const [pathA, pathB, xs, ys, ws, hs, scaleArg, outPath] = process.argv.slice(2);
const [x0, y0, w, h, scale] = [xs, ys, ws, hs, scaleArg].map(Number);
const images = [pathA, pathB].map((p) => PNG.sync.read(readFileSync(p)));
const gap = 8;
const out = new PNG({ width: w * scale * 2 + gap, height: h * scale });
out.data.fill(255);
images.forEach((img, side) => {
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const sx = x0 + Math.floor(x / scale);
      const sy = y0 + Math.floor(y / scale);
      const s = (sy * img.width + sx) * 4;
      const t = (y * out.width + side * (w * scale + gap) + x) * 4;
      out.data[t] = img.data[s];
      out.data[t + 1] = img.data[s + 1];
      out.data[t + 2] = img.data[s + 2];
      out.data[t + 3] = 255;
    }
  }
});
writeFileSync(outPath, PNG.sync.write(out));
