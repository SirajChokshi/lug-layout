import type { CatalogItemView } from "../catalog/placeable-catalog.ts";
import type { Hotbar } from "./hotbar.ts";

export interface HotbarFootprint {
  readonly studsWide: number;
  readonly studsDeep: number;
  readonly wideShare: number;
  readonly deepShare: number;
}

export interface HotbarSlotView {
  readonly item: string;
  readonly label: string;
  readonly caption: string;
  readonly footprint: HotbarFootprint | null;
  readonly color: string | null;
}

function longestSide(item: CatalogItemView | undefined): number {
  return item && item.studsWide > 0 && item.studsDeep > 0
    ? Math.max(item.studsWide, item.studsDeep)
    : 0;
}

export function hotbarView(
  hotbar: Hotbar,
  catalog: ReadonlyArray<CatalogItemView>,
): ReadonlyArray<HotbarSlotView> {
  const items = hotbar.slots.map(({ item }) => catalog.find((entry) => entry.id === item));
  const longest = Math.max(0, ...items.map(longestSide));
  return hotbar.slots.map(({ item: id }, slot) => {
    const item = items[slot];
    return {
      item: id,
      label: (item?.label ?? id).replaceAll("_", " "),
      caption: item?.shortLabel ?? id,
      footprint:
        item && longestSide(item) > 0
          ? {
              studsWide: item.studsWide,
              studsDeep: item.studsDeep,
              wideShare: item.studsWide / longest,
              deepShare: item.studsDeep / longest,
            }
          : null,
      color: item?.color?.rgb ?? null,
    };
  });
}
