import type { EditorSnapshot, QueuedPlacement } from "./editor.ts";

export type HeldTables = "loading" | "ready";

export interface HeldItemView {
  readonly item: string;
  readonly tables: HeldTables;
  readonly queued: QueuedPlacement | null;
}

export function heldItem(
  snapshot: Pick<EditorSnapshot, "mode" | "activeItem" | "pendingItem" | "queuedPlacement">,
): HeldItemView | null {
  const { mode, activeItem, pendingItem, queuedPlacement } = snapshot;
  if (mode !== "place" || activeItem === null) return null;
  return pendingItem === activeItem
    ? { item: activeItem, tables: "loading", queued: queuedPlacement }
    : { item: activeItem, tables: "ready", queued: null };
}
