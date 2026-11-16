import { readFileSync, writeFileSync } from "node:fs";
import { openEditor, place, reports } from "./lib.mjs";
import { newPlan, addTable, viewPlan } from "./ui.mjs";
const OUT = "/opt/cursor/artifacts/m5-own-buy";
const { browser, page, logs } = await openEditor({ width: 1920, height: 1440 });
const at = (c) => c * 640 + 320;
await newPlan(page, 5600, 3000);
await addTable(page, { x: 1536, z: 256, width: 2400, depth: 1200 });
await viewPlan(page);
await place(page, "omr:10133-1", 6840, 2140);
await place(page, "ldraw:3811", at(6), at(1));
await place(page, "ldraw:3811", at(7), at(1));
await page.locator(".buildable-bom summary").click();
const [before] = await reports(page);
console.log("verdict", before.verdict, "parts", before.bom.totalParts, "lines", before.bom.lines.length);
await page.screenshot({ path: `${OUT}/01-plan-before-import.png` });

async function download(suffix) {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(`[data-download="${suffix}"]`).click(),
  ]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  return path;
}
const wholeCsv = await download("rebrickable.csv");
const wholeXml = await download("bricklink.xml");
console.log("whole plan files", wholeCsv, wholeXml);

const rows = readFileSync(wholeCsv, "utf8").trim().split(/\r?\n/u);
const [header, ...lines] = rows;
const kept = lines.filter((line) => !line.startsWith("3811,"));
const reduceAt = kept.findIndex((line) => Number(line.split(",")[2]) >= 2);
const owned = kept.map((line, i) => {
  if (i !== reduceAt) return line;
  const [part, color, qty] = line.split(",");
  console.log(`owned file: ${part} colour ${color} reduced from ${qty} to ${Number(qty) - 1}`);
  return `${part},${color},${Number(qty) - 1}`;
});
const ownedPath = `${OUT}/owned-from-plan-minus-3811-and-one-part.csv`;
writeFileSync(ownedPath, [header, ...owned].join("\r\n") + "\r\n");
await page.locator('[data-action="import-collection"]').setInputFiles(ownedPath);
await page.waitForTimeout(500);
const summary = await page.locator(".own-vs-buy").evaluate((el) => ({
  collection: el.dataset.collectionParts,
  own: el.dataset.own,
  buy: el.dataset.buy,
  text: el.querySelector(".own-summary")?.textContent,
}));
console.log("own vs buy", JSON.stringify(summary));
await page.screenshot({ path: `${OUT}/02-after-import.png` });
const shortCsv = await download("rebrickable.csv");
const shortXml = await download("bricklink.xml");
const shortPlain = await download("parts.csv");
console.log("shortfall rebrickable csv:\n" + readFileSync(shortCsv, "utf8"));
console.log("shortfall wanted list:\n" + readFileSync(shortXml, "utf8"));
const plain = readFileSync(shortPlain, "utf8").split(/\r?\n/u).filter((l) => !/,0,(?:[^,]*,){3}[^,]*$/u.test(l) || l.startsWith("LDraw"));
console.log("plain csv rows with buy > 0:\n" + readFileSync(shortPlain, "utf8").split(/\r?\n/u).filter((l, i) => i === 0 || (l && Number(l.split(",")[4]) > 0)).join("\n"));
console.log(logs.filter((l) => !l.includes("GPU stall")).join("\n"));
await browser.close();
