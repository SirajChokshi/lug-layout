import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage } from "./editor-page.ts";
import { R2LikeServer } from "./r2-like-server.ts";
import { STARTER_VIEWPORT, walkEveryStarter } from "./starter-walk.ts";

const R2_DEV_CUTOFF = { servedBeforeLockout: 850, lockoutMs: 10_000 } as const;

test.use({ viewport: STARTER_VIEWPORT });

function pageOrigin(baseURL: string | undefined): string {
  return new URL(baseURL ?? "").origin;
}

function towerOfBricksTheBundleLacks(): string {
  return [
    "0 A tower of 1 x 3 x 5 bricks, a part the bundle doesn't ship",
    "0 Name: custom-tower.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "1 4 0 0 -20 1 0 0 0 1 0 0 0 1 3755a.dat",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3755a.dat",
    "1 4 0 0 20 1 0 0 0 1 0 0 0 1 3755a.dat",
    "1 1 0 -120 0 0 0 1 0 1 0 -1 0 0 3755a.dat",
    "",
  ].join("\n");
}

test("every starter opens and runs its trains while the bundle's cross-origin server throttles it as r2.dev does, answering 429 without CORS headers, and no part's mesh fails to load", async ({
  page,
  baseURL,
}) => {
  const bucket = await R2LikeServer.serve(page.context(), pageOrigin(baseURL), R2_DEV_CUTOFF);
  try {
    await walkEveryStarter(page);
    expect(bucket.refused()).toBeGreaterThan(0);
    expect(bucket.failedOpaquely()).toBeGreaterThan(0);
    await expect(
      page.locator(".editor-hud dl > div").filter({ hasText: "Parts not drawn" }).locator("dd"),
    ).not.toContainText("failed to load");
  } finally {
    await bucket.stop();
  }
});

test("a user's own model with a part the bundle doesn't ship imports while the bundle's cross-origin server throttles its reads", async ({
  page,
  baseURL,
}) => {
  const bucket = await R2LikeServer.serve(page.context(), pageOrigin(baseURL));
  try {
    const editor = await EditorPage.open(page);
    await editor.serveLdrawLibrary();
    const file = test.info().outputPath("custom-tower.ldr");
    await writeFile(file, towerOfBricksTheBundleLacks());
    bucket.lockOut(R2_DEV_CUTOFF.lockoutMs);
    const tower = await editor.importModel(file);
    expect(tower.status, tower.text).toBe("placeable");
    expect(bucket.refused()).toBeGreaterThan(0);
    expect(bucket.failedOpaquely()).toBeGreaterThan(0);
  } finally {
    await bucket.stop();
  }
});
