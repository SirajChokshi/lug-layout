export type SpentOn = "recordFetchMs" | "compileMs" | "ldrawFetchMs" | "shadowFetchMs";

export type SpentTotals = Readonly<Record<SpentOn, number>>;

export class TimeSpent {
  private readonly totals: Record<SpentOn, number> = {
    recordFetchMs: 0,
    compileMs: 0,
    ldrawFetchMs: 0,
    shadowFetchMs: 0,
  };

  constructor(private readonly now: () => number) {}

  async during<T>(on: SpentOn, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await work();
    } finally {
      this.totals[on] += this.now() - started;
    }
  }

  inside<T>(on: SpentOn, work: () => T): T {
    const started = this.now();
    try {
      return work();
    } finally {
      this.totals[on] += this.now() - started;
    }
  }

  spent(): SpentTotals {
    return { ...this.totals };
  }
}
