import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

const VIEWPORT = { width: 1920, height: 1080 } as const;
const LOAD_TIMEOUT_MS = 600_000;
const DEFAULT_CHROME = "/usr/local/bin/google-chrome";
const DOWNLOAD_BUTTONS = ["Rebrickable CSV", "BrickLink XML", "Plain CSV"] as const;
const REGION_HALF_WIDTH_LDU = 10;
const EDITOR_SETS = ["10264-1", "7936-1"] as const;
const EDITOR_CLICKS = [
  [0.35, 0.55],
  [0.6, 0.55],
] as const;

interface Placement {
  readonly module: number;
  readonly x: number;
  readonly z: number;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "http://localhost:4173/" },
    out: { type: "string", default: "parts-lists" },
    api: { type: "string", default: "webgl2" },
    stage: { type: "string", default: "all" },
  },
});

async function open(browser: Browser, query: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") process.stderr.write(`[page] ${message.text()}\n`);
  });
  await page.goto(new URL(`?${query}&api=${values.api}`, values.base).href);
  await page.waitForSelector(".bom", { timeout: LOAD_TIMEOUT_MS });
  return page;
}

async function buildAndDownload(page: Page, directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const previous = await page
    .locator(".bom dl")
    .textContent({ timeout: 100 })
    .catch(() => null);
  await page.getByRole("button", { name: "Build parts list" }).click();
  await page.waitForFunction(
    (before) => {
      const text = document.querySelector(".bom dl")?.textContent ?? null;
      return text !== null && text !== before;
    },
    previous,
    { timeout: LOAD_TIMEOUT_MS },
  );
  for (const label of DOWNLOAD_BUTTONS) {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: label }).click(),
    ]);
    await download.saveAs(join(directory, download.suggestedFilename()));
  }
  return (await page.locator(".bom").innerText()).trim();
}

async function setRegion(page: Page, placement: Placement): Promise<void> {
  await page.locator('input[name="bom-scope"][value="region"]').check();
  const bounds = {
    minX: placement.x - REGION_HALF_WIDTH_LDU,
    minZ: placement.z - REGION_HALF_WIDTH_LDU,
    maxX: placement.x + REGION_HALF_WIDTH_LDU,
    maxZ: placement.z + REGION_HALF_WIDTH_LDU,
  };
  for (const [field, value] of Object.entries(bounds)) {
    await page.locator(`.bom-region input[name="${field}"]`).fill(String(value));
  }
}

async function placeInEditor(page: Page): Promise<string> {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the editor canvas has no layout box");
  for (const [index, set] of EDITOR_SETS.entries()) {
    const [fx, fy] = EDITOR_CLICKS[index] ?? [0.5, 0.5];
    await page.locator(`[data-item="omr:${set}"]`).click();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForSelector(`#edit-state[data-placements="${index + 1}"]`, {
      timeout: LOAD_TIMEOUT_MS,
      state: "attached",
    });
  }
  await page.keyboard.press("Escape");
  const [fx, fy] = EDITOR_CLICKS[0];
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForSelector(".editor:not([data-selection=''])", {
    timeout: LOAD_TIMEOUT_MS,
    state: "attached",
  });
  return (await page.locator(".editor").getAttribute("data-selection")) ?? "";
}

async function importAll(page: Page, files: ReadonlyArray<string>): Promise<Placement[]> {
  for (const [index, file] of files.entries()) {
    await page.setInputFiles(".import-panel input[type=file]", file);
    await page.waitForFunction(
      (count) =>
        document.querySelector(`#import-result[data-modules="${count}"]`) !== null ||
        document.querySelector(".import-panel .error") !== null,
      index + 1,
      { timeout: LOAD_TIMEOUT_MS, polling: 250 },
    );
    const error = await page
      .locator(".import-panel .error")
      .textContent({ timeout: 100 })
      .catch(() => null);
    if (error) throw new Error(`${basename(file)}: ${error}`);
    process.stdout.write(`imported ${basename(file)}\n`);
  }
  const result: unknown = JSON.parse((await page.locator("#import-result").textContent()) ?? "");
  return (result as { placements: Placement[] }).placements;
}

const out = values.out;
const panels: Record<string, string> = {};
const browser = await chromium.launch({
  executablePath: process.env["CHROME"] ?? DEFAULT_CHROME,
  headless: false,
  args: ["--enable-unsafe-webgpu"],
});
try {
  for (const file of values.stage === "all" || values.stage === "models" ? positionals : []) {
    const set = basename(file).replace(/\.[^.]+$/u, "");
    const page = await open(browser, `model=${encodeURIComponent(set)}`);
    panels[`model/${set}`] = await buildAndDownload(page, join(out, "model"));
    await page.screenshot({ path: join(out, `model-${set}.png`) });
    process.stdout.write(`model ${set}: exported\n`);
    await page.context().close();
  }
  if (values.stage === "all" || values.stage === "editor") {
    const page = await open(browser, "state=1");
    const selected = await placeInEditor(page);
    panels["editor/world"] = await buildAndDownload(page, join(out, "editor"));
    await page.locator('input[name="bom-scope"][value="selection"]').check();
    panels[`editor/selection-${selected}`] = await buildAndDownload(page, join(out, "editor"));
    await page.screenshot({ path: join(out, "editor-selection.png") });
    writeFileSync(
      join(out, "editor-state.json"),
      `${(await page.locator("#edit-state").textContent()) ?? ""}\n`,
    );
    process.stdout.write(`editor: world and selection (${selected}) exported\n`);
    await page.context().close();
  }
  if (values.stage === "all" || values.stage === "import") {
    const page = await open(browser, "scene=import");
    const placements = await importAll(page, positionals);
    panels["import/world"] = await buildAndDownload(page, join(out, "import"));
    await page.screenshot({ path: join(out, "import-world.png") });
    for (const placement of placements) {
      const set = basename(positionals[placement.module] ?? "").replace(/\.[^.]+$/u, "");
      await setRegion(page, placement);
      panels[`import/region-${set}`] = await buildAndDownload(page, join(out, "import"));
      await page.screenshot({ path: join(out, `import-region-${set}.png`) });
      process.stdout.write(`import region around ${set}: exported\n`);
    }
    writeFileSync(join(out, "placements.json"), `${JSON.stringify(placements, null, 2)}\n`);
    await page.context().close();
  }
} finally {
  writeFileSync(join(out, `panels-${values.stage}.json`), `${JSON.stringify(panels, null, 2)}\n`);
  await browser.close();
}
