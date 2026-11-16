import { writeFileSync } from "node:fs";
import { openEditor, place, reports, findScreen } from "./lib.mjs";
import { newPlan, addTable, viewPlan } from "./ui.mjs";
const OUT = "/opt/cursor/artifacts/m5-buildable";
const SETS = ["7936-1","10264-1","10185-1","10190-1","10218-1","2150-1","4554-1","4555-1","10128-1","10133-1"];
const { browser, page, logs } = await openEditor({ width: 1920, height: 1440 });
await newPlan(page, 5600, 3000);
await addTable(page, { x: 1536, z: 256, width: 2400, depth: 1200 });
await viewPlan(page);
await page.locator(".buildable-bom summary").waitFor({ timeout: 5000 }).catch(() => {});
const out = {};
for (const set of SETS) {
  await place(page, `omr:${set}`, 6840, 2140);
  const [r] = await reports(page);
  out[set] = r;
  console.log(`== ${set}: ${r.verdict} errors=${r.errors} parts=${r.bom.totalParts} lines=${r.bom.lines.length}`);
  for (const i of r.issues) console.log(`   [${i.rule}] ${i.message.slice(0, 400)}`);
  await page.screenshot({ path: `${OUT}/set-${set}.png` });
  await page.locator(".toolbar button").first().click();
  const { px, py } = await findScreen(page, 6840, 2140);
  await page.mouse.click(px, py);
  await page.waitForTimeout(300);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(500);
  writeFileSync(`${OUT}/per-set-reports.json`, JSON.stringify(out, null, 1));
}
console.log(logs.filter((l) => !l.includes("GPU stall")).join("\n"));
await browser.close();
