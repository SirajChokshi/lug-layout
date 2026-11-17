import { describe, expect, it } from "vitest";
import { hudRegion, type HudRegion, type PanelRect } from "./hud-region.ts";

const FIT = { minWidthPx: 180, minHeightPx: 60, usefulHeightPx: 260 };

function rect(left: number, top: number, right: number, bottom: number): PanelRect {
  return { left, top, right, bottom };
}

function overlaps(a: HudRegion, b: PanelRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

interface Layout {
  readonly name: string;
  readonly width: number;
  readonly floor: number;
  readonly panels: ReadonlyArray<PanelRect>;
}

function editorLayout(width: number, height: number, hudBottom: number): Layout {
  const floor = height - 72;
  return {
    name: `${width}x${height}, editor HUD to ${hudBottom}`,
    width,
    floor,
    panels: [
      rect(12, 12, 460, hudBottom),
      rect(12, height - 268, 416, height - 84),
      rect(width - 372, 12, width - 12, height - 84),
    ],
  };
}

const layouts: ReadonlyArray<Layout> = [
  editorLayout(1440, 900, 250),
  editorLayout(1280, 800, 330),
  editorLayout(1024, 768, 314),
  editorLayout(1024, 768, 386),
  editorLayout(900, 700, 350),
  editorLayout(900, 700, 600),
];

describe("tool HUD region", () => {
  it.each(layouts)("never covers a panel or leaves the screen at $name", (layout) => {
    const region = hudRegion(layout.width, layout.floor, layout.panels, FIT);
    if (region === null) return;
    expect(layout.panels.filter((panel) => overlaps(region, panel))).toEqual([]);
    expect(region.left).toBeGreaterThanOrEqual(0);
    expect(region.right).toBeLessThanOrEqual(layout.width);
    expect(region.top).toBeGreaterThanOrEqual(0);
    expect(region.bottom).toBeLessThanOrEqual(layout.floor);
    expect(region.bottom - region.top).toBeGreaterThanOrEqual(FIT.minHeightPx);
  });

  it("sits under a tall top-left panel rather than squeezing beside it", () => {
    const layout = editorLayout(1024, 768, 386);
    expect(hudRegion(layout.width, layout.floor, layout.panels, FIT)).toEqual({
      left: 424,
      right: 644,
      top: 394,
      bottom: 688,
    });
  });

  it("uses the whole gap between side panels when nothing sits above it", () => {
    expect(hudRegion(1000, 700, [rect(0, 0, 300, 700), rect(700, 0, 1000, 700)], FIT)).toEqual({
      left: 308,
      right: 692,
      top: 8,
      bottom: 692,
    });
  });

  it("finds no region when panels leave less than the minimum height or width", () => {
    expect(hudRegion(800, 600, [rect(0, 0, 800, 560)], FIT)).toBeNull();
    expect(hudRegion(800, 600, [rect(0, 0, 350, 600), rect(500, 0, 800, 600)], FIT)).toBeNull();
  });
});
