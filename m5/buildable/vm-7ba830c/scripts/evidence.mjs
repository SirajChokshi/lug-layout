import { writeFileSync } from "node:fs";
import { openEditor, place, reports, findScreen } from "./lib.mjs";
import { newPlan, addTable, viewPlan, setProfile, fill, planState } from "./ui.mjs";

const OUT = "/opt/cursor/artifacts/m5-buildable";
const { browser, page, logs } = await openEditor({ width: 1920, height: 1440 });
const record = {};
const M = 640;
const at = (c) => c * M + 320;

async function step(name) {
  const [r] = await reports(page);
  record[name] = r;
  console.log(`== ${name}: ${r.verdict} errors=${r.errors} parts=${r.bom.totalParts} lines=${r.bom.lines.length}`);
  for (const i of r.issues) console.log(`   [${i.rule}] ${i.message.slice(0, 300)}`);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function openParts() {
  await page.locator(".buildable-bom summary").click();
  await page.waitForTimeout(100);
}

async function selectAndDo(x, z, key) {
  await page.locator('.toolbar button').first().click();
  const { px, py } = await findScreen(page, x, z);
  await page.mouse.click(px, py);
  await page.waitForTimeout(200);
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
}

const plan = await newPlan(page, 5600, 3000);
const tableId = await addTable(page, { x: 1536, z: 256, width: 2400, depth: 1200 });
await viewPlan(page);
await setProfile(page, "lego-modular");

await place(page, "ldraw:3811", at(6), at(1));
await place(page, "ldraw:3811", at(7), at(1));
await place(page, "ldraw:44336p04", at(8), at(1));
await place(page, "ldraw:44336p04", at(8), at(2));
await openParts();
await step("01-buildable-baseplates-and-roads");

await place(page, "ldraw:44336p04", at(8), at(3), 1);
await step("02-road-turned-across");
await selectAndDo(at(8), at(3), "Delete");

await place(page, "ldraw:3811", at(10) + 200, at(1));
await step("03-baseplate-off-module-grid");
await selectAndDo(at(10) + 200, at(1), "Delete");

await place(page, "omr:10185-1", at(11), at(2));
await place(page, "omr:10218-1", at(11), at(3));
await place(page, "omr:10264-1", at(11) + 160, at(4));
await step("04-modular-buildings-joined");
await selectAndDo(at(11) + 160, at(4), "r");
await step("05-modular-building-turned");
await selectAndDo(at(11) + 160, at(4), "r");
await selectAndDo(at(11) + 160, at(4), "r");
await selectAndDo(at(11) + 160, at(4), "r");

await setProfile(page, "mils");
await step("06-mils-profile");

await setProfile(page, "free");
await fill(page, `${tableId}-z`, 0);
await page.waitForTimeout(200);
await step("07-table-against-wall-reach");
await fill(page, `${tableId}-z`, 256);
await addTable(page, { x: 3936, z: 256, width: 1200, depth: 1200 });
await place(page, "ldraw:3811", 9840, at(3));
await step("08-seam");

writeFileSync(`${OUT}/reports.json`, JSON.stringify({ plan: await planState(page), record }, null, 1));
console.log(logs.filter((l) => !l.includes("GPU stall")).join("\n"));
await browser.close();
