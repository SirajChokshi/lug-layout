import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BUNDLE ?? "/agent/repos/lug-layout/tools/asset-pipeline/dist/bundle/standard";
const [setName, clusterJson] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const entry = manifest.models.find((m) => m.name === setName);
const model = JSON.parse(readFileSync(join(dir, entry.file), "utf8"));
const partsById = new Map(manifest.parts.map((p) => [p.id, p]));

function glbExtras(file) {
  const bytes = readFileSync(join(dir, file));
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
  return json.extras ?? json.asset?.extras;
}
const studsOf = new Map();
for (const id of model.parts) {
  const extras = glbExtras(partsById.get(id).file);
  studsOf.set(id, extras.studs.map((s) => s.matrix));
}

function compose(a, b) {
  const out = new Array(12);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      out[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return out;
}

const inst = model.instances;
const n = inst.part.length;
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < n; i++)
  for (let a = 0; a < 3; a++) {
    const v = inst.matrix[i * 12 + 3 + a * 4];
    min[a] = Math.min(min[a], v);
    max[a] = Math.max(max[a], v);
  }
const centre = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
let radius = 0;
for (let i = 0; i < n; i++) {
  const d = [0, 1, 2].map((a) => inst.matrix[i * 12 + 3 + a * 4] - centre[a]);
  radius = Math.max(radius, Math.hypot(...d));
}
radius = Math.max(radius, 200);
const t = Number(process.env.T ?? 0);
const eye = [
  centre[0] + radius * 2.8 * Math.cos(t * 2 * Math.PI),
  centre[1] + radius * 0.9,
  centre[2] + radius * 2.8 * Math.sin(t * 2 * Math.PI),
];
const W = 1280;
const H = 801;
const f = 1 / Math.tan((40 * Math.PI) / 360);
const fwd = centre.map((c, a) => c - eye[a]);
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const zf = norm(fwd);
const right = norm([zf[1] * 0 - zf[2] * 1, zf[2] * 0 - zf[0] * 0, zf[0] * 1 - zf[1] * 0]);
const up = [
  right[1] * zf[2] - right[2] * zf[1],
  right[2] * zf[0] - right[0] * zf[2],
  right[0] * zf[1] - right[1] * zf[0],
];
function project(p) {
  const d = p.map((v, a) => v - eye[a]);
  const z = d[0] * zf[0] + d[1] * zf[1] + d[2] * zf[2];
  const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
  const y = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
  return [W / 2 + ((x / z) * f * H) / 2, H / 2 - ((y / z) * f * H) / 2];
}
const bits = model.cover.visibleBits;
const clusters = JSON.parse(clusterJson);
let stud = 0;
const hits = [];
for (let i = 0; i < n; i++) {
  const id = model.parts[inst.part[i]];
  const m = inst.matrix.slice(i * 12, i * 12 + 12);
  for (const sm of studsOf.get(id)) {
    const visible = (bits[stud >>> 5] >>> (stud & 31)) & 1;
    if (!visible) {
      const w = compose(m, sm);
      const top = [w[3] + w[1] * 4, w[7] + w[5] * 4, w[11] + w[9] * 4];
      const [sx, sy] = project(top);
      for (const c of clusters) {
        if (Math.hypot(sx - c.x, sy - c.y) < 10)
          hits.push({ cluster: c, stud, instance: i, part: id, color: inst.color[i], at: top.map((v) => +v.toFixed(2)), up: [w[1], w[5], w[9]].map((v) => +v.toFixed(3)) });
      }
    }
    stud++;
  }
}
console.log(JSON.stringify(hits, null, 0));
