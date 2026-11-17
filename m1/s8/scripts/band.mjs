import { load, save, crop, hcat } from "./img.mjs";
const [png, out] = process.argv.slice(2);
const im = load(png);
const bg = [217, 230, 242];
const bands = [[0, 160], [320, 480], [640, im.height]];
const res = bands.map(([y0, y1]) => {
  const v = [];
  for (let y = y0; y < y1; y++) for (let x = 0; x < im.width; x++) {
    const o = (y * im.width + x) * 4, r = im.data[o], g = im.data[o + 1], b = im.data[o + 2];
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) v.push((r + g + b) / 3);
  }
  v.sort((a, b) => a - b);
  return { rows: `${y0}-${y1}`, trackPixels: v.length, p25: v[Math.floor(v.length * 0.25)]?.toFixed(0), median: v[Math.floor(v.length / 2)]?.toFixed(0), p90: v[Math.floor(v.length * 0.9)]?.toFixed(0) };
});
console.log(JSON.stringify(res));
if (out) save(hcat([crop(im, 540, 0, 200, 140, 3), crop(im, 540, im.height - 141, 200, 140, 3)]), out);
