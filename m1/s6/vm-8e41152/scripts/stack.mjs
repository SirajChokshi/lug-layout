import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor, placeWith, calibrate, choose, aimWith, state, hud, settle, orbit, wheel } from "./drive.mjs";

const base = process.env.BASE ?? "http://127.0.0.1:5173";
const out = process.env.OUT ?? "/tmp/pw/stack-after";
const api = process.env.API ?? "webgl2";
const lower = process.env.LOWER ?? "10185-1";
const upper = process.env.UPPER ?? "10264-1";
mkdirSync(out, { recursive: true });

const { browser, page } = await openEditor({ base, api });
await orbit(page, 0, Number(process.env.PITCH ?? -60));
await wheel(page, 300, Number(process.env.ZOOMS ?? 1));
await settle(page, 1000);
const map = await calibrate(page);
await placeWith(page, map, "ldraw:3811", 0, 0);
await placeWith(page, map, `omr:${lower}`, 0, 0);
await settle(page, 2000);
const beforeStack = await state(page);
const hudBefore = await hud(page);
await choose(page, `omr:${upper}`);
const { px, py } = await aimWith(page, map, 0, 0);
await settle(page, 4000);
const hover = await page.locator(".editor").getAttribute("data-hover");
const hudGhost = await hud(page);
await page.screenshot({ path: `${out}/ghost.png`, timeout: 300000 });
await page.mouse.click(px, py);
await page.waitForFunction(
  () => Number(document.querySelector("#edit-state")?.getAttribute("data-placements")) === 3,
  null,
  { timeout: 300000 },
);
await page.keyboard.press("Escape");
await page.mouse.move(2, 2);
await settle(page, 4000);
await page.screenshot({ path: `${out}/placed.png`, timeout: 300000 });
const after = await state(page);
const hudPlaced = await hud(page);
const rotations = [];
const box = await page.locator("canvas.scene").boundingBox();
for (const [fx, fy] of [[0.49, 0.2], [0.47, 0.25], [0.5, 0.15], [0.45, 0.22]]) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await settle(page, 1500);
  if ((await page.locator(".editor").getAttribute("data-selection")) === `omr:${upper}`) break;
}
if ((await page.locator(".editor").getAttribute("data-selection")) === `omr:${upper}`) {
  for (let turn = 1; turn <= 4; turn++) {
    await page.keyboard.press("r");
    await settle(page, 2500);
    const placements = (await state(page)).world.placements;
    rotations.push({ turn, yPlates: placements.yPlates, rot: placements.rot });
  }
}
console.log("rotations", JSON.stringify(rotations));
writeFileSync(
  `${out}/stack.json`,
  JSON.stringify({ base, api, lower, upper, hover, hudBefore, hudGhost, hudPlaced, worldBeforeStack: beforeStack.world, world: after.world, rotations }, null, 2),
);
console.log(JSON.stringify(after.world.placements));
console.log(hudGhost.match(/Lands at \(plates\) \| [^|]+/)?.[0]);
console.log(hudPlaced.match(/Studs drawn.*?footprints \| [0-9,]+/)?.[0]);
await browser.close();
