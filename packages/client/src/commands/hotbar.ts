import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { EDITOR } from "../tokens.ts";
import type { KeyChord } from "./key-chord.ts";

export const HOTBAR_SLOTS = 9;

export const KEY_FOR_SLOT: ReadonlyArray<KeyChord> = Array.from(
  { length: HOTBAR_SLOTS },
  (_, slot) => ({ key: String(slot + 1) }),
);

export interface HotbarSlot {
  readonly item: string;
  readonly lastUsed: number;
}

export interface Hotbar {
  readonly slots: ReadonlyArray<HotbarSlot>;
  readonly clock: number;
}

export const EMPTY_HOTBAR: Hotbar = { slots: [], clock: 0 };

function leastRecentSlot(slots: ReadonlyArray<HotbarSlot>): number {
  let oldest = 0;
  for (let slot = 1; slot < slots.length; slot++) {
    if ((slots[slot]?.lastUsed ?? 0) < (slots[oldest]?.lastUsed ?? 0)) oldest = slot;
  }
  return oldest;
}

export function hotbarWith(hotbar: Hotbar, item: string): Hotbar {
  const clock = hotbar.clock + 1;
  const existing = hotbar.slots.findIndex((slot) => slot.item === item);
  const slot =
    existing >= 0
      ? existing
      : hotbar.slots.length < HOTBAR_SLOTS
        ? hotbar.slots.length
        : leastRecentSlot(hotbar.slots);
  const slots = [...hotbar.slots];
  slots[slot] = { item, lastUsed: clock };
  return { slots, clock };
}

export interface IHotbar {
  subscribe(listener: () => void): () => void;
  snapshot(): Hotbar;
  pick(slot: number): void;
}

@injectable()
export class HotbarService implements IHotbar {
  private readonly listeners = new Set<() => void>();
  private hotbar = EMPTY_HOTBAR;
  private lastActive: string | null = null;

  constructor(@inject(EDITOR) private readonly editor: IEditor) {
    editor.subscribe(() => this.notice(editor.snapshot().activeItem));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Hotbar {
    return this.hotbar;
  }

  pick(slot: number): void {
    const item = this.hotbar.slots[slot]?.item;
    if (item !== undefined) this.editor.chooseItem(item);
  }

  private notice(active: string | null): void {
    if (active === this.lastActive) return;
    this.lastActive = active;
    if (active === null) return;
    this.hotbar = hotbarWith(this.hotbar, active);
    for (const listener of this.listeners) listener();
  }
}
