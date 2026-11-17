import { writeFileSync } from "node:fs";
import { openEditor, placeAt, choose, aim, state, hud, settle, orbit, wheel, pan } from "./drive.mjs";

const base = process.env.BASE ?? "http://127.0.0.1:5173";
const out = process.env.OUT ?? "/tmp/pw/fp-after";
const set = process.env.SET ?? "2150-1";
const api = process.env.API ?? "webgl2";
const { browser, page } = await openEditor({ base, api });
await placeAt(page, "ldraw:3811", 0, 0);
await orbit(page, Number(process.env.YAW ?? 0), Number(process.env.PITCH ?? -105));
await wheel(page, Number(process.env.ZOOM ?? -100), Number(process.env.ZOOMS ?? 7));
await settle(page, 1500);
await choose(page, `omr:${set}`);
const { px, py } = await aim(page, 0, 0);
await settle(page, 4000);
await page.locator("canvas.scene").screenshot({ path: `${out}-ghost.png` });
const ghostHud = await hud(page);
await page.mouse.click(px, py);
await page.waitForFunction(
  () => Number(document.querySelector("#edit-state")?.getAttribute("data-placements")) === 2,
);
await page.keyboard.press("Escape");
await page.mouse.move(5, 5);
await settle(page, 4000);
await page.locator("canvas.scene").screenshot({ path: `${out}-placed.png` });
const placedHud = await hud(page);
const s = await state(page);
writeFileSync(
  `${out}.json`,
  JSON.stringify({ base, api, set, ghostHud, placedHud, world: s.world }, null, 2),
);
console.log(placedHud);
await browser.close();
