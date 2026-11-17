import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const BASE = args.url ?? "http://127.0.0.1:5173/";
const API = args.api ?? "webgl2";
const SIDE = Number(args.side ?? 45);
const MODULES = Number(args.modules ?? SIDE * SIDE);
const PITCH_CHUNKS = Number(args.pitch ?? 2);
const SUPER = args.superchunks ?? "1";
const CHECKPOINTS = (args.checkpoints ?? "")
  .split(",")
  .filter(Boolean)
  .map(Number);
const OUT = args.out ?? "/tmp/pw/out";
const WIDTH = Number(args.width ?? 1280);
const HEIGHT = Number(args.height ?? 800);
const HEADLESS = args.headless === "1";
const VIDEO = args.video ?? null;
const BUILD_DISTANCE = Number(args.buildDistance ?? 9000);
mkdirSync(OUT, { recursive: true });

const CHUNK = 640;
const PITCH = PITCH_CHUNKS * CHUNK;
const ORDER = [
  "omr:2150-1",
  "omr:7936-1",
  "omr:4554-1",
  "omr:10133-1",
  "omr:10128-1",
  "omr:10185-1",
  "omr:10264-1",
  "omr:10218-1",
  "omr:4555-1",
  "omr:10190-1",
];
const WIDE = new Set(["omr:2150-1", "omr:4554-1"]);

const cam = {
  tx: 0,
  tz: 0,
  ty: 0,
  distance: 2600,
  yaw: Math.PI / 4,
  pitch: 0.75,
};
const FOV = (40 * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const launchArgs = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: HEADLESS,
  args: launchArgs,
});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  ...(VIDEO ? { recordVideo: { dir: VIDEO, size: { width: WIDTH, height: HEIGHT } } } : {}),
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
const url = `${BASE}?api=${API}&frames=${args.frames ?? 120}${SUPER === "0" ? "&superchunks=0" : ""}`;
await page.goto(url);
await page.waitForSelector(".editor[data-status=ready]", { timeout: 300000, state: "attached" });
const canvasBox = await page.locator("canvas.scene").boundingBox();
const hudBox = await page.locator(".editor-hud").boundingBox();
const panelBox = await page.locator(".side-panel").boundingBox();
const footerBox = await page.locator("footer").boundingBox();
const safe = {
  x0: (hudBox ? hudBox.x + hudBox.width : 0) + 10,
  x1: (panelBox ? panelBox.x : canvasBox.width) - 10,
  y0: 10,
  y1: (footerBox ? footerBox.y : canvasBox.height) - 10,
};
const centre = { x: (safe.x0 + safe.x1) / 2, y: (safe.y0 + safe.y1) / 2 };

function eye() {
  const h = cam.distance * Math.cos(cam.pitch);
  return [
    cam.tx + h * Math.cos(cam.yaw),
    cam.ty + cam.distance * Math.sin(cam.pitch),
    cam.tz + h * Math.sin(cam.yaw),
  ];
}

function project(wx, wz) {
  const [ex, ey, ez] = eye();
  let fx = cam.tx - ex,
    fy = cam.ty - ey,
    fz = cam.tz - ez;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let rx = fy * 0 - fz * 1,
    ry = fz * 0 - fx * 0,
    rz = fx * 1 - fy * 0;
  const rl = Math.hypot(rx, ry, rz);
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = ry * fz - rz * fy,
    uy = rz * fx - rx * fz,
    uz = rx * fy - ry * fx;
  const px = wx - ex,
    py = 0 - ey,
    pz = wz - ez;
  const cx = px * rx + py * ry + pz * rz;
  const cy = px * ux + py * uy + pz * uz;
  const cz = px * fx + py * fy + pz * fz;
  if (cz <= 0) return [Number.NaN, Number.NaN];
  const aspect = canvasBox.width / canvasBox.height;
  const t = Math.tan(FOV / 2);
  const ndcX = cx / (cz * t * aspect);
  const ndcY = cy / (cz * t);
  return [
    canvasBox.x + ((ndcX + 1) / 2) * canvasBox.width,
    canvasBox.y + ((1 - ndcY) / 2) * canvasBox.height,
  ];
}

