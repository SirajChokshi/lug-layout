import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
const [dst, ...srcs] = process.argv.slice(2);
const ims = srcs.map((s) => PNG.sync.read(readFileSync(s)));
const gap = 12;
const W = ims.reduce((s, im) => s + im.width, 0) + gap * (ims.length - 1);
const H = Math.max(...ims.map((im) => im.height));
const out = new PNG({ width: W, height: H });
out.data.fill(255);
let x0 = 0;
for (const im of ims) {
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const s = (y * im.width + x) * 4, d = (y * W + x0 + x) * 4;
    for (let k = 0; k < 4; k++) out.data[d + k] = im.data[s + k];
  }
  x0 += im.width + gap;
}
writeFileSync(dst, PNG.sync.write(out));
