import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [baseUrl, outDir, ...sections] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const run = (name) => sections.length === 0 || sections.includes(name);
const url = `${baseUrl}/?state=1&api=webgl2&lod=low`;
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};

async function launch(tag, initScript) {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(`/tmp/s9-fix-${tag}-`), {
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    viewport: { width: 1600, height: 900 },
    acceptDownloads: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  if (initScript) await context.addInitScript(initScript);
  return context;
}

async function open(page) {
  await page.goto(url);
  await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
  await page.waitForFunction(() => document.querySelector(".editor-hud")?.textContent?.includes("First world frame"), null, { timeout: 600000 });
}

const line = (page) => page.locator(".world-name").innerText();
const saved = (page, text) =>
  page.waitForFunction((t) => (document.querySelector(".world-name")?.textContent ?? "").includes(t), text, { timeout: 120000 });

async function placeBaseplate(page, x, z) {
  await page.fill('input[aria-label="Go to x (LDU)"]', String(x));
  await page.fill('input[aria-label="Go to z (LDU)"]', String(z));
  await page.click("text=Go to x, z");
  await page.click('[data-item="ldraw:3811@2"]');
  await page.mouse.move(800, 450);
  await page.waitForFunction((t) => document.querySelector(".editor")?.getAttribute("data-hover") === t, `${x},${z}`, { timeout: 60000 });
  await page.mouse.click(800, 450);
  await page.keyboard.press("Escape");
}

if (run("name")) {
  note("## Long world name");
  const context = await launch("name");
  const page = context.pages()[0];
  await open(page);
  const longName = `Riverside yard ${"x".repeat(200)}`;
  await page.fill('input[aria-label="New world name"]', longName);
  const typed = await page.inputValue('input[aria-label="New world name"]');
  note(`typed ${longName.length} characters; the field holds ${typed.length}`);
  await page.fill('input[aria-label="New world name"]', "   ");
  await page.fill('input[aria-label="New world name"]', `${"y".repeat(199)}  `);
  note(`a 201-character name with trailing spaces: New enabled ${await page.isEnabled('form.world-new button[type="submit"]')}`);
  await page.fill('input[aria-label="New world name"]', "Riverside yard");
  note(`"Riverside yard": New enabled ${await page.isEnabled('form.world-new button[type="submit"]')}; issue line ${await page.locator(".world-name-issue").count()}`);
  await page.click('form.world-new button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "Riverside yard");
  await placeBaseplate(page, 0, 0);
  await saved(page, "Saved · 1 placement");
  note(`created and edited: "${await line(page)}"`);
  await page.reload();
  await open(page);
  note(`after reload: "${await line(page)}"`);
  const forged = await page.evaluate(async () => {
    const editorName = "a".repeat(201);
    return editorName.length;
  });
  note(`(the schema caps names at 200; a ${forged}-character name can't be typed into the field)`);
  fs.writeFileSync(path.join(outDir, "name.log"), `${log.join("\n")}\n`);
  await context.close();
}

if (run("delete")) {
  note("## Delete worlds");
  const context = await launch("delete");
  const page = context.pages()[0];
  page.on("dialog", (dialog) => void dialog.accept());
  await open(page);
  await page.fill('input[aria-label="New world name"]', "Scratch");
  await page.click('form.world-new button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "Scratch");
  await placeBaseplate(page, 0, 0);
  await saved(page, "Saved · 1 placement");
  const rows = async () => page.$$eval(".world-row .world-row-name", (e) => e.map((x) => x.textContent));
  note(`worlds: ${JSON.stringify(await rows())}`);
  await page.locator(".side-panel").screenshot({ path: path.join(outDir, "delete-before.png") });
  const dbs = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());
  note(`databases: ${JSON.stringify(await dbs())}`);
  const other = await page.$eval(".world-row:not(.current)", (e) => e.getAttribute("data-world-row"));
  await page.click(`[data-world-row="${other}"] >> text=Delete`);
  await page.waitForFunction((id) => !document.querySelector(`[data-world-row="${id}"]`), other);
  note(`deleted the other world: ${JSON.stringify(await rows())}; databases ${JSON.stringify(await dbs())}`);
  await page.click(".world-row.current >> text=Delete");
  await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "World 1");
  note(`deleted the open world: now "${await line(page)}"; worlds ${JSON.stringify(await rows())}; databases ${JSON.stringify(await dbs())}`);
  await page.locator(".side-panel").screenshot({ path: path.join(outDir, "delete-after.png") });
  fs.writeFileSync(path.join(outDir, "delete.log"), `${log.join("\n")}\n`);
  await context.close();
}

if (run("tabs")) {
  note("## Two tabs on one world");
  const context = await launch("tabs");
  const tab1 = context.pages()[0];
  await open(tab1);
  await placeBaseplate(tab1, 0, 0);
  await saved(tab1, "Saved · 1 placement");
  const tab2 = await context.newPage();
  await open(tab2);
  note(`tab 1: "${await line(tab1)}" read-only ${await tab1.getAttribute(".editor", "data-read-only")}`);
  note(`tab 2: "${await line(tab2)}"; warning: ${await tab2.locator('[data-read-only="1"]').innerText().catch(() => "none")}`);
  note(`tab 2 catalog buttons enabled: ${await tab2.$$eval("[data-item]", (e) => e.filter((b) => !b.disabled).length)} of ${await tab2.$$eval("[data-item]", (e) => e.length)}`);
  await tab2.locator(".side-panel").screenshot({ path: path.join(outDir, "tabs-read-only.png") });
  await tab2.keyboard.press("Control+z");
  await tab2.waitForTimeout(1500);
  note(`tab 2 pressed Ctrl+Z: HUD placements ${await tab2.$eval("#edit-state", (e) => JSON.parse(e.textContent).world.placements.x.length)}`);
  await tab1.bringToFront();
  await placeBaseplate(tab1, 640, 0);
  await saved(tab1, "Saved · 2 placements");
  note(`tab 1 placed a second baseplate: "${await line(tab1)}"`);
  await tab1.close();
  await tab2.waitForFunction(() => !document.querySelector('[data-read-only="1"]'), null, { timeout: 120000 });
  await tab2.waitForFunction(() => (document.querySelector(".world-name")?.textContent ?? "").includes("2 placements"), null, { timeout: 120000 });
  note(`tab 1 closed; tab 2 reopened the world: "${await line(tab2)}"; catalog enabled ${await tab2.$$eval("[data-item]", (e) => e.filter((b) => !b.disabled).length)}`);
  await tab2.bringToFront();
  await placeBaseplate(tab2, -640, 0);
  await saved(tab2, "Saved · 3 placements");
  note(`tab 2 edits and saves: "${await line(tab2)}"`);
  fs.writeFileSync(path.join(outDir, "tabs.log"), `${log.join("\n")}\n`);
  await context.close();
}

if (run("nostorage")) {
  note("## Storage blocked");
  const context = await launch("nostorage", () => {
    IDBFactory.prototype.open = function () {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
  });
  const page = context.pages()[0];
  await open(page);
  note(`panel: ${(await page.locator(".world-menu").innerText()).replace(/\n/g, " | ")}`);
  await placeBaseplate(page, 0, 0);
  await page.waitForTimeout(1500);
  note(`placed a baseplate: HUD placements ${await page.$eval("#edit-state", (e) => JSON.parse(e.textContent).world.placements.x.length)}; "${await line(page)}"`);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 300000 }), page.click("text=Export .brr.zip")]);
  const file = path.join(outDir, "nostorage-export.brr.zip");
  await download.saveAs(file);
  note(`exported from memory: ${fs.statSync(file).size} bytes`);
  await page.locator(".side-panel").screenshot({ path: path.join(outDir, "nostorage-panel.png") });
  fs.writeFileSync(path.join(outDir, "nostorage.log"), `${log.join("\n")}\n`);
  await context.close();
}

