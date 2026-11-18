import type { CatalogItemView, IPaletteDrag } from "@brr/client";
import type { DragEvent } from "react";

const PALETTE_ITEM_MIME = "application/x-brr-palette-item";

export interface PaletteDragProps {
  readonly draggable: true;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}

export function paletteDragProps(
  drag: IPaletteDrag,
  item: CatalogItemView,
): PaletteDragProps | Record<string, never> {
  if (!item.draggable) return {};
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.setData(PALETTE_ITEM_MIME, item.id);
      event.dataTransfer.effectAllowed = "copy";
      drag.start(item.id);
    },
    onDragEnd: () => drag.end(),
  };
}

export function carriesPaletteItem(event: globalThis.DragEvent): boolean {
  return event.dataTransfer?.types.includes(PALETTE_ITEM_MIME) ?? false;
}
