import { expect, it } from "vitest";
import { MODEL_SEGMENT, NO_ROW, PlanRows } from "./plan-rows.ts";

const OPERATIONS = 120_000;
const PHASE = 20_000;
const LOW_LIVE = 2000;
const HIGH_LIVE = 8000;
const FULL_CHECK_EVERY = 997;

function lcg(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

it("finds every live model row, and no removed one, through long probe clusters near the load limit", () => {
  const rows = new PlanRows();
  const next = lcg(12345);
  const keys: number[] = [];
  const rowOf = new Map<number, number>();
  const wrong: string[] = [];
  let nextId = 1;
  for (let op = 0; op < OPERATIONS; op++) {
    const target = op % PHASE < PHASE / 2 ? LOW_LIVE : HIGH_LIVE;
    if (keys.length < target) {
      const id = nextId++;
      keys.push(id);
      rowOf.set(id, rows.add(MODEL_SEGMENT, id));
      continue;
    }
    const at = next(keys.length);
    const id = keys[at] ?? 0;
    keys[at] = keys[keys.length - 1] ?? 0;
    keys.pop();
    rows.remove(rows.find(MODEL_SEGMENT, id));
    rowOf.delete(id);
    if (rows.find(MODEL_SEGMENT, id) !== NO_ROW) wrong.push(`removed ${id} still found`);
    if (op % FULL_CHECK_EVERY !== 0) continue;
    for (const [live, row] of rowOf) {
      if (rows.find(MODEL_SEGMENT, live) !== row) wrong.push(`${live} lost at operation ${op}`);
    }
  }
  expect(wrong.slice(0, 5)).toEqual([]);
});
