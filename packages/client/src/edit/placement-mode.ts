import type { PlacementMode } from "./placement-hover.ts";

export function effectivePlacementMode(
  persistent: PlacementMode,
  override: boolean,
): PlacementMode {
  if (!override) return persistent;
  return persistent === "assist" ? "precise" : "assist";
}
