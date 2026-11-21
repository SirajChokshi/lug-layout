import { decode } from "@brr/schema/decode";
import { PANEL_LAYOUT_VERSION, PanelLayout } from "@brr/schema/panels";
import { inject, injectable } from "inversify";
import { PANEL_LAYOUT_STORE } from "../tokens.ts";

export type PanelId = "library" | "stats";

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  version: PANEL_LAYOUT_VERSION,
  library: true,
  stats: false,
};

export function readPanelLayout(raw: string | null): PanelLayout {
  if (raw === null) return DEFAULT_PANEL_LAYOUT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PANEL_LAYOUT;
  }
  const decoded = decode(PanelLayout, parsed);
  return decoded.ok ? decoded.value : DEFAULT_PANEL_LAYOUT;
}

export interface IPanelLayoutStore {
  load(): PanelLayout;
  save(layout: PanelLayout): void;
}

const STORAGE_KEY = "brr.panels";

function storedPanelLayout(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

@injectable()
export class LocalStoragePanelLayoutStore implements IPanelLayoutStore {
  load(): PanelLayout {
    return readPanelLayout(storedPanelLayout());
  }

  save(layout: PanelLayout): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      return;
    }
  }
}

export interface IPanelLayout {
  subscribe(listener: () => void): () => void;
  snapshot(): PanelLayout;
  setOpen(panel: PanelId, open: boolean): void;
}

@injectable()
export class PanelLayoutService implements IPanelLayout {
  private readonly listeners = new Set<() => void>();
  private layout: PanelLayout;

  constructor(@inject(PANEL_LAYOUT_STORE) private readonly store: IPanelLayoutStore) {
    this.layout = store.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PanelLayout {
    return this.layout;
  }

  setOpen(panel: PanelId, open: boolean): void {
    if (this.layout[panel] === open) return;
    this.layout = { ...this.layout, [panel]: open };
    this.store.save(this.layout);
    for (const listener of this.listeners) listener();
  }
}
