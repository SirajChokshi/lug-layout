import type { CommandPaletteSnapshot, ICommandPaletteSearch } from "@brr/client";
import { useSyncExternalStore } from "react";

export function useCommandPaletteSnapshot(search: ICommandPaletteSearch): CommandPaletteSnapshot {
  return useSyncExternalStore(
    (listener) => search.subscribe(listener),
    () => search.snapshot(),
  );
}
