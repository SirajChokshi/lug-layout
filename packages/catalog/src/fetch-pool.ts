import type { FetchPriority } from "./part-bundle.ts";

export class FetchPool {
  private active = 0;
  private readonly waiting: Record<FetchPriority, Array<() => void>> = { high: [], low: [] };

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, priority: FetchPriority = "high"): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting[priority].push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.high.shift() ?? this.waiting.low.shift();
      if (next) next();
      else this.active--;
    }
  }
}
