import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { EditorPage, TRACK_ITEM, nearestLattice } from "./editor-page.ts";

const MY_WAGONS = fileURLToPath(
  new URL("../../../packages/import/test-data/my-container-and-tank-wagons.ldr", import.meta.url),
);
const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;
const WAGONS_AT = { x: 0, z: 0 };

const SECTIONS = {
  library: ".library",
  world: ".world-menu",
  minimap: ".minimap",
  play: "section.play-panel",
  event: ".event-panel",
  plan: ".plan-panel",
  parts: ".bom",
  hotbar: ".hotbar",
  drawTrack: '.toolbar [data-action="draw-track"]',
  find: '.toolbar [data-action="open-palette"]',
} as const;

async function shown(page: Page): Promise<ReadonlyArray<string>> {
  const visible: string[] = [];
  for (const [name, selector] of Object.entries(SECTIONS)) {
    if (await page.locator(selector).isVisible()) visible.push(name);
  }
  return visible;
}

async function view(page: Page): Promise<string | null> {
  return page.locator(".view-controls").getAttribute("data-view");
}

test("Build, Plan and Play each show their own panels and open in 3D, 2D and 3D; a running train always shows Play and leaving Play stops it; a tool picked in Play goes to Build and the table tool to Plan", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  await editor.dragTrack({ x: -400, z: 0 }, { x: 400, z: 0 });
  const ends = await editor.trackEnds();
  const east = ends.find((end) => end.heading === EAST);
  const west = ends.find((end) => end.heading === WEST);
  if (!east || !west) throw new Error(`a straight run has two ends: ${JSON.stringify(ends)}`);
  expect((await editor.dragTrack(nearestLattice(east), nearestLattice(west))).openEnds).toBe(0);
  await editor.escape();
  const wagons = await editor.importModel(MY_WAGONS);
  expect(wagons.status, wagons.text).toBe("placeable");
  await editor.placeAt(wagons.item, WAGONS_AT);
  await editor.escape();
  expect(await editor.trainsOnRails()).toBe(1);

  const build = { mode: "build", view: await view(page), shown: await shown(page) };
  await editor.chooseMode("plan");
  const plan = { mode: "plan", view: await view(page), shown: await shown(page) };
  await editor.chooseMode("play");
  const play = { mode: "play", view: await view(page), shown: await shown(page) };
  expect([build, plan, play]).toEqual([
    {
      mode: "build",
      view: "orbit",
      shown: ["library", "world", "minimap", "hotbar", "drawTrack", "find"],
    },
    {
      mode: "plan",
      view: "plan",
      shown: ["library", "world", "event", "plan", "parts", "hotbar", "drawTrack", "find"],
    },
    { mode: "play", view: "orbit", shown: ["minimap", "play", "find"] },
  ]);

  await page.locator('section.play-panel [data-action="play"]').click();
  await expect(page.locator("section.play-panel")).toHaveAttribute("data-play-status", "running");
  await editor.chooseMode("build");
  await expect(page.locator("section.play-panel")).toHaveAttribute("data-play-status", "idle");

  await editor.startPlay();
  await expect(editor.root).toHaveAttribute("data-shell-mode", "play");
  await editor.press("Shift+P");
  await expect(page.locator("section.play-panel")).toHaveAttribute("data-play-status", "idle");
  await expect(editor.root).toHaveAttribute("data-shell-mode", "build");

  await editor.chooseMode("play");
  await editor.press("t");
  await expect(editor.root).toHaveAttribute("data-mode", "track");
  await expect(editor.root).toHaveAttribute("data-shell-mode", "build");

  await editor.press("b");
  await expect(editor.root).toHaveAttribute("data-mode", "table");
  await expect(editor.root).toHaveAttribute("data-shell-mode", "plan");
  await editor.chooseMode("build");
  await expect(editor.root).toHaveAttribute("data-mode", "select");
});
