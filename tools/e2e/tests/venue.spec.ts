import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint, type PlanRect } from "./editor-page.ts";

const BOOTH_FILE = "my-ticket-booth.ldr";
const USER_BOOTH = [
  `0 ${BOOTH_FILE}, a user's own model of official parts`,
  `0 Name: ${BOOTH_FILE}`,
  "0 Author: lug-layout e2e",
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
  "1 1 -20 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 1 20 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 14 0 -32 0 1 0 0 0 1 0 0 0 1 3031.dat",
  "",
].join("\n");

const PLAN_CORNER: LatticePoint = { x: 2560, z: 1920 };
const TABLE: readonly [LatticePoint, LatticePoint] = [
  { x: 4160, z: 3840 },
  { x: 8960, z: 5760 },
];
const BOOTH_ON_THE_FRONT_EDGE: LatticePoint = { x: 6560, z: 5440 };

type VenueList = "rooms" | "obstacles" | "aisles";

function mmRect(x: number, z: number, width: number, depth: number): PlanRect {
  return { x, z, width, depth };
}

async function addVenueItem(
  page: Page,
  list: VenueList,
  rect: Partial<PlanRect>,
  choice?: string,
): Promise<void> {
  await page.locator(`[data-action="add-${list}"]`).click();
  const item = page.locator(`[data-venue="${list}"]`).last();
  if (choice !== undefined) await item.locator("select").selectOption(choice);
  for (const [key, value] of Object.entries(rect)) {
    const field = item.locator(`input[name$="-${key}"]`);
    await field.fill(String(value));
    await field.press("Enter");
  }
}

function withoutId<T extends { readonly id: string }>({ id: _id, ...rest }: T) {
  return rest;
}

async function venueOf(editor: EditorPage) {
  const [plan] = await editor.plans();
  const footprint = plan?.footprint;
  return {
    origin: [plan?.originChunkX, plan?.originChunkZ],
    planMm: [footprint?.roomWidthMm, footprint?.roomDepthMm],
    tables: footprint?.tables.map((table) => table.rect),
    rooms: footprint?.rooms.map(withoutId),
    obstacles: footprint?.obstacles.map(withoutId),
    aisles: footprint?.aisles.map(withoutId),
  };
}

async function rowsOf(editor: EditorPage) {
  return (await editor.planRows()).map(({ rule, message }) => ({ rule, message }));
}

async function tablePlanSheet(
  page: Page,
): Promise<{ readonly file: string; readonly svg: string }> {
  const sheets = page.getByRole("region", { name: "Print sheets" });
  await sheets.locator('select[name="sheet-set"]').selectOption({ label: "Table plan" });
  await sheets.locator('select[name="sheet-format"]').selectOption("svg");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    sheets.getByRole("button", { name: "Download sheet" }).click(),
  ]);
  const name = file.suggestedFilename();
  const svg = await readFile(await file.path(), "utf8");
  await writeFile(test.info().outputPath(name), svg);
  return { file: name, svg };
}

function venueOnSheet({ file, svg }: { readonly file: string; readonly svg: string }) {
  const texts = (pattern: RegExp) => [...svg.matchAll(pattern)].map(([, text]) => text);
  return {
    file,
    areas: texts(/<rect class="((?:aisle|obstacle) [a-z]+)"/gu),
    hatches: texts(/<path class="(hatch)"/gu).length,
    aisleLabels: texts(/<text class="label"[^>]*>([^<]* · (?:public|crew))<\/text>/gu),
    legend: texts(
      /<text class="legend"[^>]*>([^<]*(?:aisle|keep clear|Power point)[^<]*)<\/text>/gu,
    ),
  };
}

async function shot(editor: EditorPage, page: Page, name: string): Promise<void> {
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath(name) });
}

