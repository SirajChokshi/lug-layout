import { test } from "@playwright/test";
import { STARTER_VIEWPORT, walkEveryStarter } from "./starter-walk.ts";

test.use({ viewport: STARTER_VIEWPORT });

test("a fresh profile opens on the welcome card, and each starter opens as its own world holding exactly its files, its trains standing on the rails, with Run offered or refused with a reason", async ({
  page,
}) => {
  await walkEveryStarter(page);
});
