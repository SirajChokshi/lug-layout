import { openEditor, placeWith, calibrate, state } from "./drive.mjs";
const { browser, page, logs } = await openEditor({ base: process.env.BASE ?? "http://127.0.0.1:5173" });
const map = await calibrate(page);
await placeWith(page, map, "ldraw:3811", 0, 0);
await placeWith(page, map, `omr:${process.env.SET ?? "10264-1"}`, 0, 0);
await page.waitForTimeout(1500);
console.log(JSON.stringify((await state(page)).world.studs));
console.log(logs.filter((l) => l.includes("error")).slice(0, 5).join("\n"));
await browser.close();
