import { EMPTY_HOTBAR, hotbarWith, type Hotbar } from "@brr/client";
import { useState } from "react";

interface HotbarState {
  readonly active: string | null;
  readonly hotbar: Hotbar;
}

export function useHotbar(activeItem: string | null): Hotbar {
  const [state, setState] = useState<HotbarState>({ active: null, hotbar: EMPTY_HOTBAR });
  if (state.active === activeItem) return state.hotbar;
  const hotbar = activeItem === null ? state.hotbar : hotbarWith(state.hotbar, activeItem);
  setState({ active: activeItem, hotbar });
  return hotbar;
}
