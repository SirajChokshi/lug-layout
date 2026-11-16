const fs = require("node:fs");
const lib = require("./s5-lib.cjs");

const SETS = [
  "omr:10264-1",
  "omr:10185-1",
  "omr:10190-1",
  "omr:10218-1",
  "omr:4555-1",
  "omr:2150-1",
  "omr:4554-1",
  "omr:10128-1",
  "omr:7936-1",
  "omr:10133-1",
];
const SPACING_LDU = 1600;
const TIERS = ["auto", "near", "mid", "far"];
const ZOOM_STEP = 60;
const NEAR_MIN_PX = 12;
const MAX_RECENTRE_LDU = 2400;
const MID_MIN_PX = 3;

function layout(scene) {
  const columns = scene === "50" ? 10 : 5;
  const rows = scene === "50" ? 5 : 2;
  const spots = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = (col - (columns - 1) / 2) * SPACING_LDU;
      const z = (row - (rows - 1) / 2) * SPACING_LDU;
      spots.push({
        id: SETS[(row * columns + col) % SETS.length],
        x: Math.round(x / 20) * 20,
        z: Math.round(z / 20) * 20,
        rot: (row + col) % 4,
      });
    }
  }
  return { columns, rows, spots };
}

async function hudValue(page, label) {
  return page.evaluate((wanted) => {
    for (const row of document.querySelectorAll(".hud dl > div")) {
      if (row.querySelector("dt")?.textContent === wanted) return row.querySelector("dd")?.textContent ?? null;
    }
    return null;
  }, label);
}

async function settle(page, frames = 3) {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  }
  await page.waitForTimeout(700);
}

async function setTier(page, tier) {
  for (let i = 0; i < 4; i++) {
    if ((await hudValue(page, "Tier (T)")) === tier) return;
    await page.keyboard.press("t");
    await settle(page, 1);
  }
  throw new Error(`tier did not reach ${tier}`);
}

async function measure(page) {
  await page.keyboard.press("m");
  await page.waitForFunction(
    () => document.querySelector("#edit-state")?.dataset.measuring === "0" &&
      JSON.parse(document.querySelector("#edit-state").textContent).measurement !== null,
    null,
    { timeout: 3_600_000, polling: 250 },
  );
  return (await lib.state(page)).measurement;
}

async function pitch(page) {
  return Number.parseFloat((await hudValue(page, "Projected stud pitch, nearest chunk")) ?? "NaN");
}

async function capture(page, out, name, measureTiers, records) {
  for (const tier of TIERS) {
    await setTier(page, tier);
    await settle(page);
    const file = `${out}/${name}-${tier}.png`;
    await page.screenshot({ path: file, timeout: 0 });
    const state = await lib.state(page);
    const record = {
      view: name,
      tier,
      screenshot: file,
      hud: await page.innerText(".hud"),
      stats: state.stats,
      measurement: measureTiers.includes(tier) ? await measure(page) : null,
    };
    records.push(record);
    console.log(name, tier, JSON.stringify(record.stats), record.measurement ? JSON.stringify(record.measurement) : "");
  }
  await setTier(page, "auto");
}

(async () => {
  const scene = lib.arg("scene", "10");
  const api = lib.arg("api", "webgpu");
  const base = lib.arg("base", "http://localhost:4173");
  const out = lib.arg("out", `s7-${scene}-${api}`);
  const width = Number(lib.arg("width", "1800"));
  const height = Number(lib.arg("height", "1000"));
  const measureTiers = lib.arg("measure", "auto,near").split(",").filter((t) => t !== "");
  const video = lib.arg("video", "0") === "1";
  fs.mkdirSync(out, { recursive: true });
  const { browser, context, page, consoleLines } = await lib.openEditor({
    api,
    base,
    width,
    height,
    videoDir: video ? out : undefined,
  });
  const steps = [];
  const note = (text) => {
    steps.push(`${new Date().toISOString()} ${text}`);
    console.log(text);
  };
  const { columns, spots } = layout(scene);
  let centreX = 0;
  const walkTo = async (x, z) => {
    while (centreX !== x) {
      const gap = x - centreX;
      const next = Math.abs(gap) > MAX_RECENTRE_LDU ? centreX + Math.sign(gap) * MAX_RECENTRE_LDU : x;
      await lib.centreOn(page, next, z);
      centreX = next;
    }
  };
  await lib.zoom(page, scene === "50" ? 1500 : 1350);
  await settle(page);
  for (let col = 0; col < columns; col++) {
    const column = spots.filter((_, i) => i % columns === col);
    if (scene === "50") await walkTo(column[0].x, 0);
    for (const spot of column) await lib.place(page, "ldraw:3811", spot.x, spot.z, 0);
    for (const spot of column) {
      await lib.place(page, spot.id, spot.x, spot.z, spot.rot);
      note(`placed ${spot.id} at (${spot.x}, ${spot.z}) rot ${spot.rot}`);
    }
  }
  await page.keyboard.press("Escape");
  const records = [];
  const street = spots[Math.floor(columns / 2)];
  await walkTo(street.x, 0);
  await lib.centreOn(page, street.x, 0);
  await page.keyboard.press("Escape");
  await page.mouse.move(width / 2, height / 2);
  await lib.zoom(page, scene === "50" ? -2050 : -1900);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 25; i++) await page.mouse.move(width / 2, height / 2 - i * 4);
  await page.mouse.up({ button: "right" });
  await settle(page);
  note(`street view: stud pitch ${await pitch(page)} px`);
  await capture(page, out, "street", measureTiers, records);
  const series = [];
  let crossedNear = false;
  let crossedMid = false;
  for (let step = 0; step < 120; step++) {
    const px = await pitch(page);
    const state = await lib.state(page);
    series.push({ step, wheel: step * ZOOM_STEP, pitchPx: px, stats: state.stats });
    await page.screenshot({ path: `${out}/zoom-${String(step).padStart(2, "0")}.png`, timeout: 0 });
    if (!crossedNear && px < NEAR_MIN_PX) {
      crossedNear = true;
      note(`near/mid transition at step ${step}: ${px} px`);
      await capture(page, out, "transition-near-mid", [], records);
    }
    if (!crossedMid && px < MID_MIN_PX) {
      crossedMid = true;
      note(`mid/far transition at step ${step}: ${px} px`);
      await capture(page, out, "transition-mid-far", [], records);
      break;
    }
    await lib.zoom(page, ZOOM_STEP);
    await settle(page);
  }
  await lib.zoom(page, scene === "50" ? 900 : 700);
  await settle(page);
  note(`aerial view: stud pitch ${await pitch(page)} px`);
  await capture(page, out, "aerial", measureTiers, records);
  fs.writeFileSync(`${out}/records.json`, JSON.stringify(records, null, 2));
  fs.writeFileSync(`${out}/zoom-series.json`, JSON.stringify(series, null, 2));
  fs.writeFileSync(`${out}/edit-state.json`, JSON.stringify(await lib.state(page)));
  fs.writeFileSync(`${out}/steps.txt`, steps.join("\n"));
  fs.writeFileSync(`${out}/console.txt`, consoleLines.join("\n"));
  await context.close();
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
