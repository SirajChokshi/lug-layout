import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const base = process.env.BASE_URL ?? "http://localhost:4173/";
const out = process.env.OUT_DIR ?? "out";
const lods = ["standard", "low", "far"];
await mkdir(out, { recursive: true });

async function getJson(path) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

async function glbExtras(path) {
  const response = await fetch(new URL(path, base));
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  return json.extras ?? json.asset?.extras ?? json.scenes?.[0]?.extras;
}

const manifests = {};
for (const lod of lods) manifests[lod] = await getJson(`bundle/${lod}/manifest.json`);

const manifestPartPaths = new Set();
const manifestCreditPaths = new Set();
const glbSourcePaths = new Set();
let glbFiles = 0;
const omrModels = new Set();
for (const lod of lods) {
  const m = manifests[lod];
  for (const p of [...m.parts, ...m.studPrimitives]) manifestPartPaths.add(p.path);
  for (const c of m.credits) manifestCreditPaths.add(c.path);
  for (const model of m.models) if (model.origin === "omr") omrModels.add(model.name);
  for (const p of [...m.parts, ...m.studPrimitives]) {
    const extras = await glbExtras(`bundle/${lod}/${p.file}`);
    glbFiles++;
    for (const s of extras.sources) glbSourcePaths.add(s.path);
  }
}

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = await context.newPage();

await page.goto(new URL("?page=credits", base).href);
await page.waitForSelector("#credit-counts");
await page.screenshot({ path: `${out}/credits-top.png` });

const live = await page.evaluate(() => {
  const counts = document.querySelector("#credit-counts").dataset;
  const files = [...document.querySelectorAll("[data-credit-file]")].map((e) => e.dataset.creditFile);
  const sets = [...document.querySelectorAll("[data-credit-set]")].map((row) => ({
    set: row.dataset.creditSet,
    cells: [...row.querySelectorAll("td")].map((td) => td.textContent),
  }));
  const groups = [...document.querySelectorAll("[data-license]")].map((g) => ({
    license: g.dataset.license,
    files: g.querySelectorAll("[data-credit-file]").length,
    authors: g.querySelectorAll("[data-credit-author]").length,
  }));
  return {
    counts: { ...counts },
    files,
    sets,
    groups,
    footer: document.querySelector("footer.site-footer")?.textContent ?? null,
    modifiedNotes: [...document.querySelectorAll(".modified li")].map((li) => li.textContent),
    dataSources: [...document.querySelectorAll(".data-sources li")].map((li) => li.textContent),
  };
});

await page.locator(".license-group details").first().evaluate((d) => (d.open = true));
await page.locator(".license-group details summary").first().evaluate((s) => s.scrollIntoView());
await page.screenshot({ path: `${out}/credits-ldraw-files.png` });
await page.locator(".license-group details").first().evaluate((d) => (d.open = false));
await page.locator("table.sets").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/credits-omr-sets.png` });
await page.locator(".data-sources").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/credits-data-sources.png` });

const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: /Download CREDITS\.txt/ }).click(),
]);
const creditsTxtPath = `${out}/CREDITS.txt`;
await download.saveAs(creditsTxtPath);
const creditsTxt = await readFile(creditsTxtPath, "utf8");

await page.goto(new URL("?page=about", base).href);
await page.waitForSelector(".facts");
await page.screenshot({ path: `${out}/about.png` });
const aboutFooter = await page.locator("footer.site-footer").textContent();

await page.goto(new URL("?model=10264-1&api=webgl2", base).href);
await page.waitForSelector(".hud dl", { timeout: 120000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/viewer-footer-links.png` });
await page.getByRole("link", { name: "Credits" }).click();
await page.waitForSelector("#credit-counts");
const navigatedTo = page.url();
await browser.close();

const liveFiles = new Set(live.files);
const disclaimer = manifests.standard.disclaimer;
const missingFromTxt = [...liveFiles].filter((path) => !creditsTxt.includes(`    ${path}: `));
const glbPlusConfig = new Set([...glbSourcePaths, "LDConfig.ldr"]);
const diff = (a, b) => [...a].filter((x) => !b.has(x));
const result = {
  base,
  bundleVersions: Object.fromEntries(lods.map((lod) => [lod, manifests[lod].bundleVersion])),
  livePage: {
    countsTable: live.counts,
    creditedFileRows: live.files.length,
    distinctCreditedFileRows: liveFiles.size,
    licenseGroups: live.groups,
    omrSetRows: live.sets.length,
    sets: live.sets,
    footer: live.footer,
    modifiedNotes: live.modifiedNotes,
    dataSources: live.dataSources,
  },
  manifests: {
    distinctPartFilePaths: manifestPartPaths.size,
    partFilePathsCreditedOnPage: [...manifestPartPaths].filter((p) => liveFiles.has(p)).length,
    distinctCreditPaths: manifestCreditPaths.size,
    omrModels: omrModels.size,
    omrModelsWithAPageRow: [...omrModels].filter((m) => live.sets.some((s) => s.set === m)).length,
  },
  glbExtras: {
    glbFilesRead: glbFiles,
    distinctSourcePaths: glbSourcePaths.size,
    plusLdconfig: glbPlusConfig.size,
    onPageNotInGlbSourcesOrLdconfig: diff(liveFiles, glbPlusConfig),
    inGlbSourcesNotOnPage: diff(glbPlusConfig, liveFiles),
  },
  creditsTxt: {
    bytes: Buffer.byteLength(creditsTxt),
    sha256: createHash("sha256").update(creditsTxt).digest("hex"),
    disclaimerOccurrences: creditsTxt.split(disclaimer).length - 1,
    pageFilesMissingFromTxt: missingFromTxt.length,
    setLinesPresent: live.sets.filter((s) => creditsTxt.includes(s.cells[0])).length,
  },
  manifestDisclaimer: Object.fromEntries(lods.map((lod) => [lod, manifests[lod].disclaimer])),
  aboutFooter,
  viewerCreditsLinkNavigatedTo: navigatedTo,
};
await writeFile(`${out}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, livePage: { ...result.livePage, sets: undefined } }, null, 2));
