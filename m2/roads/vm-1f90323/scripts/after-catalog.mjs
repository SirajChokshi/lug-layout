import { openEditor } from "./editor-driver.mjs";
const { browser, page } = await openEditor({ url: "http://localhost:5173/?api=webgl2" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/m2/after-catalog.png" });
const items = await page.locator("[data-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-item")));
console.log(JSON.stringify(items));
await browser.close();
