import { readFileSync, writeFileSync } from "node:fs";
import { bundle, loadModel, exposedTops, modelCamera } from "./plates.mjs";
import { load, save, crop, hcat } from "./img.mjs";

const TILES = ["ldraw:3068b", "ldraw:3069b", "ldraw:3070b", "ldraw:63864", "ldraw:2431", "ldraw:6636", "ldraw:87079"];
const STUDDED = ["ldraw:3020", "ldraw:3021", "ldraw:3022", "ldraw:3795", "ldraw:3034", "ldraw:3832", "ldraw:3001", "ldraw:3003", "ldraw:3002", "ldraw:2456", "ldraw:3031", "ldraw:3032", "ldraw:3958"];
const STUD = 20;

function samplePoints(b, p, studded) {
  const bb = b.bounds.get(p.part);
  const top = bb.max[1];
  const local = [];
  if (!studded) {
    local.push([(bb.min[0] + bb.max[0]) / 2, (bb.min[2] + bb.max[2]) / 2]);
  } else {
    const nx = Math.round((bb.max[0] - bb.min[0]) / STUD), nz = Math.round((bb.max[2] - bb.min[2]) / STUD);
    for (let i = 1; i < nx; i++) for (let k = 1; k < nz; k++) local.push([bb.min[0] + STUD * i, bb.min[2] + STUD * k]);
  }
  const m = p.m;
  return local.map(([x, z]) => [0, 1, 2].map((r) => m[r * 4] * x + m[r * 4 + 1] * top + m[r * 4 + 2] * z + m[r * 4 + 3]));
}
const FOV_DEGREES = 40;
const TOP_VIEW_DISTANCE_FACTOR = 3.2;
const HALF_BLOCK = 2;

function srgbToLab([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b, a) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm = h1p + h2p < 360 ? (hpm + 360) / 2 : (hpm - 360) / 2;
    else hpm = hpm / 2;
  }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const SC = 1 + 0.045 * Cpm, SH = 1 + 0.015 * Cpm * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

function project(point, eye, width, height) {
  const f = height / 2 / Math.tan((FOV_DEGREES * Math.PI) / 360);
  const dx = point[0] - eye[0], dy = point[1] - eye[1], dz = point[2] - eye[2];
  return { x: width / 2 + (f * dx) / -dy, y: height / 2 + (f * dz) / -dy, angle: (Math.atan(Math.hypot(dx, dz) / -dy) * 180) / Math.PI };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const [bundleDir, shotsJson, outJson] = process.argv.slice(2);
const b = bundle(bundleDir);
const plan = JSON.parse(readFileSync(shotsJson));
const perShot = [];
for (const { color, model, png } of plan) {
  const inst = loadModel(b, model);
  const cam = modelCamera(inst);
  const eye = [cam.centre[0], cam.centre[1] + cam.radius * TOP_VIEW_DISTANCE_FACTOR, cam.centre[2] + 0.001];
  const image = load(png);
  const height = image.height;
  const ref = b.colors.get(color);
  const refRgb = [1, 3, 5].map((i) => parseInt(ref.rgb.slice(i, i + 2), 16));
  const samples = [];
  for (const part of [...TILES, ...STUDDED]) {
    for (const p of exposedTops(inst, part)) {
      if (p.color !== color) continue;
      for (const point of samplePoints(b, p, STUDDED.includes(part))) {
      const s = project(point, eye, image.width, height);
      const px = Math.round(s.x), py = Math.round(s.y);
      const rs = [], gs = [], bs = [];
      for (let j = -HALF_BLOCK; j <= HALF_BLOCK; j++)
        for (let i = -HALF_BLOCK; i <= HALF_BLOCK; i++) {
          const o = ((py + j) * image.width + px + i) * 4;
          rs.push(image.data[o]); gs.push(image.data[o + 1]); bs.push(image.data[o + 2]);
        }
      const rgb = [median(rs), median(gs), median(bs)];
      samples.push({ instance: p.i, part: p.part, px, py, viewAngleDeg: +s.angle.toFixed(1), rgb, deltaE2000: +deltaE2000(srgbToLab(refRgb), srgbToLab(rgb)).toFixed(2) });
      }
    }
  }
  perShot.push({ color, name: ref.name, ldconfig: ref.rgb, samples: samples.map((s) => ({ model, ...s })) });
  const insets = samples.slice(0, 6).map((s) => crop(image, Math.max(0, s.px - 12), Math.max(0, s.py - 12), 25, 25, 4));
  if (insets.length > 0) save(hcat(insets), png.replace(/\.png$/, `-samples-${color}.png`));
}
const report = [];
for (const color of [...new Set(perShot.map((p) => p.color))]) {
  const shots = perShot.filter((p) => p.color === color);
  const samples = shots.flatMap((p) => p.samples);
  const dE = samples.map((s) => s.deltaE2000);
  report.push({
    color, name: shots[0].name, ldconfig: shots[0].ldconfig, samples,
    medianRgb: [0, 1, 2].map((k) => median(samples.map((s) => s.rgb[k]))),
    medianDeltaE2000: median(dE), minDeltaE2000: Math.min(...dE), maxDeltaE2000: Math.max(...dE),
  });
}
writeFileSync(outJson, JSON.stringify(report, null, 1));
for (const r of report) console.log(r.name, r.ldconfig, "median rgb", r.medianRgb.join(","), "n", r.samples.length, "median dE", r.medianDeltaE2000, "min", r.minDeltaE2000, "max", r.maxDeltaE2000);
