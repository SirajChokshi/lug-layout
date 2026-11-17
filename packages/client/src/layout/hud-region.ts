export interface PanelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface HudRegion {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const HUD_GAP_PX = 8;

export interface HudFit {
  readonly minWidthPx: number;
  readonly minHeightPx: number;
  readonly usefulHeightPx: number;
}

interface Column {
  readonly left: number;
  readonly right: number;
  readonly ceiling: number;
}

function columns(widthPx: number, floorPx: number, panels: ReadonlyArray<PanelRect>): Column[] {
  const edges = [...new Set([0, widthPx, ...panels.flatMap((panel) => [panel.left, panel.right])])]
    .filter((x) => x >= 0 && x <= widthPx)
    .toSorted((a, b) => a - b);
  const result: Column[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const left = edges[i] ?? 0;
    const right = edges[i + 1] ?? 0;
    let ceiling = 0;
    for (const panel of panels) {
      const covers = panel.left < right && panel.right > left && panel.top < floorPx;
      if (covers) ceiling = Math.max(ceiling, panel.bottom);
    }
    result.push({ left, right, ceiling: Math.min(ceiling, floorPx) });
  }
  return result;
}

function inset(region: HudRegion): HudRegion {
  return {
    left: region.left + HUD_GAP_PX,
    right: region.right - HUD_GAP_PX,
    top: region.top + HUD_GAP_PX,
    bottom: region.bottom,
  };
}

export function hudRegion(
  widthPx: number,
  floorPx: number,
  panels: ReadonlyArray<PanelRect>,
  fit: HudFit,
): HudRegion | null {
  const bottom = floorPx - HUD_GAP_PX;
  const cols = columns(widthPx, bottom, panels);
  let best: HudRegion | null = null;
  let bestArea = 0;
  for (let first = 0; first < cols.length; first++) {
    let ceiling = 0;
    for (let last = first; last < cols.length; last++) {
      ceiling = Math.max(ceiling, cols[last]?.ceiling ?? bottom);
      const height = bottom - ceiling - 2 * HUD_GAP_PX;
      if (height < fit.minHeightPx) break;
      const left = cols[first]?.left ?? 0;
      const right = cols[last]?.right ?? 0;
      const width = right - left - 2 * HUD_GAP_PX;
      if (width < fit.minWidthPx) continue;
      const area = width * Math.min(height, fit.usefulHeightPx);
      if (area > bestArea) {
        bestArea = area;
        best = inset({ left, right, top: ceiling, bottom });
      }
    }
  }
  return best;
}
