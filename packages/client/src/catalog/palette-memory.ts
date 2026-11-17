import { decode } from "@brr/schema/decode";
import { PALETTE_MEMORY_VERSION, PaletteMemory } from "@brr/schema/palette";
import { inject, injectable } from "inversify";
import type { IEditor, LatencySample } from "../edit/editor.ts";
import { EDITOR, PALETTE_MEMORY_STORE } from "../tokens.ts";

export const RECENT_LIMIT = 10;

export const EMPTY_PALETTE_MEMORY: PaletteMemory = {
  version: PALETTE_MEMORY_VERSION,
  favorites: [],
  recents: [],
};

export function withRecent(memory: PaletteMemory, itemId: string): PaletteMemory {
  return {
    ...memory,
    recents: [itemId, ...memory.recents.filter((id) => id !== itemId)].slice(0, RECENT_LIMIT),
  };
}

export function withFavoriteToggled(memory: PaletteMemory, entryKey: string): PaletteMemory {
  const favorites = memory.favorites.includes(entryKey)
    ? memory.favorites.filter((key) => key !== entryKey)
    : [...memory.favorites, entryKey];
  return { ...memory, favorites };
}

export function readPaletteMemory(raw: string | null): PaletteMemory {
  if (raw === null) return EMPTY_PALETTE_MEMORY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_PALETTE_MEMORY;
  }
  const decoded = decode(PaletteMemory, parsed);
  return decoded.ok ? decoded.value : EMPTY_PALETTE_MEMORY;
}

export interface IPaletteMemoryStore {
  load(): PaletteMemory;
  save(memory: PaletteMemory): void;
}

const STORAGE_KEY = "brr.palette-memory";

function storedPaletteMemory(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

@injectable()
export class LocalStoragePaletteMemoryStore implements IPaletteMemoryStore {
  load(): PaletteMemory {
    return readPaletteMemory(storedPaletteMemory());
  }

  save(memory: PaletteMemory): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      return;
    }
  }
}

export interface IPaletteMemory {
  subscribe(listener: () => void): () => void;
  snapshot(): PaletteMemory;
  toggleFavorite(entryKey: string): void;
  forgetRecents(): void;
}

@injectable()
export class PaletteMemoryService implements IPaletteMemory {
  private readonly listeners = new Set<() => void>();
  private memory: PaletteMemory;
  private lastSeen: LatencySample | null = null;

  constructor(
    @inject(EDITOR) editor: IEditor,
    @inject(PALETTE_MEMORY_STORE) private readonly store: IPaletteMemoryStore,
  ) {
    this.memory = store.load();
    editor.subscribe(() => this.notice(editor.snapshot().lastLatency));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PaletteMemory {
    return this.memory;
  }

  toggleFavorite(entryKey: string): void {
    this.set(withFavoriteToggled(this.memory, entryKey));
  }

  forgetRecents(): void {
    this.set({ ...this.memory, recents: [] });
  }

  private notice(sample: LatencySample | null): void {
    if (sample === null || sample === this.lastSeen) return;
    this.lastSeen = sample;
    if (sample.step !== "do" || (sample.action !== "place" && sample.action !== "track")) return;
    this.set(withRecent(this.memory, sample.item));
  }

  private set(memory: PaletteMemory): void {
    this.memory = memory;
    this.store.save(memory);
    for (const listener of this.listeners) listener();
  }
}
