export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface SafeInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const PANEL_GAP_PX = 8;

const SAME_EDGE_DISTANCE_PX = 2 * PANEL_GAP_PX;

type Side = "left" | "top" | "right" | "bottom";

interface Candidate {
  readonly side: Side;
  readonly inset: number;
  readonly edgeDistance: number;
  readonly lostArea: number;
}

function sideFor(widthPx: number, heightPx: number, panel: ScreenRect): Candidate {
  const candidates: ReadonlyArray<Candidate> = [
    {
      side: "left",
      inset: panel.right + PANEL_GAP_PX,
      edgeDistance: panel.left,
      lostArea: (panel.right + PANEL_GAP_PX) * heightPx,
    },
    {
      side: "top",
      inset: panel.bottom + PANEL_GAP_PX,
      edgeDistance: panel.top,
      lostArea: (panel.bottom + PANEL_GAP_PX) * widthPx,
    },
    {
      side: "right",
      inset: widthPx - panel.left + PANEL_GAP_PX,
      edgeDistance: widthPx - panel.right,
      lostArea: (widthPx - panel.left + PANEL_GAP_PX) * heightPx,
    },
    {
      side: "bottom",
      inset: heightPx - panel.top + PANEL_GAP_PX,
      edgeDistance: heightPx - panel.bottom,
      lostArea: (heightPx - panel.top + PANEL_GAP_PX) * widthPx,
    },
  ];
  const nearest = Math.min(...candidates.map((candidate) => candidate.edgeDistance));
  return candidates
    .filter((candidate) => candidate.edgeDistance <= nearest + SAME_EDGE_DISTANCE_PX)
    .reduce((best, candidate) => (candidate.lostArea < best.lostArea ? candidate : best));
}

export function safeInsets(
  widthPx: number,
  heightPx: number,
  panels: ReadonlyArray<ScreenRect>,
): SafeInsets {
  const insets = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const panel of panels) {
    if (panel.right <= panel.left || panel.bottom <= panel.top) continue;
    const { side, inset } = sideFor(widthPx, heightPx, panel);
    insets[side] = Math.max(insets[side], inset);
  }
  return insets;
}
