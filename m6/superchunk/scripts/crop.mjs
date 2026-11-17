import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
const [src, dst, x0, y0, w, h, s] = process.argv.slice(2);
const im = PNG.sync.read(readFileSync(src));
const X = +x0, Y = +y0, W = +w, H = +h, S = +s;
const out = new PNG({ width: W * S, height: H * S });
let green = 0;
for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
  const si = ((Y + Math.floor(y / S)) * im.width + X + Math.floor(x / S)) * 4;
  const di = (y * W * S + x) * 4;
  for (let k = 0; k < 4; k++) out.data[di + k] = im.data[si + k];
}
for (let y = Y; y < Y + H; y++) for (let x = X; x < X + W; x++) {
  const i = (y * im.width + x) * 4;
  const [r, g, b] = [im.data[i], im.data[i + 1], im.data[i + 2]];
  if (g > r + 30 && g > b + 30) green++;
}
writeFileSync(dst, PNG.sync.write(out));
console.log(JSON.stringify({ src, size: [im.width, im.height], greenPixelsInCrop: green }));
