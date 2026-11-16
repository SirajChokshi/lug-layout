import fs from "node:fs";
import { chromium } from "playwright-core";

const [pageUrl, profile, control] = process.argv.slice(2);
const context = await chromium.launchPersistentContext(profile, {
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  viewport: null,
  args: ["--auto-open-devtools-for-tabs", "--window-position=0,0", "--window-size=1900,1040"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(pageUrl);
const deadline = Date.now() + 30 * 60 * 1000;
while (Date.now() < deadline) {
  const command = fs.existsSync(control) ? fs.readFileSync(control, "utf8").trim() : "";
  if (command === "wipe") {
    fs.writeFileSync(control, "");
    const result = await page.evaluate(async () => {
      const before = (await indexedDB.databases()).map((d) => d.name).sort();
      for (const name of before) {
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error);
        });
      }
      return { before, after: (await indexedDB.databases()).map((d) => d.name) };
    });
    fs.writeFileSync(`${control}.result`, JSON.stringify(result));
  }
  if (command === "quit") break;
  await new Promise((r) => setTimeout(r, 500));
}
await context.close();
