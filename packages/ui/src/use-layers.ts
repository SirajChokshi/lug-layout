import type { ILayerService, LayerTable } from "@brr/client";
import { useCallback, useSyncExternalStore } from "react";

export interface LayersView {
  readonly table: LayerTable;
  readonly active: number;
}

export function useLayers(layers: ILayerService): LayersView {
  const subscribe = useCallback((listener: () => void) => layers.subscribe(listener), [layers]);
  const table = useSyncExternalStore(subscribe, () => layers.table());
  const active = useSyncExternalStore(subscribe, () => layers.activeLayer());
  return { table, active };
}
