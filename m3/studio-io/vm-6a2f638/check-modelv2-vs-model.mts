import { readFile, readdir } from "node:fs/promises";
import { BrickCompiler } from "/agent/repos/lug-layout/packages/import/src/brick-compiler.ts";
import { execFileSync } from "node:child_process";
const wasm = await readFile(process.argv[2]);
const compiler = new BrickCompiler(await WebAssembly.compile(wasm));
const dir = process.argv[3];
const norm = (t: string) => t.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim().split(/\s+/).join(" ")).filter((l) => l !== "");
for (const f of (await readdir(dir)).sort()) {
  const bytes = new Uint8Array(await readFile(`${dir}/${f}`));
  const t0 = performance.now();
  const r = await compiler.readStudio(bytes);
  const ms = (performance.now() - t0).toFixed(1);
  if (r.status === "rejected") { console.log(f, "REJECTED", r.kind, ms + "ms"); continue; }
  let same = "n/a";
  try {
    const model = execFileSync("unzip", ["-p", `${dir}/${f}`, "model.ldr"], { maxBuffer: 1 << 28 }).toString();
    const a = norm(r.ldraw), b = norm(model);
    same = a.length === b.length && a.every((l, i) => l === b[i]) ? "identical" : "DIFFERENT";
  } catch {}
  console.log(f, r.entry, r.studioVersion, "converted", r.convertedLines, "unconverted", r.unconvertedLines.length, "blIds", Object.keys(r.bricklinkIds).length, "custom", r.customParts.length, "vs model.ldr:", same, ms + "ms");
}
