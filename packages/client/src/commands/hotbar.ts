import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { EDITOR } from "../tokens.ts";
import type { KeyChord } from "./key-chord.ts";

export const HOTBAR_SLOTS = 9;
export const RECENT_SLOTS = 4;
export const PINNED_SLOTS = HOTBAR_SLOTS - RECENT_SLOTS;

export const KEY_FOR_SLOT: ReadonlyArray<KeyChord> = Array.from(
  { length: HOTBAR_SLOTS },
  (_, slot) => ({ key: String(slot + 1) }),
);

export interface HotbarSlot {
  readonly item: string;
  readonly lastUsed: number;
  readonly pinned: boolean;
}

export interface Hotbar {
  readonly slots: ReadonlyArray<HotbarSlot>;
  readonly clock: number;
}

export const EMPTY_HOTBAR: Hotbar = { slots: [], clock: 0 };

function pinnedCount(slots: ReadonlyArray<HotbarSlot>): number {
  return slots.filter((slot) => slot.pinned).length;
}

function leastRecentUnpinned(slots: ReadonlyArray<HotbarSlot>): number {
  let oldest = -1;
  for (let slot = 0; slot < slots.length; slot++) {
    const candidate = slots[slot];
    if (!candidate || candidate.pinned) continue;
    if (oldest < 0 || candidate.lastUsed < (slots[oldest]?.lastUsed ?? 0)) oldest = slot;
  }
  return oldest;
}

export function canPin(hotbar: Hotbar): boolean {
  return pinnedCount(hotbar.slots) < PINNED_SLOTS;
}

export function hotbarWith(hotbar: Hotbar, item: string): Hotbar {
  const clock = hotbar.clock + 1;
  const slots = [...hotbar.slots];
  const existing = slots.findIndex((slot) => slot.item === item);
  const kept = slots[existing];
  if (kept) {
    slots[existing] = { ...kept, lastUsed: clock };
    return { slots, clock };
  }
  const used = { item, lastUsed: clock, pinned: false };
  if (slots.length - pinnedCount(slots) < RECENT_SLOTS) slots.push(used);
  else slots[leastRecentUnpinned(slots)] = used;
  return { slots, clock };
}

export function hotbarWithPinToggled(hotbar: Hotbar, slot: number): Hotbar {
  const target = hotbar.slots[slot];
  if (!target || (!target.pinned && !canPin(hotbar))) return hotbar;
  const clock = hotbar.clock + 1;
  const slots = hotbar.slots.map((kept, at) =>
    at === slot ? { ...kept, pinned: !kept.pinned, lastUsed: clock } : kept,
  );
  if (slots.length - pinnedCount(slots) <= RECENT_SLOTS) return { slots, clock };
  const evicted = leastRecentUnpinned(slots);
  return { slots: slots.filter((_, at) => at !== evicted), clock };
}

export interface IHotbar {
  subscribe(listener: () => void): () => void;
  snapshot(): Hotbar;
  pick(slot: number): void;
  togglePin(slot: number): void;
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

  togglePin(slot: number): void {
    this.set(hotbarWithPinToggled(this.hotbar, slot));
  }

  private notice(active: string | null): void {
    if (active === this.lastActive) return;
    this.lastActive = active;
    if (active === null) return;
    this.set(hotbarWith(this.hotbar, active));
  }

  private set(hotbar: Hotbar): void {
    if (hotbar === this.hotbar) return;
    this.hotbar = hotbar;
    for (const listener of this.listeners) listener();
  }
}
