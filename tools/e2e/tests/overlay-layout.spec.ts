import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

const MODES = ["select", "place", "track", "road", "plan"] as const;
type Mode = (typeof MODES)[number];

const READY_TIMEOUT_MS = 150_000;
const ACTION_TIMEOUT_MS = 30_000;
const CLICK_SAMPLE_STEP_PX = 8;

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface OverlayBox {
  readonly name: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly spillPx: number;
  readonly clicksCaughtBy: ReadonlyArray<string>;
}

async function openEditor(page: Page): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    pageErrors.push(`${request.url()} failed: ${request.failure()?.errorText ?? "unknown"}`),
  );
  await page.goto("/?api=webgl2");
  const editor = page.locator(".editor");
  await expect(editor).toHaveAttribute("data-status", /^(?:ready|error)$/u, {
    timeout: READY_TIMEOUT_MS,
  });
  if ((await editor.getAttribute("data-status")) === "error") {
    const shown = await editor.locator(".error").allTextContents();
    throw new Error(`the editor couldn't start: ${[...shown, ...pageErrors].join(" | ")}`);
  }
}

async function enterMode(page: Page, mode: Mode): Promise<void> {
  const toolHud = page.locator(".tool-hud");
  switch (mode) {
    case "select":
      await expect(toolHud).toHaveAttribute("data-tone", "idle");
      return;
    case "place":
      await page.locator('.palette [data-section="baseplates"] [data-item]').first().click();
      await expect(toolHud).toHaveAttribute("data-tone", "place");
      return;
    case "track":
      await page.locator('.toolbar [data-action="draw-track"]').click();
      await expect(toolHud).toHaveAttribute("data-tone", "track");
      return;
    case "road": {
      await page.locator('.palette [data-section="road"] [data-item]').first().click();
      await expect(toolHud).toHaveAttribute("data-tone", "place");
      const roadJoins = page.locator(".road-joins");
      await roadJoins.locator("> summary").click();
      await expect(roadJoins).toHaveAttribute("open", "");
      return;
    }
    case "plan":
      await page.locator(".plan-panel > summary").click();
      await page.locator('[data-action="new-plan"]').click();
      await expect(page.locator(".plan-panel")).toHaveAttribute("data-active-plan", /.+/u);
      await expect(page.locator(".view-controls")).toHaveAttribute("data-view", "plan");
      return;
    default: {
      const unhandled: never = mode;
      throw new Error(`unhandled mode ${String(unhandled)}`);
    }
  }
}

function measureOverlays(stepPx: number): OverlayBox[] {
  const root = document.querySelector(".editor");
  if (!root) throw new Error("the editor is not mounted");
  const panels = [...root.children]
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .filter((element) => !element.matches("canvas.scene, svg.scene-labels, .overlay"))
    .filter((element) => getComputedStyle(element).position === "fixed")
    .map((element) => ({
      element,
      name: [element.tagName.toLowerCase(), ...element.classList].join("."),
      rect: element.getBoundingClientRect(),
    }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0);
  return panels.map(({ element, name, rect }) => {
    const caught = new Set<string>();
    for (let y = rect.top + 1; y < rect.bottom - 1; y += stepPx) {
      for (let x = rect.left + 1; x < rect.right - 1; x += stepPx) {
        const hit = document.elementFromPoint(x, y);
        const owner = panels.find((panel) => hit !== null && panel.element.contains(hit));
        if (owner !== undefined && owner.element !== element) caught.add(owner.name);
      }
    }
    const style = getComputedStyle(element);
    const spillX = style.overflowX === "visible" ? element.scrollWidth - element.clientWidth : 0;
    const spillY = style.overflowY === "visible" ? element.scrollHeight - element.clientHeight : 0;
    return {
      name,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      spillPx: Math.max(spillX, spillY),
      clicksCaughtBy: [...caught],
    };
  });
}

function intersections(boxes: ReadonlyArray<OverlayBox>): string[] {
  const found: string[] = [];
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1)) {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 0 && height > 0) {
        found.push(`${a.name} and ${b.name} overlap by ${width.toFixed(0)}×${height.toFixed(0)}`);
      }
    }
  });
  return found;
}

function offScreen(boxes: ReadonlyArray<OverlayBox>, viewport: Viewport): string[] {
  return boxes
    .filter(
      (box) =>
        box.left < 0 || box.top < 0 || box.right > viewport.width || box.bottom > viewport.height,
    )
    .map((box) => `${box.name} leaves the screen`);
}

async function expectOverlaysApart(page: Page, viewport: Viewport): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const boxes = await page.evaluate(measureOverlays, CLICK_SAMPLE_STEP_PX);
  expect(boxes.length).toBeGreaterThan(1);
  expect(intersections(boxes)).toEqual([]);
  expect(offScreen(boxes, viewport)).toEqual([]);
  expect(
    boxes.filter((box) => box.spillPx > 0).map((box) => `${box.name} spills out of its box`),
  ).toEqual([]);
  expect(
    boxes.flatMap((box) =>
      box.clicksCaughtBy.map((other) => `${other} catches clicks aimed at ${box.name}`),
    ),
  ).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, actionTimeout: ACTION_TIMEOUT_MS });
    for (const mode of MODES) {
      test(`overlays never overlap or catch each other's clicks in ${mode} mode, stats folded or open`, async ({
        page,
      }) => {
        await openEditor(page);
        await enterMode(page, mode);
        await expectOverlaysApart(page, viewport);
        await page.locator(".editor-hud > summary").click();
        await expectOverlaysApart(page, viewport);
      });
    }
  });
}
