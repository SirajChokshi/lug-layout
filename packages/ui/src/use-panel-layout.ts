import type { IPanelLayout } from "@brr/client";
import type { PanelLayout } from "@brr/schema/panels";
import { useSyncExternalStore } from "react";

export function usePanelLayout(panels: IPanelLayout): PanelLayout {
  return useSyncExternalStore(
    (listener) => panels.subscribe(listener),
    () => panels.snapshot(),
  );
}
