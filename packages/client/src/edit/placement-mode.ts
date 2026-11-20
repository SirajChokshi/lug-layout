import { STUD_LDU } from "@brr/math";
import type { IEditor } from "./editor.ts";
import type { PlacementHover, PlacementMode } from "./placement-hover.ts";

export function effectivePlacementMode(
  persistent: PlacementMode,
  override: boolean,
): PlacementMode {
  if (!override) return persistent;
  return persistent === "assist" ? "precise" : "assist";
}

export interface PlacementModeView {
  readonly placementMode: PlacementMode;
  readonly placementModeOverride: boolean;
}

export interface MagnetMove {
  readonly studsX: number;
  readonly studsZ: number;
  readonly plates: number;
}

export function otherPlacementMode(mode: PlacementMode): PlacementMode {
  return effectivePlacementMode(mode, true);
}

function studsAlong(ldu: number): number {
  return Math.round(Math.abs(ldu) / STUD_LDU);
}

export function magnetMove(placement: PlacementHover): MagnetMove | null {
  if (placement.mode !== "assist" || !placement.magnetised) return null;
  const { dxLdu, dzLdu, dyPlates } = placement.magnet;
  return { studsX: studsAlong(dxLdu), studsZ: studsAlong(dzLdu), plates: dyPlates };
}

export function togglePlacementMode(editor: IEditor): void {
  editor.setPlacementMode(otherPlacementMode(editor.snapshot().placementMode));
}

export function holdPlacementModeOverride(editor: IEditor, held: boolean): void {
  if (editor.snapshot().placementModeOverride !== held) editor.setPlacementModeOverride(held);
}
