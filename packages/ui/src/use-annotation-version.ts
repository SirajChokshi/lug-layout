import type { IAnnotationService } from "@brr/client";
import { useSyncExternalStore } from "react";

export function useAnnotationVersion(annotations: IAnnotationService): number {
  return useSyncExternalStore(
    (listener) => annotations.subscribe(listener),
    () => annotations.version(),
  );
}
