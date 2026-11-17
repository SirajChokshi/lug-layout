import type { IPaletteMemory } from "@brr/client";
import { useSyncExternalStore } from "react";

export function usePaletteMemory(memory: IPaletteMemory) {
  return useSyncExternalStore(
    (listener) => memory.subscribe(listener),
    () => memory.snapshot(),
  );
}
