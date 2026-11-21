import type { FetchPriority } from "./part-bundle.ts";

export type FetchLane = "structural" | FetchPriority;

interface WaitingFetch {
  readonly path: string;
  readonly start: () => void;
}

export interface FetchPoolPolicy {
  readonly slots: number;
  readonly reservedStructuralSlots: number;
}

export const DEFAULT_FETCH_POOL_POLICY: FetchPoolPolicy = { slots: 16, reservedStructuralSlots: 1 };

const LANE_ORDER: ReadonlyArray<FetchLane> = ["structural", "high", "low"];

function otherPriority(priority: FetchPriority): FetchPriority {
  return priority === "high" ? "low" : "high";
}

export class FetchPool {
  private active = 0;
  private activeMeshes = 0;
  private readonly waiting: Record<FetchLane, WaitingFetch[]> = {
    structural: [],
    high: [],
    low: [],
  };

  private readonly limit: number;
  private readonly meshLimit: number;

  constructor({ slots, reservedStructuralSlots }: FetchPoolPolicy) {
    if (!Number.isInteger(reservedStructuralSlots) || reservedStructuralSlots < 0) {
      throw new Error(`reservedStructuralSlots ${reservedStructuralSlots} is not a whole count`);
    }
    if (!Number.isInteger(slots) || slots <= reservedStructuralSlots) {
      throw new Error(
        `${slots} fetch slots leave none for meshes beside ${reservedStructuralSlots} reserved`,
      );
    }
    this.limit = slots;
    this.meshLimit = slots - reservedStructuralSlots;
  }

  async run<T>(path: string, task: () => Promise<T>, lane: FetchLane): Promise<T> {
    if (this.admits(lane)) this.claim(lane);
    else await new Promise<void>((start) => this.waiting[lane].push({ path, start }));
    try {
      return await task();
    } finally {
      this.release(lane);
      this.startWaiting();
    }
  }

  setPriority(path: string, priority: FetchPriority): void {
    const from = this.waiting[otherPriority(priority)];
    for (let i = 0; i < from.length; i++) {
      const fetch = from[i];
      if (fetch?.path !== path) continue;
      from.copyWithin(i, i + 1);
      from.length -= 1;
      this.waiting[priority].push(fetch);
      return;
    }
  }

  private admits(lane: FetchLane): boolean {
    return (
      this.active < this.limit && (lane === "structural" || this.activeMeshes < this.meshLimit)
    );
  }

  private claim(lane: FetchLane): void {
    this.active++;
    if (lane !== "structural") this.activeMeshes++;
  }

  private release(lane: FetchLane): void {
    this.active--;
    if (lane !== "structural") this.activeMeshes--;
  }

  private startWaiting(): void {
    for (const lane of LANE_ORDER) {
      const queue = this.waiting[lane];
      while (queue.length > 0 && this.admits(lane)) {
        const next = queue.shift();
        if (next === undefined) break;
        this.claim(lane);
        next.start();
      }
    }
  }
}
