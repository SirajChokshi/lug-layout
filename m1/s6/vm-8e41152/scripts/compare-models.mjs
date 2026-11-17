import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

export function diffPng(pathA, pathB) {
  const a = PNG.sync.read(readFileSync(pathA));
  const b = PNG.sync.read(readFileSync(pathB));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${pathA}`);
  let pixels = 0;
  let maxDelta = 0;
  let box = null;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4;
      let delta = 0;
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(a.data[o + c] - b.data[o + c]));
      if (delta === 0) continue;
      pixels++;
      maxDelta = Math.max(maxDelta, delta);
      box = box
        ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
        : [x, y, x, y];
    }
  }
  return { width: a.width, height: a.height, differingPixels: pixels, maxChannelDelta: maxDelta, diffBox: box };
}

if (process.argv[1].endsWith("compare-models.mjs")) {
  const [beforeDir, afterDir, outPath] = process.argv.slice(2);
  const before = JSON.parse(readFileSync(join(beforeDir, "runs.json"), "utf8"));
  const after = JSON.parse(readFileSync(join(afterDir, "runs.json"), "utf8"));
  const rows = after.map((row) => {
    const b = before.find((r) => r.set === row.set && r.frames === row.frames);
    const name = `${row.set}-t${row.frames}.png`;
    return {
      set: row.set,
      cameraT: row.cameraT,
      ...diffPng(join(beforeDir, name), join(afterDir, name)),
      studsBefore: b.visibleStudInstances,
      studsAfter: row.visibleStudInstances,
      trianglesBefore: b.drawnTriangles,
      trianglesAfter: row.drawnTriangles,
      drawCallsBefore: b.drawCalls,
      drawCallsAfter: row.drawCalls,
    };
  });
  writeFileSync(outPath, JSON.stringify(rows, null, 2));
  for (const r of rows) {
    console.log(
      r.set.padEnd(8),
      r.cameraT.toFixed(3),
      String(r.differingPixels).padStart(7),
      String(r.maxChannelDelta).padStart(4),
      JSON.stringify(r.diffBox),
      r.studsBefore,
      r.studsAfter,
      r.trianglesBefore,
      r.trianglesAfter,
    );
  }
}
