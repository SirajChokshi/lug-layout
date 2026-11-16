const { PNG } = require('/agent/repos/lug-layout/.probe/node_modules/playwright-core/lib/utilsBundle');
const fs = require('fs');
const [a, b] = process.argv.slice(2).map((f) => PNG.sync.read(fs.readFileSync(f)));
if (a.width !== b.width || a.height !== b.height) { console.log(JSON.stringify({ sizeMismatch: [a.width, a.height, b.width, b.height] })); process.exit(0); }
let differing = 0, maxDelta = 0;
for (let i = 0; i < a.data.length; i += 4) {
  let d = 0;
  for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
  if (d > 0) differing++;
  maxDelta = Math.max(maxDelta, d);
}
console.log(JSON.stringify({ width: a.width, height: a.height, pixels: a.width * a.height, differing, maxDelta }));
