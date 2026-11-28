import type { CatalogItemView } from "../catalog/placeable-catalog.ts";
import type { RoadKitView } from "../edit/road-drawing.ts";
import { canPin, type Hotbar } from "./hotbar.ts";

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
  readonly pinned: boolean;
  readonly pinnable: boolean;
}

interface SlotItem {
  readonly label: string;
  readonly caption: string;
  readonly studsWide: number;
  readonly studsDeep: number;
  readonly color: string | null;
}

const ROAD_KIT_CAPTION = "Road";

function catalogSlot(item: CatalogItemView): SlotItem {
  return {
    label: item.label,
    caption: item.shortLabel,
    studsWide: item.studsWide,
    studsDeep: item.studsDeep,
    color: item.color?.rgb ?? null,
  };
}

function roadKitSlot(kit: RoadKitView): SlotItem {
  return {
    label: kit.label,
    caption: ROAD_KIT_CAPTION,
    studsWide: kit.tileStuds,
    studsDeep: kit.tileStuds,
    color: null,
  };
}

function longestSide(item: SlotItem | undefined): number {
  return item && item.studsWide > 0 && item.studsDeep > 0
    ? Math.max(item.studsWide, item.studsDeep)
    : 0;
}

function slotItem(
  id: string,
  catalog: ReadonlyArray<CatalogItemView>,
  roadKits: ReadonlyArray<RoadKitView>,
): SlotItem | undefined {
  const item = catalog.find((entry) => entry.id === id);
  if (item) return catalogSlot(item);
  const kit = roadKits.find((entry) => entry.id === id);
  return kit ? roadKitSlot(kit) : undefined;
}

export function hotbarView(
  hotbar: Hotbar,
  catalog: ReadonlyArray<CatalogItemView>,
  roadKits: ReadonlyArray<RoadKitView> = [],
): ReadonlyArray<HotbarSlotView> {
  const items = hotbar.slots.map(({ item }) => slotItem(item, catalog, roadKits));
  const longest = Math.max(0, ...items.map(longestSide));
  const pinsLeft = canPin(hotbar);
  return hotbar.slots.map(({ item: id, pinned }, slot) => {
    const item = items[slot];
    return {
      item: id,
      label: (item?.label ?? id).replaceAll("_", " "),
      caption: item?.caption ?? id,
      footprint:
        item && longestSide(item) > 0
          ? {
              studsWide: item.studsWide,
              studsDeep: item.studsDeep,
              wideShare: item.studsWide / longest,
              deepShare: item.studsDeep / longest,
            }
          : null,
      color: item?.color ?? null,
      pinned,
      pinnable: pinned || pinsLeft,
    };
  });
}
