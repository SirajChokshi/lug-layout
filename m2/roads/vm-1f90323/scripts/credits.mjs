import fs from "node:fs";
import { chromium } from "playwright-core";
const out = process.argv[2] ?? "/tmp/m2";
const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
await page.goto("http://localhost:5173/?page=credits");
await page.getByRole("heading", { name: "Generated scenes" }).waitFor({ timeout: 300_000 });
await page.getByRole("heading", { name: "Generated scenes" }).scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/credits-generated-scenes.png` });
const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /CREDITS/ }).click()]);
await download.saveAs(`${out}/CREDITS.txt`);
const text = fs.readFileSync(`${out}/CREDITS.txt`, "utf8");
for (const name of ["mils-road-straight", "mils-road-crosswalk", "mils-road-curve", "mils-road-t-junction", "mils-road-crossroads"]) {
  console.log(name, text.split("\n").filter((l) => l.includes(name)).length);
}
for (const id of ["69958", "71772pr0001", "30225 element", "44342pr0002"]) console.log(id, text.includes(id));
await browser.close();
