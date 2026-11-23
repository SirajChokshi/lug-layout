import { decode, decodedOrThrow } from "@brr/schema/decode";
import { STARTER_SHELF_FILE, StarterShelfV1, starterFilePath } from "@brr/schema/starters";
import { MANIFEST_FILE, WorldManifestV1 } from "@brr/schema/world";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const STARTERS = new URL("../../../apps/web/starters/", import.meta.url);
const VIEWPORT = { width: 1024, height: 768 } as const;
const READY_TIMEOUT_MS = 150_000;
const OPEN_TIMEOUT_MS = 120_000;
const THROTTLE_PRESSES = 3;

interface StarterContents {
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly trainsOnRails: number;
}

interface ShippedStarter extends StarterContents {
  readonly id: string;
}

interface PlayOffer {
  readonly ran: boolean;
  readonly reason: string;
}

async function starterJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, STARTERS), "utf8"));
}

async function shippedStarters(): Promise<ReadonlyArray<ShippedStarter>> {
  const shelf = decodedOrThrow(
    decode(StarterShelfV1, await starterJson(STARTER_SHELF_FILE), STARTER_SHELF_FILE),
    "the starter shelf is invalid",
  );
  return Promise.all(
    shelf.starters.map(async ({ world }) => {
      const path = starterFilePath(world, MANIFEST_FILE);
      const manifest = decodedOrThrow(
        decode(WorldManifestV1, await starterJson(path), path),
        "a starter manifest is invalid",
      );
      return {
        id: world,
        name: manifest.name,
        placements: manifest.placements,
        track: manifest.track,
        trainsOnRails: manifest.consists?.length ?? 0,
      };
    }),
  );
}

async function showStarters(page: Page): Promise<void> {
  const menu = page.locator(".world-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("> summary").click();
  await page.locator('[data-action="show-starters"]').click();
}

async function openedWorld(page: Page): Promise<StarterContents> {
  const state: { world: { placements: { refId: ReadonlyArray<number> } } } = JSON.parse(
    (await page.locator("#edit-state").textContent()) ?? "",
  );
  const trackPanel = page.locator("section.track-panel");
  return {
    name: (await page.locator(".world-glance strong").textContent()) ?? "",
    placements: state.world.placements.refId.length,
    track:
      (await trackPanel.count()) === 0
        ? 0
        : Number(await trackPanel.getAttribute("data-track-pieces")),
    trainsOnRails: Number(await page.locator("section.play-panel").getAttribute("data-trains")),
  };
}

async function runATrain(page: Page): Promise<PlayOffer> {
  const panel = page.locator("section.play-panel");
  const run = panel.locator('[data-action="play"]');
  if (!(await run.isEnabled())) {
    return { ran: false, reason: (await panel.locator("[data-play-refusal]").textContent()) ?? "" };
  }
  await run.click();
  await expect(panel).toHaveAttribute("data-play-status", "running");
  for (let press = 0; press < THROTTLE_PRESSES; press++) await page.keyboard.press("]");
  await expect.poll(async () => Number(await panel.getAttribute("data-speed"))).toBeGreaterThan(0);
  await panel.locator('[data-action="stop-play"]').click();
  return { ran: true, reason: "" };
}

test.use({ viewport: VIEWPORT });

test("a fresh profile opens on the welcome card, and each starter opens as its own world holding exactly its files, its trains standing on the rails, with Run offered or refused with a reason", async ({
  page,
}) => {
  const shipped = await shippedStarters();
  await page.goto("/?api=webgl2&state=1");
  await expect(page.locator(".editor")).toHaveAttribute("data-status", "ready", {
    timeout: READY_TIMEOUT_MS,
  });
  const welcome = page.locator(".welcome");
  await expect(welcome).toHaveAttribute("data-shelf", "ready");
  const card = await welcome.boundingBox();
  const offered = await welcome
    .locator("[data-starter]")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-starter")));
  const opened: StarterContents[] = [];
  const play: PlayOffer[] = [];
  for (const starter of shipped) {
    if ((await welcome.count()) === 0) await showStarters(page);
    await welcome.locator(`[data-starter="${starter.id}"]`).click();
    const worldName = page.locator(".world-glance strong");
    const refusal = welcome.locator(".error");
    await expect(worldName.filter({ hasText: starter.name }).or(refusal).first()).toBeVisible({
      timeout: OPEN_TIMEOUT_MS,
    });
    expect(await refusal.allTextContents(), `opening ${starter.id}`).toEqual([]);
    await expect(worldName).toHaveText(starter.name);
    await expect(welcome).toHaveCount(0);
    opened.push(await openedWorld(page));
    play.push(await runATrain(page));
  }

  const cardOnScreen =
    card !== null &&
    card.x >= 0 &&
    card.y >= 0 &&
    card.x + card.width <= VIEWPORT.width &&
    card.y + card.height <= VIEWPORT.height;
  expect(cardOnScreen, `the welcome card's box ${JSON.stringify(card)}`).toBe(true);
  expect(offered).toEqual(shipped.map((starter) => starter.id));
  expect(opened).toEqual(
    shipped.map(({ name, placements, track, trainsOnRails }) => ({
      name,
      placements,
      track,
      trainsOnRails,
    })),
  );
  expect(play.filter((offer) => !offer.ran && offer.reason === "")).toEqual([]);
  expect(play.some((offer) => offer.ran)).toBe(true);
  await expect(page.locator(".editor .error")).toHaveCount(0);
});
