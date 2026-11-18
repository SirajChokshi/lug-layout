import type { FetchPriority } from "./part-bundle.ts";

export type FetchLane = "structural" | FetchPriority;

interface WaitingFetch {
  readonly path: string;
  readonly start: () => void;
}

function otherPriority(priority: FetchPriority): FetchPriority {
  return priority === "high" ? "low" : "high";
}

export class FetchPool {
  private active = 0;
  private readonly waiting: Record<FetchLane, WaitingFetch[]> = {
    structural: [],
    high: [],
    low: [],
  };

  constructor(private readonly limit: number) {}

  async run<T>(path: string, task: () => Promise<T>, lane: FetchLane): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((start) => this.waiting[lane].push({ path, start }));
    try {
      return await task();
    } finally {
      const next =
        this.waiting.structural.shift() ?? this.waiting.high.shift() ?? this.waiting.low.shift();
      if (next) next.start();
      else this.active--;
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
}