async function hover() {
  const value = await page.locator(".editor").getAttribute("data-hover");
  if (!value) return null;
  const [x, z] = value.split(",").map(Number);
  return { x, z };
}

async function moveTo(x, y) {
  tally.moves++;
  if (args.integerMouse) {
    x = Math.round(x);
    y = Math.round(y);
  }
  await page.mouse.move(x, y);
  for (let i = 0; i < 20; i++) {
    const h = await hover();
    if (h) return h;
    await page.waitForTimeout(5);
  }
  return null;
}

function inSafe(x, y) {
  return x > safe.x0 && x < safe.x1 && y > safe.y0 && y < safe.y1;
}

async function aimAt(tx, tz) {
  let [x, y] = project(tx, tz);
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !inSafe(x, y)) return null;
    const h = await moveTo(x, y);
    if (h && h.x === tx && h.z === tz) return [x, y];
    await page.waitForTimeout(5);
    const again = await hover();
    if (again && again.x === tx && again.z === tz) return [x, y];
    const got = again ?? h;
    if (!got) return null;
    const [gx, gy] = project(got.x, got.z);
    const [qx, qy] = project(tx, tz);
    x += qx - gx;
    y += qy - gy;
    if (attempt > 3) {
      x += Math.random() * 2 - 1;
      y += Math.random() * 2 - 1;
    }
  }
  return null;
}

const HOP_GROUND_FRACTION = 0.3;
const MIN_HOP_LDU = 200;

function snap(ldu) {
  return Math.round(ldu / 20) * 20;
}

function inHopBox(x, y) {
  const w = safe.x1 - safe.x0;
  const h = safe.y1 - safe.y0;
  return (
    x > centre.x - 0.3 * w &&
    x < centre.x + 0.3 * w &&
    y > centre.y - 0.15 * h &&
    y < centre.y + 0.35 * h
  );
}

async function hopTowards(tx, tz) {
  const dx = tx - cam.tx;
  const dz = tz - cam.tz;
  const full = Math.hypot(dx, dz);
  let step = Math.min(full, cam.distance * HOP_GROUND_FRACTION);
  let first = true;
  while (step > 0 && (first || step >= MIN_HOP_LDU)) {
    first = false;
    const hx = snap(cam.tx + (dx / full) * step);
    const hz = snap(cam.tz + (dz / full) * step);
    const [px, py] = project(hx, hz);
    if (Number.isFinite(px) && Number.isFinite(py) && inHopBox(px, py)) {
      const h = await moveTo(px, py);
      if (h) return h;
    }
    step /= 2;
  }
  await page.screenshot({ path: `${OUT}/fail.png` });
  throw new Error(`cannot hop from ${cam.tx},${cam.tz} towards ${tx},${tz}; cam ${JSON.stringify(cam)}`);
}

const MIN_AIM_DISTANCE_LDU = 2500;

async function centreOn(tx, tz) {
  tally.centres++;
  const goX = page.getByLabel("Go to x (LDU)");
  if ((await goX.count()) > 0) {
    await goX.fill(String(tx));
    await page.getByLabel("Go to z (LDU)").fill(String(tz));
    await page.getByRole("button", { name: "Go to x, z" }).click();
    cam.tx = tx;
    cam.tz = tz;
    cam.ty = 0;
    await page.waitForTimeout(50);
    return;
  }
  for (let hop = 0; hop < 400; hop++) {
    const aim = await aimAt(tx, tz);
    if (aim) {
      await page.keyboard.press("c");
      cam.tx = tx;
      cam.tz = tz;
      cam.ty = 0;
      return;
    }
    if (Math.hypot(tx - cam.tx, tz - cam.tz) < MIN_HOP_LDU) {
      if (cam.distance <= MIN_AIM_DISTANCE_LDU) {
        throw new Error(`cannot aim at ${tx},${tz} even at ${cam.distance} LDU`);
      }
      tally.zooms++;
      await zoomTo(Math.max(cam.distance / 2, MIN_AIM_DISTANCE_LDU));
      continue;
    }
    const h = await hopTowards(tx, tz);
    await page.keyboard.press("c");
    cam.tx = h.x;
    cam.tz = h.z;
    cam.ty = 0;
  }
  throw new Error(`could not centre on ${tx},${tz}`);
}

