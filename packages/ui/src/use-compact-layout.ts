import { useSyncExternalStore } from "react";

const WIDE_LAYOUT_MIN_PX = 1340;
const COMPACT_LAYOUT_QUERY = `(max-width: ${WIDE_LAYOUT_MIN_PX - 1}px)`;

function compactQuery(): MediaQueryList {
  return window.matchMedia(COMPACT_LAYOUT_QUERY);
}

function subscribe(listener: () => void): () => void {
  const query = compactQuery();
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function isCompactLayout(): boolean {
  return compactQuery().matches;
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompactLayout);
}
