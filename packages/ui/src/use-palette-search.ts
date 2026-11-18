import type { IPaletteSearch, PaletteSearchSnapshot } from "@brr/client";
import { useSyncExternalStore } from "react";

export function usePaletteSearchSnapshot(search: IPaletteSearch): PaletteSearchSnapshot {
  return useSyncExternalStore(
    (listener) => search.subscribe(listener),
    () => search.snapshot(),
  );
}
