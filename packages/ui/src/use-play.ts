import type { ITrainPlay, PlaySnapshot } from "@brr/client";
import { useSyncExternalStore } from "react";

export function usePlaySnapshot(play: ITrainPlay): PlaySnapshot {
  return useSyncExternalStore(
    (listener) => play.subscribe(listener),
    () => play.snapshot(),
  );
}
