export async function fill(page, name, value) {
  const input = page.locator(`input[name="${name}"]`).first();
  await input.fill(String(value));
  await page.waitForTimeout(50);
}

export async function planState(page) {
  return JSON.parse(await page.locator("#plan-state").innerText());
}

export async function newPlan(page, roomWidth, roomDepth) {
  await fill(page, "room-width", roomWidth);
  await fill(page, "room-depth", roomDepth);
  await page.locator('[data-action="new-plan"]').click();
  await page.waitForTimeout(200);
  const state = await planState(page);
  return state.plans[state.plans.length - 1];
}

export async function addTable(page, rect) {
  const before = (await planState(page)).plans.at(-1).footprint.tables.length;
  await page.locator('[data-action="add-table"]').click();
  await page.waitForTimeout(100);
  const plan = (await planState(page)).plans.at(-1);
  const table = plan.footprint.tables[before];
  await fill(page, `${table.id}-x`, rect.x);
  await fill(page, `${table.id}-z`, rect.z);
  await fill(page, `${table.id}-width`, rect.width);
  await fill(page, `${table.id}-depth`, rect.depth);
  return table.id;
}

export async function viewPlan(page) {
  await page.locator('[data-action="view-plan"]').first().click();
  await page.waitForTimeout(300);
}

export async function setProfile(page, profile) {
  await page.locator(".buildable select").selectOption(profile);
  await page.waitForTimeout(150);
}

export async function selectAt(page, findScreen, x, z) {
  await page.keyboard.press("Escape");
  const { px, py } = await findScreen(page, x, z);
  await page.mouse.click(px, py);
  await page.waitForTimeout(150);
}