async function orbitTo(yaw, pitch) {
  const startX = centre.x;
  const startY = centre.y;
  const dx = Math.round((yaw - cam.yaw) / 0.005);
  const dy = Math.round((pitch - cam.pitch) / 0.005);
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "right" });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
  }
  await page.mouse.up({ button: "right" });
  cam.yaw += dx * 0.005;
  cam.pitch = clamp(cam.pitch + dy * 0.005, 0.12, 1.5);
}

async function zoomTo(distance) {
  await page.mouse.move(centre.x, centre.y);
  const delta = Math.log(distance / cam.distance) / 0.001;
  const step = 400;
  let left = delta;
  while (Math.abs(left) > 0.5) {
    const d = Math.abs(left) > step ? Math.sign(left) * step : left;
    await page.mouse.wheel(0, d);
    cam.distance = clamp(cam.distance * Math.exp(d * 0.001), 120, 60000);
    left -= d;
  }
}

const catalogItems = await page.$$eval("[data-item]", (els) => els.map((el) => el.getAttribute("data-item")));
const BASEPLATE_ITEM =
  catalogItems.find((id) => id === "ldraw:3811@2") ?? catalogItems.find((id) => id === "ldraw:3811");
if (!BASEPLATE_ITEM) throw new Error(`no green 3811 baseplate in the catalog: ${catalogItems.join(", ")}`);
let ghostRot = 0;
async function choose(item) {
  const button = page.locator(`[data-item="${item}"]`);
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error(`catalog item ${item} is not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const active = await page.locator(`[data-item="${item}"]`).getAttribute("aria-pressed");
  if (active !== "true") throw new Error(`catalog item ${item} did not activate`);
}

const tally = { moves: 0, aims: 0, centres: 0, zooms: 0 };
async function placementCount() {
  return page.evaluate(() => {
    const dt = [...document.querySelectorAll(".editor-hud dt")].find((d) => d.textContent === "Placements");
    return Number(dt?.nextElementSibling?.textContent?.replace(/,/g, "") ?? "0");
  });
}

async function placeAt(tx, tz) {
  tally.aims++;
  const before = await placementCount();
  for (let attempt = 0; attempt < 2; attempt++) {
    let aim = await aimAt(tx, tz);
    if (!aim) {
      await centreOn(tx, tz);
      aim = await aimAt(tx, tz);
    }
    if (!aim) throw new Error(`cannot aim at ${tx},${tz}`);
    await page.mouse.click(aim[0], aim[1]);
    if (cam.distance < BUILD_DISTANCE) await zoomTo(BUILD_DISTANCE);
    for (let wait = 0; wait < 40; wait++) {
      if ((await placementCount()) > before) return;
      await page.waitForTimeout(50);
    }
    tally.retries = (tally.retries ?? 0) + 1;
  }
  throw new Error(`placement at ${tx},${tz} did not register`);
}

async function setRotation(rot) {
  while (ghostRot !== rot) {
    await page.keyboard.press("r");
    ghostRot = (ghostRot + 1) % 4;
  }
  const current = Number(await page.locator(".editor").getAttribute("data-ghost-rot"));
  if (current !== rot) throw new Error(`ghost rotation ${current}, expected ${rot}`);
}

function cells() {
  const list = [];
  for (let row = 0; row < SIDE; row++) {
    for (let k = 0; k < SIDE; k++) {
      const col = row % 2 === 0 ? k : SIDE - 1 - k;
      list.push({ row, col });
    }
  }
  return list.slice(0, MODULES);
}

function moduleAt(cell) {
  const x = cell.col * PITCH + CHUNK / 2;
  const z = cell.row * PITCH + CHUNK / 2;
  const item = ORDER[(cell.col + 3 * cell.row) % ORDER.length];
  const rot = WIDE.has(item) ? (cell.row % 2) * 2 : cell.row % 4;
  return { x, z, item, rot };
}

async function placements() {
  return page.evaluate(() => {
    const dd = [...document.querySelectorAll(".editor-hud dt")].find((d) => d.textContent === "Placements");
    return Number(dd?.nextElementSibling?.textContent?.replace(/,/g, "") ?? "0");
  });
}

const poses = {
  street: { yaw: Math.PI / 4, pitch: 0.35, distance: 3200, at: [3 * PITCH, 3 * PITCH] },
  aerial: { yaw: Math.PI / 4, pitch: 0.9, distance: 60000, at: [((SIDE - 1) * PITCH) / 2, ((SIDE - 1) * PITCH) / 2] },
};

async function heapSnapshot(label) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const chunks = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (e) => chunks.push(e.chunk));
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  writeFileSync(`${OUT}/${label}.heapsnapshot`, chunks.join(""));
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  console.log(`heap snapshot ${label}: used ${(usedSize / 2 ** 20).toFixed(0)} MiB`);
  await cdp.detach();
}

async function heapAfterGc() {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  await cdp.detach();
  return usage;
}

const results = existsSync(`${OUT}/results.json`) && args.append ? JSON.parse(readFileSync(`${OUT}/results.json`, "utf8")) : [];
async function measure(label) {
  const saved = { ...cam };
  for (const [name, pose] of Object.entries(poses)) {
    await zoomTo(20000);
    await orbitTo(pose.yaw, 1.2);
    await centreOn(pose.at[0], pose.at[1]);
    await orbitTo(pose.yaw, pose.pitch);
    await zoomTo(pose.distance);
    await page.mouse.move(canvasBox.width - 2, canvasBox.height - 2);
    const previous = await page.evaluate(() => document.querySelector("#measurement")?.textContent ?? null);
    await page.keyboard.press("m");
    await page.waitForFunction((prev) => (document.querySelector("#measurement")?.textContent ?? null) !== prev, previous, { timeout: 3600000, polling: 500 });
    const text = await page.locator("#measurement").textContent();
    const m = JSON.parse(text);
    const hud = await page.locator(".editor-hud").innerText();
    const heapAfterGcBytes = await heapAfterGc();
    const entry = { label, pose: name, url, viewport: [WIDTH, HEIGHT], measurement: m, heapAfterGcBytes, hud };
    results.push(entry);
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
    await page.screenshot({ path: `${OUT}/${label}-${name}.png` });
    console.log(label, name, `median ${m.medianFrameMs.toFixed(1)} p95 ${m.p95FrameMs.toFixed(1)} draws ${m.drawCalls} tris ${m.triangles} live ${m.liveChunks} superDrawn ${m.superChunksDrawn} heap ${(m.jsHeapBytes / 2 ** 20).toFixed(0)}MiB gc-heap ${(heapAfterGcBytes.usedSize / 2 ** 20).toFixed(0)}MiB backing ${((heapAfterGcBytes.backingStorageSize ?? 0) / 2 ** 20).toFixed(0)}MiB gpu ${((m.gpuVertexIndexBytes + m.gpuOtherBytes) / 2 ** 20).toFixed(0)}MiB settle ${m.settleMs.toFixed(0)}`);
  }
  await zoomTo(20000);
  await orbitTo(saved.yaw, 1.2);
  await centreOn(saved.tx, saved.tz);
  await zoomTo(saved.distance);
  await orbitTo(saved.yaw, saved.pitch);
}

await orbitTo(cam.yaw, 1.2);
await zoomTo(BUILD_DISTANCE);
if (args.hopTest) {
  const hops = [
    [snap(cam.tx + 102), snap(cam.tz)],
    [snap(cam.tx + 102), snap(cam.tz + 160)],
    [5440, 320],
    [28160, 28160],
    [snap(28160 - 100), snap(28160 + 160)],
    [320, 320],
    [snap(320 + 160), snap(320 - 100)],
  ];
  for (const [hx, hz] of hops) {
    const before = { ...tally };
    await centreOn(hx, hz);
    const aim = await aimAt(hx, hz);
    if (!aim) throw new Error(`hop test: not aimable at ${hx},${hz} after centring`);
    if (cam.distance < BUILD_DISTANCE) await zoomTo(BUILD_DISTANCE);
    console.log(`hop test ${hx},${hz}: ok, distance ${Math.round(cam.distance)}, zooms ${tally.zooms - before.zooms}, moves ${tally.moves - before.moves}`);
  }
}
const started = Date.now();
const all = cells().map(moduleAt);
const bounds = [0, ...CHECKPOINTS.filter((c) => c < all.length), all.length];
let placed = 0;
for (let b = 1; b < bounds.length; b++) {
  const batch = all.slice(bounds[b - 1], bounds[b]);
  await choose(BASEPLATE_ITEM);
  await setRotation(0);
  for (const m of batch) {
    await placeAt(m.x, m.z);
    placed++;
  }
  const groups = new Map();
  for (const m of batch) {
    const key = m.item;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const ordered = [...groups.entries()].sort();
  for (const [item, members] of ordered) {
    await choose(item);
    for (const m of members) {
      await setRotation(m.rot);
      const t0 = Date.now();
      await placeAt(m.x, m.z);
      if (args.verbose) console.log("place", m.item, Date.now() - t0, "ms", JSON.stringify(tally));
      placed++;
      if (placed % 50 === 0) console.log(`${placed} placements, ${((Date.now() - started) / 1000).toFixed(0)} s ${JSON.stringify(tally)}`);
    }
  }
  const count = await placements();
  console.log(`batch to ${bounds[b]} modules: HUD placements ${count}, expected ${2 * bounds[b]}`);
  if (count !== 2 * bounds[b]) throw new Error("placement count mismatch");
  if (CHECKPOINTS.includes(bounds[b])) {
    await page.keyboard.press("Escape");
    if (args.heap) await heapSnapshot(`m${bounds[b]}-built`);
    await measure(`m${bounds[b]}`);
    if (args.heap) await heapSnapshot(`m${bounds[b]}-measured`);
  }
}
const done = all.length;
await page.keyboard.press("Escape");
console.log(`built ${done} modules in ${((Date.now() - started) / 1000).toFixed(0)} s; placements ${await placements()}`);
if (args.tour) {
  const mid = ((SIDE - 1) * PITCH) / 2;
  await zoomTo(20000);
  await orbitTo(Math.PI / 4, 1.2);
  await centreOn(mid, mid);
  await orbitTo(Math.PI / 4, 0.35);
  await zoomTo(2500);
  await page.mouse.move(canvasBox.width - 2, canvasBox.height - 2);
  console.log("TOUR READY: touch /tmp/pw/tour-go to start");
  while (!existsSync("/tmp/pw/tour-go")) await page.waitForTimeout(1000);
  await page.waitForTimeout(3000);
  const steps = 40;
  const startDistance = cam.distance;
  for (let i = 1; i <= steps; i++) {
    const target = startDistance * Math.pow(60000 / startDistance, i / steps);
    await page.mouse.move(centre.x, centre.y);
    const delta = Math.log(target / cam.distance) / 0.001;
    await page.mouse.wheel(0, delta);
    cam.distance = target;
    await page.mouse.move(canvasBox.width - 2, canvasBox.height - 2);
    await page.waitForTimeout(1500);
  }
  await orbitTo(Math.PI / 4 + 1.2, 0.9);
  await page.waitForTimeout(5000);
  for (let i = steps; i >= 0; i--) {
    const target = 2500 * Math.pow(60000 / 2500, i / steps);
    await page.mouse.move(centre.x, centre.y);
    const delta = Math.log(target / cam.distance) / 0.001;
    await page.mouse.wheel(0, delta);
    cam.distance = target;
    await page.mouse.move(canvasBox.width - 2, canvasBox.height - 2);
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(10000);
  console.log("TOUR DONE");
}
if (args.hold) await page.waitForTimeout(Number(args.hold));
await context.close();
await browser.close();
