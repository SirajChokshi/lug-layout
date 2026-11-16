import fs from "node:fs";
import {
  calibrate, checkMs, chooseItem, closeUp, focusPiece, editState, openEditor, placeAt, probe, roadCounts, select, setCheckbox, setRot, zoom,
} from "./editor-driver.mjs";

const [out = "/tmp/m2"] = process.argv.slice(2);
const { browser, context, page } = await openEditor({
  url: "http://localhost:5173/?api=webgl2&state=1",
  video: process.env.VIDEO ? `${out}/video-plates` : undefined,
});
await zoom(page, 850);
const toScreen = await calibrate(page);
const log = [];

async function place(item, x, z, rots, needSnap) {
  await chooseItem(page, item);
  for (const rot of rots) {
    await setRot(page, rot);
    const p = await probe(page, toScreen, x, z);
    if (p.hover !== `${x},${z}`) continue;
    if (needSnap && p.snap === 0) continue;
    await placeAt(page, p.px, p.py);
    const counts = await roadCounts(page);
    log.push({ item, x, z, rot, snappedCells: p.snap, ...counts, checkMs: await checkMs(page) });
    console.log(JSON.stringify(log.at(-1)));
    return;
  }
  throw new Error(`could not place ${item} at ${x},${z}`);
}

for (const x of [-640, 0, 640, 1280]) await place("ldraw:3811", x, 0, [0], false);
await place("ldraw:69958", -160, 0, [0], false);
await place("ldraw:69958", 160, 0, [0], true);
await place("ldraw:71772p01", 400, 0, [1, 3], true);
await place("ldraw:69958", 640, 0, [0], true);
await place("ldraw:71772", 880, 0, [1, 3], true);
await place("ldraw:69958", 1120, 0, [0], true);
await place("ldraw:44336p04", 0, 1280, [1, 3], false);
await place("ldraw:44341p02", 640, 1280, [0, 1, 2, 3], true);
await place("ldraw:44336p04", 640, 640, [0, 2], true);
await place("ldraw:44342p02", 1280, 1280, [0, 1, 2, 3], true);
await select(page);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/plates-joined.png` });
const joined = await roadCounts(page);
console.log("joined", JSON.stringify(joined));
await setCheckbox(page, "Snap road pieces to matching road edges and refuse clicks that would mismatch", false);
await place("ldraw:69958", -480, 20, [0], false);
await place("ldraw:30225b", -640, 1280, [1], false);
await select(page);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/plates-broken.png` });
const state = await editState(page);
async function resetView() {
  await page.mouse.move(800, 560);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(800, 560 + 60, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.mouse.wheel(0, 1300);
  await page.waitForTimeout(800);
  return calibrate(page);
}
await focusPiece(page, toScreen, -480, 20, { orbitDy: -60 });
await page.screenshot({ path: `${out}/plates-closeup-shifted.png` });
await focusPiece(page, await resetView(), -640, 1280, { orbitDx: 471, orbitDy: -40, wheel: -300 });
await page.screenshot({ path: `${out}/plates-closeup-dual-vs-6-stud.png` });
await focusPiece(page, await resetView(), 400, 0, { orbitDy: -60, wheel: 300 });
await page.screenshot({ path: `${out}/plates-closeup-crosswalk-joined.png` });
fs.writeFileSync(`${out}/plates-state.json`, JSON.stringify({ log, world: state.world }, null, 1));
await context.close();
await browser.close();
