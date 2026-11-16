import {
  calibrate, checkMs, chooseItem, closeUp, editState, openEditor, placeAt, probe, roadCounts, select, setCheckbox, setRot, zoom,
} from "./editor-driver.mjs";

const [out = "/tmp/m2"] = process.argv.slice(2);
const { browser, context, page } = await openEditor({
  url: "http://localhost:5173/?api=webgl2&state=1",
  video: process.env.VIDEO ? `${out}/video` : undefined,
});
await zoom(page, 450);
const toScreen = await calibrate(page);
const ring = [
  ["generated:mils-road-t-junction", 640, 0, 0],
  ["generated:mils-road-curve", 0, 0, 2],
  ["generated:mils-road-curve", 0, 640, 3],
  ["generated:mils-road-crosswalk", 640, 640, 0],
  ["generated:mils-road-curve", 1280, 640, 0],
  ["generated:mils-road-curve", 1280, 0, 1],
  ["generated:mils-road-straight", 640, -640, 1],
];
const log = [];
for (const [index, [item, x, z, rot]] of ring.entries()) {
  await chooseItem(page, item);
  await setRot(page, rot);
  const p = await probe(page, toScreen, x, z);
  if (p.hover !== `${x},${z}` || (index > 0 && p.snap === 0)) {
    throw new Error(`${item} at rotation ${rot} does not snap at ${x},${z}: ${JSON.stringify(p)}`);
  }
  await placeAt(page, p.px, p.py);
  const counts = await roadCounts(page);
  log.push({ item, x, z, rot, snappedCells: p.snap, ...counts, checkMs: await checkMs(page) });
  console.log(JSON.stringify(log.at(-1)));
}
await select(page);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/mils-loop-joined.png` });
console.log("before break", JSON.stringify(await roadCounts(page)));
await chooseItem(page, "generated:mils-road-straight");
await setRot(page, 0);
const refusedProbe = await probe(page, toScreen, -640, 0);
const placementsBefore = await page.locator(".editor").getAttribute("data-road-joined");
await placeAt(page, refusedProbe.px, refusedProbe.py);
const refusal = {
  snapState: await page.locator(".editor").getAttribute("data-snap-state"),
  refused: await page.locator(".editor").getAttribute("data-refused"),
  placements: (await editState(page)).world.roadPlacements.length,
  counts: await roadCounts(page),
  joinedBefore: Number(placementsBefore),
};
console.log("refused click", JSON.stringify(refusal));
await page.screenshot({ path: `${out}/mils-refused-click.png` });
await select(page);
await setCheckbox(page, "Snap road pieces to matching road edges and refuse clicks that would mismatch", false);
await chooseItem(page, "generated:mils-road-straight");
for (let rot = 0; rot < 4; rot++) {
  await setRot(page, rot);
  const p = await probe(page, toScreen, -640, 0);
  await placeAt(page, p.px, p.py);
  const counts = await roadCounts(page);
  console.log("break rot", rot, JSON.stringify(counts));
  if (counts.mismatch > 0) break;
  await select(page);
  const q = await probe(page, toScreen, -640, 0);
  await placeAt(page, q.px, q.py);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  await chooseItem(page, "generated:mils-road-straight");
}
await select(page);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/mils-loop-broken.png` });
const state = await editState(page);
await closeUp(page, toScreen, -320, 0, { wheel: -1100, orbitDx: 120, orbitDy: -70 });
await page.screenshot({ path: `${out}/mils-closeup-mismatch.png` });
await page.mouse.move(800, 560);
await page.mouse.down({ button: "right" });
await page.mouse.move(800 - 120, 560 + 70, { steps: 8 });
await page.mouse.up({ button: "right" });
await page.mouse.wheel(0, 1100);
await page.waitForTimeout(800);
const again = await calibrate(page);
await closeUp(page, again, 960, 640, { wheel: -1100, orbitDx: -150, orbitDy: -70 });
await page.screenshot({ path: `${out}/mils-closeup-joined.png` });
const fs = await import("node:fs");
fs.writeFileSync(`${out}/mils-loop-state.json`, JSON.stringify({ log, refusal, world: state.world }, null, 1));
await context.close();
await browser.close();
