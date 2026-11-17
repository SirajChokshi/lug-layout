import { load, save, crop, hcat } from "./img.mjs";
import { sceneBox } from "./bbox.mjs";
import { mkdirSync } from "node:fs";
const [dir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
for (const m of ["7936-1", "10264-1", "10185-1", "10190-1", "10218-1", "2150-1", "4554-1", "4555-1", "10128-1", "10133-1"]) {
  const b = `${dir}/before-${m}.png`, a = `${dir}/after-${m}.png`;
  const box = sceneBox([b, a]);
  save(hcat([crop(load(b), box.x, box.y, box.w, box.h), crop(load(a), box.x, box.y, box.w, box.h)], 12), `${out}/${m}-before-after.png`);
  save(crop(load(a), box.x, box.y, box.w, box.h), `${out}/${m}-after.png`);
}
for (const c of ["street", "aerial"]) {
  save(hcat([load(`${dir}/before-city20k-${c}.png`), load(`${dir}/after-city20k-${c}.png`)], 12), `${out}/city20k-${c}-before-after.png`);
}
