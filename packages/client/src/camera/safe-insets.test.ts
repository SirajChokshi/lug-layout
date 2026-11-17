import { expect, it } from "vitest";
import { PANEL_GAP_PX, safeInsets, type ScreenRect } from "./safe-insets.ts";

const WIDTH_PX = 1600;
const HEIGHT_PX = 900;

function rect(left: number, top: number, width: number, height: number): ScreenRect {
  return { left, top, right: left + width, bottom: top + height };
}

const HUD = rect(12, 12, 420, 330);
const PLAN_PANEL = rect(12, 690, 380, 126);
const SIDE_PANEL = rect(1228, 12, 360, 804);
const VIEW_BAR = rect(576, 12, 448, 37);
const FOOTER = rect(0, 828, 1600, 72);
const TOOL_HUD = rect(560, 752, 480, 60);

it("pushes each editor panel back to the screen edge it sits against", () => {
  expect(safeInsets(WIDTH_PX, HEIGHT_PX, [HUD, PLAN_PANEL, SIDE_PANEL, VIEW_BAR, FOOTER])).toEqual({
    left: HUD.right + PANEL_GAP_PX,
    top: VIEW_BAR.bottom + PANEL_GAP_PX,
    right: WIDTH_PX - SIDE_PANEL.left + PANEL_GAP_PX,
    bottom: HEIGHT_PX - FOOTER.top + PANEL_GAP_PX,
  });
});

it("keeps framed content clear of a floating tool HUD above the footer", () => {
  const withoutHud = safeInsets(WIDTH_PX, HEIGHT_PX, [HUD, SIDE_PANEL, VIEW_BAR, FOOTER]);
  const withHud = safeInsets(WIDTH_PX, HEIGHT_PX, [HUD, SIDE_PANEL, VIEW_BAR, FOOTER, TOOL_HUD]);

  expect(withHud).toEqual({ ...withoutHud, bottom: HEIGHT_PX - TOOL_HUD.top + PANEL_GAP_PX });
});

it("ignores panels that are hidden and have no size", () => {
  expect(safeInsets(WIDTH_PX, HEIGHT_PX, [rect(700, 400, 0, 0)])).toEqual({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });
});
