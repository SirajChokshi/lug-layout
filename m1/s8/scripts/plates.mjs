import { readFileSync } from "node:fs";

export function bundle(dir) {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`));
  const bounds = new Map(manifest.parts.map((p) => [p.id, p.bounds]));
  const colors = new Map(manifest.colors.map((c) => [c.code, c]));
  return { dir, manifest, bounds, colors };
}

export function loadModel(b, name) {
  const entry = b.manifest.models.find((m) => m.name === name);
  const file = JSON.parse(readFileSync(`${b.dir}/${entry.file}`));
  const n = file.instances.part.length;
  const inst = [];
  for (let i = 0; i < n; i++) {
    const m = file.instances.matrix.slice(i * 12, i * 12 + 12);
    const part = file.parts[file.instances.part[i]];
    const bb = b.bounds.get(part);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const cx of [bb.min[0], bb.max[0]])
      for (const cy of [bb.min[1], bb.max[1]])
        for (const cz of [bb.min[2], bb.max[2]]) {
          const w = [0, 1, 2].map((r) => m[r * 4] * cx + m[r * 4 + 1] * cy + m[r * 4 + 2] * cz + m[r * 4 + 3]);
          for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], w[a]); max[a] = Math.max(max[a], w[a]); }
        }
    inst.push({ i, part, color: file.instances.color[i], m, min, max });
  }
  return inst;
}

export function exposedTops(inst, partId) {
  const result = [];
  for (const p of inst) {
    if (p.part !== partId) continue;
    if (Math.abs(p.m[5] - 1) > 1e-6) continue;
    const top = p.max[1];
    const covered = inst.some(
      (q) =>
        q !== p &&
        q.max[1] > top + 0.5 &&
        q.min[0] < p.max[0] - 0.5 && q.max[0] > p.min[0] + 0.5 &&
        q.min[2] < p.max[2] - 0.5 && q.max[2] > p.min[2] + 0.5,
    );
    if (!covered) result.push(p);
  }
  return result;
}

export function modelCamera(inst) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of inst) for (let a = 0; a < 3; a++) {
    const v = p.m[3 + a * 4];
    min[a] = Math.min(min[a], v); max[a] = Math.max(max[a], v);
  }
  const c = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
  let r = 0;
  for (const p of inst) r = Math.max(r, Math.hypot(p.m[3] - c[0], p.m[7] - c[1], p.m[11] - c[2]));
  r = Math.max(r, 200);
  return { centre: c, radius: r };
}
