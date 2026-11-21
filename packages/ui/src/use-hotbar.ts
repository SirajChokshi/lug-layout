import type { Hotbar, IHotbar } from "@brr/client";
import { useSyncExternalStore } from "react";

export function useHotbarSnapshot(hotbar: IHotbar): Hotbar {
  return useSyncExternalStore(
    (listener) => hotbar.subscribe(listener),
    () => hotbar.snapshot(),
  );
}
