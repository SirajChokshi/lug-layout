import { rgb, type Paint, type Rgb, type TextAnchor, type TextStyle } from "./draw-list.ts";

export const INK = rgb("#1b1f23");
export const PAPER = rgb("#ffffff");
const ISSUE = rgb("#c62828");

function outline(stroke: Rgb, strokeMm: number, dashMm: ReadonlyArray<number> = []): Paint {
  return { fill: null, fillOpacity: 1, stroke, strokeMm, dashMm };
}

function filled(fill: Rgb, stroke: Rgb | null = null, strokeMm = 0, fillOpacity = 1): Paint {
  return { fill, fillOpacity, stroke, strokeMm, dashMm: [] };
}

export const PAINTS = {
  page: filled(PAPER),
  room: outline(rgb("#444444"), 0.5),
  table: filled(rgb("#ead9bd"), rgb("#8a6d3b"), 0.5),
  obstacle: outline(rgb("#666666"), 0.4),
  hatch: outline(rgb("#999999"), 0.6),
  roadway: filled(rgb("#9aa3a8")),
  model: outline(rgb("#1b4f72"), 0.5),
  modelFlagged: outline(ISSUE, 0.8),
  track: filled(rgb("#4a4a4a"), rgb("#111111"), 0.2, 0.85),
  trackFlagged: filled(rgb("#4a4a4a"), ISSUE, 0.8, 0.85),
  ramp: outline(rgb("#6b4f1d"), 0.4, [1.6, 1.2]),
  dimension: outline(rgb("#444444"), 0.25),
  rule: outline(rgb("#444444"), 0.25),
  number: filled(PAPER, rgb("#1b4f72"), 0.4),
  numberFlagged: filled(PAPER, ISSUE, 0.6),
  frame: outline(rgb("#9e9e9e"), 0.2),
  seam: outline(rgb("#616161"), 0.2, [2, 1.5]),
  registration: outline(rgb("#000000"), 0.15),
  tileCell: outline(rgb("#1565c0"), 0.3, [1.5, 1]),
} as const satisfies Record<string, Paint>;

export const TITLE_MM = 8;
export const TEXT_MM = 4;
export const SMALL_MM = 3;
export const FINE_MM = 2.5;

export function textStyle(
  sizeMm: number,
  options: { readonly bold?: boolean; readonly anchor?: TextAnchor; readonly halo?: boolean } = {},
): TextStyle {
  return {
    sizeMm,
    bold: options.bold ?? false,
    color: INK,
    anchor: options.anchor ?? "start",
    halo: options.halo ?? false,
  };
}
