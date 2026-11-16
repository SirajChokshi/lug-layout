import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
const [pathA, pathB, cxs, cys, outPath] = process.argv.slice(2);
const cx = Number(cxs), cy = Number(cys);
const a = PNG.sync.read(readFileSync(pathA)), b = PNG.sync.read(readFileSync(pathB));
const R = Number(process.env.R ?? 30), S = Number(process.env.S ?? 6);
const W = (2 * R + 1) * S;
const out = new PNG({ width: W * 3 + 2 * S, height: W });
for (let side = 0; side < 3; side++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
  const sx = Math.min(Math.max(cx + dx, 0), a.width - 1), sy = Math.min(Math.max(cy + dy, 0), a.height - 1);
  const o = (sy * a.width + sx) * 4;
  let px;
  if (side < 2) px = (side === 0 ? a : b).data.subarray(o, o + 3);
  else { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[o + c] - b.data[o + c])); px = d ? [255, 0, 255] : [a.data[o] >> 2, a.data[o + 1] >> 2, a.data[o + 2] >> 2]; }
  for (let py = 0; py < S; py++) for (let qx = 0; qx < S; qx++) {
    const t = (((dy + R) * S + py) * out.width + side * (W + S) + (dx + R) * S + qx) * 4;
    out.data[t] = px[0]; out.data[t + 1] = px[1]; out.data[t + 2] = px[2]; out.data[t + 3] = 255;
  }
}
writeFileSync(outPath, PNG.sync.write(out));
