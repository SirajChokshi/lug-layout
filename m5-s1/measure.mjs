import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const file = process.argv[2];
const plates = Number(process.argv[3] ?? 10);
const png = PNG.sync.read(readFileSync(file));
const { width: W, height: H, data } = png;
const at = (x, y) => { const o = (y * W + x) * 4; return [data[o], data[o + 1], data[o + 2]]; };
const green = ([r, g, b]) => g > r + 40 && g > b + 40;
const issue = ([r, g, b]) => r > 150 && g < 90 && b > 40 && b < 160;
const plateish = (c) => green(c) || issue(c);
const brown = (c) => { const [r, g, b] = c; return r > g && g > b && r - b > 50 && !green(c); };
function longest(n, sample, pred, gap = 0) {
  let best = null, start = -1, last = -1;
  for (let i = 0; i <= n; i++) {
    const ok = i < n && pred(sample(i));
    if (ok) { if (start < 0) start = i; last = i; continue; }
    if (start >= 0 && (i - last > gap || i === n)) {
      if (!best || last - start > best[1] - best[0]) best = [start, last];
      start = -1;
    }
  }
  return best;
}
const len = (r) => r[1] - r[0] + 1;
let plate = null, table = null;
for (let y = 0; y < H; y++) {
  const g = longest(W, (x) => at(x, y), green, 3);
  const t = longest(W, (x) => at(x, y), brown);
  if (g && (!plate || len(g) > len(plate.run))) plate = { y, run: g };
  if (t && (!table || len(t) > len(table.run))) table = { y, run: t };
}
const cx = Math.round((table.run[0] + table.run[1]) / 2);
const depth = longest(H, (y) => at(cx, y), (c) => brown(c) || green(c));
const mmPerPx = 2400 / len(table.run);
console.log(JSON.stringify({
  image: file, size: [W, H],
  method: "longest run of table-brown pixels on any row = the 2400 mm table width; longest run of baseplate-green (bridging gaps of up to 3 px where the magenta issue outline crosses it) on any row = the baseplate row; brown-or-green run down the table's centre column = table depth",
  tableWidthPx: len(table.run), tableRow: table.y, tableX: table.run,
  baseplatesInRow: plates, baseplateRowPx: len(plate.run), plateRow: plate.y, plateX: plate.run,
  tableDepthPx: len(depth), depthColumn: cx, depthY: depth,
  mmPerPx: +mmPerPx.toFixed(4),
  tableDepthMm: +(len(depth) * mmPerPx).toFixed(1),
  baseplateRowMm: +(len(plate.run) * mmPerPx).toFixed(1),
  oneBaseplateMm: +(len(plate.run) * mmPerPx / plates).toFixed(2),
  overhangPastTableEdgeMm: +((plate.run[1] - table.run[1]) * mmPerPx).toFixed(1),
}, null, 1));
