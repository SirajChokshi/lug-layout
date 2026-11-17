import type { CatalogItemView, IEditor } from "@brr/client";
import type { DragEvent } from "react";

export const PALETTE_ITEM_MIME = "application/x-brr-palette-item";

export interface PaletteDragProps {
  readonly draggable: true;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}

interface PaletteDrag {
  readonly item: string;
  readonly activeBefore: string | null;
}

let current: PaletteDrag | null = null;

export function paletteDragProps(
  editor: IEditor,
  item: CatalogItemView,
): PaletteDragProps | Record<string, never> {
  if (item.kind === "track") return {};
  return {
    draggable: true,
    onDragStart: (event) => {
      current = { item: item.id, activeBefore: editor.snapshot().activeItem };
      event.dataTransfer.setData(PALETTE_ITEM_MIME, item.id);
      event.dataTransfer.effectAllowed = "copy";
      editor.chooseItem(item.id);
    },
    onDragEnd: () => {
      const finished = current;
      current = null;
      if (finished && finished.activeBefore !== finished.item) {
        editor.chooseItem(finished.activeBefore);
      }
    },
  };
}

export function carriesPaletteItem(event: globalThis.DragEvent): boolean {
  return event.dataTransfer?.types.includes(PALETTE_ITEM_MIME) ?? false;
}