if (run("forcedname")) {
  note("## A name the schema rejects, forced past the field's maxlength");
  const context = await launch("forcedname");
  const page = context.pages()[0];
  await open(page);
  await page.$eval('input[aria-label="New world name"]', (input) => input.removeAttribute("maxlength"));
  await page.fill('input[aria-label="New world name"]', `Riverside yard ${"x".repeat(200)}`);
  note(`field holds ${(await page.inputValue('input[aria-label="New world name"]')).length} characters; New enabled ${await page.isEnabled('form.world-new button[type="submit"]')}; message: ${await page.locator(".world-name-issue").innerText()}`);
  await page.press('input[aria-label="New world name"]', "Enter");
  await page.waitForTimeout(1500);
  note(`after Enter: "${await line(page)}"; worlds ${JSON.stringify(await page.$$eval(".world-row .world-row-name", (e) => e.map((x) => x.textContent)))}`);
  await page.locator(".world-menu").screenshot({ path: path.join(outDir, "forced-name-refused.png") });
  fs.writeFileSync(path.join(outDir, "forcedname.log"), `${log.join("\n")}\n`);
  await context.close();
}

if (run("retry")) {
  note("## A failed save, refused switch, Retry, then the switch");
  const context = await launch("retry", () => {
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = realPut.apply(this, args);
      if (window.__failShardPuts && this.name === "shards") {
        const transaction = this.transaction;
        queueMicrotask(() => transaction.abort());
      }
      return request;
    };
  });
  const page = context.pages()[0];
  await open(page);
  await placeBaseplate(page, 0, 0);
  await saved(page, "Saved · 1 placement");
  await page.evaluate(() => (window.__failShardPuts = true));
  await placeBaseplate(page, 640, 0);
  await page.waitForSelector('.world-name[data-save="failed"]', { timeout: 120000 });
  note(`save fails: "${await line(page)}"`);
  await page.fill('input[aria-label="New world name"]', "Other");
  await page.click('form.world-new button[type="submit"]');
  await page.waitForTimeout(2000);
  note(`New "Other": "${await line(page)}"; error: ${await page.locator(".world-menu .error").innerText()}`);
  await page.locator(".side-panel").screenshot({ path: path.join(outDir, "retry-refused.png") });
  let unloadPrompt = "none";
  page.once("dialog", (dialog) => {
    unloadPrompt = dialog.type();
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  note(`closing the tab with unsaved edits: dialog ${unloadPrompt}; tab still open ${!page.isClosed()}`);
  await page.evaluate(() => (window.__failShardPuts = false));
  await page.click(".world-retry");
  await saved(page, "Saved · 2 placements");
  note(`Retry: "${await line(page)}"; error line ${await page.locator(".world-menu .error").count()}`);
  await page.click('form.world-new button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "Other");
  note(`New "Other" now: "${await line(page)}"`);
  await page.click('.world-row:has-text("World 1") >> text=Open');
  await saved(page, "2 placements");
  note(`reopened World 1: "${await line(page)}"`);
  fs.writeFileSync(path.join(outDir, "retry.log"), `${log.join("\n")}\n`);
  await context.close();
}

if (run("memoryimport")) {
  note("## Storage blocked: Import asks before replacing the world");
  const context = await launch("memoryimport", () => {
    IDBFactory.prototype.open = function () {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
  });
  const page = context.pages()[0];
  await open(page);
  await placeBaseplate(page, 0, 0);
  const prompts = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.message());
    void dialog.dismiss();
  });
  await page.setInputFiles("input.world-import", process.env.IMPORT_ARCHIVE);
  await page.waitForTimeout(2000);
  note(`import with a placed baseplate: prompt "${prompts[0] ?? "none"}"; dismissed → placements ${await page.$eval("#edit-state", (e) => JSON.parse(e.textContent).world.placements.x.length)}, "${await line(page)}"`);
  fs.writeFileSync(path.join(outDir, "memoryimport.log"), `${log.join("\n")}\n`);
  await context.close();
}
