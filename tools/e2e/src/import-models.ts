import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

const VIEWPORT = { width: 1920, height: 1080 } as const;
const IMPORT_TIMEOUT_MS = 600_000;
const SETTLE_MS = 1_500;
const DEFAULT_CHROME = "/usr/local/bin/google-chrome";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "http://localhost:5173/" },
    out: { type: "string", default: "e2e-out" },
    api: { type: "string", default: "webgl2" },
    mode: { type: "string", default: "each" },
    video: { type: "boolean", default: false },
  },
});

const out = values.out;
mkdirSync(out, { recursive: true });

async function openImporter(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    ...(values.video ? { recordVideo: { dir: join(out, `video-${name}`), size: VIEWPORT } } : {}),
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") process.stderr.write(`[page] ${message.text()}\n`);
  });
  await page.goto(new URL(`?scene=import&api=${values.api}`, values.base).href);
  await page.waitForSelector(".hud dl", { timeout: IMPORT_TIMEOUT_MS });
  return page;
}

async function importFile(
  page: Page,
  file: string,
  expectedModules: number,
): Promise<string | null> {
  await page.setInputFiles(".import-panel input[type=file]", file);
  await page.waitForFunction(
    (count) =>
      document.querySelector(`#import-result[data-modules="${count}"]`) !== null ||
      document.querySelector(".import-panel .error") !== null,
    expectedModules,
    { timeout: IMPORT_TIMEOUT_MS, polling: 250 },
  );
  const error = await page
    .locator(".import-panel .error")
    .textContent({ timeout: 100 })
    .catch(() => null);
  return error;
}

async function captureRejection(page: Page, name: string, error: string): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: join(out, `${name}.png`) });
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ error }, null, 2));
  process.stdout.write(`${name}: rejected\n`);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: join(out, `${name}.png`) });
  const overlays = await page.addStyleTag({
    content: ".hud, .import-panel, footer { visibility: hidden !important; }",
  });
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: join(out, `${name}-scene.png`) });
  await overlays.evaluate((style) => style.parentNode?.removeChild(style));
  const result = await page.locator("#import-result").textContent();
  const hud = await page.locator(".hud").innerText();
  writeFileSync(
    join(out, `${name}.json`),
    JSON.stringify({ hud, result: JSON.parse(result ?? "null") }, null, 2),
  );
  process.stdout.write(`${name}: captured\n`);
}

const browser = await chromium.launch({
  executablePath: process.env["CHROME"] ?? DEFAULT_CHROME,
  headless: false,
  args: ["--enable-unsafe-webgpu"],
});
try {
  if (values.mode === "world") {
    const page = await openImporter(browser, "world");
    for (const [index, file] of positionals.entries()) {
      const error = await importFile(page, file, index + 1);
      if (error) throw new Error(error);
      process.stdout.write(`imported ${basename(file)}\n`);
    }
    await capture(page, "world");
    await page.context().close();
  } else {
    for (const file of positionals) {
      const name = basename(file).replace(/\.[^.]+$/u, "");
      const page = await openImporter(browser, name);
      const error = await importFile(page, file, 1);
      if (error) await captureRejection(page, name, error);
      else await capture(page, name);
      await page.context().close();
    }
  }
} finally {
  await browser.close();
}
