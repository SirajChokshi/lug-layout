import { useState } from "react";

const RECENT_LIMIT = 8;

interface RecentState {
  readonly active: string | null;
  readonly recent: ReadonlyArray<string>;
}

export function useRecentItems(activeItem: string | null): ReadonlyArray<string> {
  const [state, setState] = useState<RecentState>({ active: null, recent: [] });
  if (state.active === activeItem) return state.recent;
  const recent =
    activeItem === null
      ? state.recent
      : [activeItem, ...state.recent.filter((id) => id !== activeItem)].slice(0, RECENT_LIMIT);
  setState({ active: activeItem, recent });
  return recent;
}