test("a venue's room rectangles, pillar, door, power point and public and crew aisles are drawn on the plan and on its printed table plan by kind and side, saved with the plan, and a user's own model is reached from the crew aisles alone", async ({
  page,
}) => {
  const boothFile = test.info().outputPath(BOOTH_FILE);
  await writeFile(boothFile, USER_BOOTH);
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const booth = await editor.importModel(boothFile);
  expect(booth.status, booth.text).toBe("placeable");
  await editor.escape();
  await editor.goTo(PLAN_CORNER);
  await editor.chooseMode("plan");
  await page.locator(".plan-panel > summary").click();
  await page.locator('[data-action="new-plan"]').click();
  await editor.drawTable(...TABLE);
  await editor.placeAt(booth.item, BOOTH_ON_THE_FRONT_EDGE);
  await editor.escape();
  await editor.saved();
  await expect(page.locator(".plan-panel [data-unmeasured]")).toHaveCount(0);
  const beforeVenue = await rowsOf(editor);

  await addVenueItem(page, "rooms", {});
  await addVenueItem(page, "rooms", { width: 1200, depth: 1600, x: 4000 });
  await addVenueItem(page, "obstacles", {});
  await addVenueItem(page, "obstacles", { x: 3600, z: 2900, width: 400, depth: 100 }, "door");
  await addVenueItem(page, "obstacles", { x: 700, z: 800, width: 100, depth: 100 }, "power");
  await addVenueItem(page, "aisles", { x: 640, z: 0, width: 1920, depth: 768 });
  await addVenueItem(page, "aisles", { x: 640, z: 1536, width: 1920, depth: 900 }, "public");
  await editor.saved();
  const publicFront = { venue: await venueOf(editor), rows: await rowsOf(editor) };
  await page.locator('.plan-panel [data-action="view-plan"]').click();
  await editor.press("b");
  await shot(editor, page, "venue-public-front.png");
  const tablePlan = venueOnSheet(await tablePlanSheet(page));

  await page.locator('[data-venue="aisles"]').nth(1).locator("select").selectOption("crew");
  await editor.saved();
  const crewBothSides = { venue: await venueOf(editor), rows: await rowsOf(editor) };
  await shot(editor, page, "venue-crew-both-sides.png");
  await editor.press("b");

  const venue = {
    origin: [4, 3],
    planMm: [5200, 3000],
    tables: [mmRect(640, 768, 1920, 768)],
    rooms: [
      { name: "Room 1", rect: mmRect(0, 0, 4000, 3000) },
      { name: "Room 2", rect: mmRect(4000, 0, 1200, 1600) },
    ],
    obstacles: [
      { name: "Obstacle 1", rect: mmRect(0, 0, 400, 400), kind: "pillar" },
      { name: "Obstacle 2", rect: mmRect(3600, 2900, 400, 100), kind: "door" },
      { name: "Obstacle 3", rect: mmRect(700, 800, 100, 100), kind: "power" },
    ],
    aisles: [
      { name: "Aisle 1", rect: mmRect(640, 0, 1920, 768), side: "crew" },
      { name: "Aisle 2", rect: mmRect(640, 1536, 1920, 900), side: "public" },
    ],
  };
  expect({ beforeVenue, publicFront, tablePlan, crewBothSides }).toEqual({
    beforeVenue: [],
    tablePlan: {
      file: "Plan-1.table-plan-fit-a3.svg",
      areas: ["aisle crew", "aisle public", "obstacle pillar", "obstacle door", "obstacle power"],
      hatches: 2,
      aisleLabels: ["Aisle 1 · crew", "Aisle 2 · public"],
      legend: [
        "Public aisle",
        "Crew aisle (reach)",
        "Pillar (keep clear)",
        "Door (keep clear)",
        "Power point (marker)",
      ],
    },
    publicFront: {
      venue,
      rows: [{ rule: "reach", message: expect.stringMatching(/from every crew aisle\.$/u) }],
    },
    crewBothSides: {
      venue: {
        ...venue,
        aisles: venue.aisles.map((aisle) => ({ ...aisle, side: "crew" })),
      },
      rows: [],
    },
  });

  await editor.reload();
  await expect(page.locator(".welcome")).toHaveCount(0);
  await expect.poll(() => venueOf(editor)).toEqual(crewBothSides.venue);
  await expect.poll(() => rowsOf(editor)).toEqual([]);
  await editor.chooseMode("plan");
  await page.locator('section[aria-label="Aisles"]').scrollIntoViewIfNeeded();
  await shot(editor, page, "venue-reloaded.png");
});
