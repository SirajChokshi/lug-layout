import type { IStarterWorlds, WelcomeView } from "@brr/client";
import { useSyncExternalStore } from "react";

export function useWelcome(starters: IStarterWorlds): WelcomeView {
  return useSyncExternalStore(
    (listener) => starters.subscribe(listener),
    () => starters.view(),
  );
}
