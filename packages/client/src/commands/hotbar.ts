export const HOTBAR_SLOTS = 9;

export interface Hotbar {
  readonly slots: ReadonlyArray<string>;
  readonly lastUsed: ReadonlyArray<number>;
  readonly clock: number;
}

export const EMPTY_HOTBAR: Hotbar = { slots: [], lastUsed: [], clock: 0 };

function leastRecentSlot(lastUsed: ReadonlyArray<number>): number {
  let oldest = 0;
  for (let slot = 1; slot < lastUsed.length; slot++) {
    if ((lastUsed[slot] ?? 0) < (lastUsed[oldest] ?? 0)) oldest = slot;
  }
  return oldest;
}

export function hotbarWith(hotbar: Hotbar, id: string): Hotbar {
  const clock = hotbar.clock + 1;
  const existing = hotbar.slots.indexOf(id);
  const slot =
    existing >= 0
      ? existing
      : hotbar.slots.length < HOTBAR_SLOTS
        ? hotbar.slots.length
        : leastRecentSlot(hotbar.lastUsed);
  const slots = [...hotbar.slots];
  const lastUsed = [...hotbar.lastUsed];
  slots[slot] = id;
  lastUsed[slot] = clock;
  return { slots, lastUsed, clock };
}

export function hotbarRecent(hotbar: Hotbar): ReadonlyArray<string> {
  return hotbar.slots
    .map((id, slot) => ({ id, used: hotbar.lastUsed[slot] ?? 0 }))
    .toSorted((a, b) => b.used - a.used)
    .map((entry) => entry.id);
}
