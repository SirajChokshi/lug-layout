import { expect, test, type Locator } from "@playwright/test";
import { EditorPage } from "./editor-page.ts";

async function attributes(locator: Locator, name: string): Promise<string[]> {
  return locator.evaluateAll(
    (elements, attribute) => elements.map((element) => element.getAttribute(attribute) ?? ""),
    name,
  );
}

test("every palette item is browsable under exactly one category tab", async ({ page }) => {
  await EditorPage.open(page);
  const palette = page.locator(".palette");
  const tabs = palette.locator('[role="tab"]');
  const sections = palette.locator("details.palette-section");
  const items = sections.locator("[data-item]");

  await palette.locator('[role="tab"][data-filter="all"]').click();
  const allSections = await attributes(sections, "data-section");
  const allItems = await attributes(items, "data-item");
  const filters = await attributes(tabs, "data-filter");
  expect(allSections.filter((section) => !filters.includes(section))).toEqual([]);
  expect(allItems.length).toBeGreaterThan(0);
  expect(new Set(allItems).size, "an item is listed in two categories").toBe(allItems.length);

  const browsed: string[] = [];
  for (const category of allSections) {
    const tab = palette.locator(`[role="tab"][data-filter="${category}"]`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await attributes(sections, "data-section")).toEqual([category]);
    const shown = await attributes(items, "data-item");
    expect(shown.length, `the ${category} tab shows no items`).toBeGreaterThan(0);
    browsed.push(...shown);
  }
  expect(browsed.toSorted()).toEqual(allItems.toSorted());
});
