import type { IOwnedParts, OwnedPartsView } from "@brr/client";
import { useEffect, useSyncExternalStore } from "react";

export function useOwnedParts(owned: IOwnedParts): OwnedPartsView {
  useEffect(() => {
    void owned.load();
  }, [owned]);
  return useSyncExternalStore(
    (listener) => owned.subscribe(listener),
    () => owned.view(),
  );
}
