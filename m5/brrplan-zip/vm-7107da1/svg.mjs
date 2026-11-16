import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { openEditor, place, reports } from "./lib.mjs";
import { newPlan, addTable, viewPlan, setProfile } from "./ui.mjs";
const OUT = process.argv[2];
const MODE = process.argv[3];
const { browser, page, logs } = await openEditor({ width: 1920, height: 1440 });
const at = (c) => c * 640 + 320;
await newPlan(page, 5600, 3000);
await addTable(page, { x: 1536, z: 256, width: 2400, depth: 1200 });
await viewPlan(page);
await setProfile(page, "lego-modular");
await place(page, "ldraw:3811", at(6), at(1));
await place(page, "ldraw:3811", at(7), at(1));
await place(page, "ldraw:44336p04", at(8), at(1));
await place(page, "ldraw:44336p04", at(8), at(2));
await place(page, "omr:10185-1", at(10), at(2));
await place(page, "omr:10218-1", at(10), at(3));
await place(page, "omr:10133-1", 4800, 2860);
const [r] = await reports(page);
console.log("verdict", r.verdict, "errors", r.errors, "parts", r.bom.totalParts, "issues", r.issues.map((i) => i.rule).join(","));
await page.screenshot({ path: `${OUT}/app-plan.png` });
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function download(selector) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(selector).click()]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  return path;
}
if (MODE === "svg") {
  const svgPath = await download('[data-download="plan.svg"]');
  const svg = readFileSync(svgPath, "utf8");
  console.log("svg", svgPath, svg.length, "bytes, sha256", sha(svg));
  console.log("svg header:", svg.split("\n")[1].slice(0, 160));
  for (const needle of [/drawn at 1:\d+/u, /<rect x="1536" y="256" width="2400" height="1200"[^>]*>/u, />2400 mm</u, />1200 mm</u]) {
    console.log("  found:", svg.match(needle)?.[0]);
  }
  console.log("  module numbers:", [...svg.matchAll(/>M(\d+)</gu)].map((m) => m[1]).join(" "));
  console.log("  sheets:", [...svg.matchAll(/sheet (\d+) of (\d+)/gu)].map((m) => `${m[1]}/${m[2]}`).join(" "));
  const viewer = await browser.newPage({ viewport: { width: 1587, height: 1123 } });
  await viewer.goto(`file://${svgPath}`);
  await viewer.screenshot({ path: `${OUT}/svg-page-1.png`, clip: { x: 0, y: 0, width: 1587, height: 1123 } });
  await viewer.screenshot({ path: `${OUT}/svg-page-2.png`, clip: { x: 0, y: 1123, width: 1587, height: 1123 } });
  await viewer.close();
}
if (MODE === "brrplan") {
  const first = await download('[data-download="brrplan.zip"]');
  const firstBytes = readFileSync(first);
  console.log("saved", first, firstBytes.length, "bytes, sha256", sha(firstBytes));
  const before = JSON.parse(await page.locator("#edit-state").innerText()).world.placements;
  const planBefore = JSON.parse(await page.locator("#plan-state").innerText()).plans[0];
  writeFileSync(`${OUT}/world-before.json`, JSON.stringify({ placements: before, plan: planBefore, report: r }, null, 1));
  await page.reload();
  await page.waitForSelector('.editor[data-status="ready"]', { timeout: 180000 });
  console.log("after reload: placements", await page.locator("#edit-state").getAttribute("data-placements"), "plans", JSON.parse(await page.locator("#plan-state").innerText()).plans.length);
  await page.locator('[data-action="open-plan"]').setInputFiles(first);
  await page.waitForTimeout(3000);
  const [r2] = await reports(page);
  console.log("reopened verdict", r2.verdict, "errors", r2.errors, "parts", r2.bom.totalParts, "message", await page.locator(".plan-archive").getAttribute("data-message"));
  const after = JSON.parse(await page.locator("#edit-state").innerText()).world.placements;
  const planAfter = JSON.parse(await page.locator("#plan-state").innerText()).plans[0];
  writeFileSync(`${OUT}/world-after.json`, JSON.stringify({ placements: after, plan: planAfter, report: r2 }, null, 1));
  console.log("placements identical:", JSON.stringify(before) === JSON.stringify(after));
  const strip = (p) => ({ ...p, id: "", footprint: { ...p.footprint, tables: p.footprint.tables.map((t) => ({ ...t, id: "" })), obstacles: p.footprint.obstacles.map((o) => ({ ...o, id: "" })) } });
  console.log("plan footprint identical (ignoring generated ids):", JSON.stringify(strip(planBefore)) === JSON.stringify(strip(planAfter)));
  console.log("report identical:", JSON.stringify({ ...r, regionId: "" }) === JSON.stringify({ ...r2, regionId: "" }));
  await page.screenshot({ path: `${OUT}/reopened.png` });
  const second = await download('[data-download="brrplan.zip"]');
  const secondBytes = readFileSync(second);
  console.log("saved again", secondBytes.length, "bytes, sha256", sha(secondBytes), "identical:", Buffer.compare(firstBytes, secondBytes) === 0);
}
console.log(logs.filter((l) => !l.includes("GPU stall")).join("\n"));
await browser.close();
