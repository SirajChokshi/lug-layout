export interface TrackSolveStats {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

const SOLVE_SAMPLE_CAP = 1024;
const MEDIAN = 0.5;
const P95 = 0.95;

export class SolveSamples {
  private readonly ring = new Float64Array(SOLVE_SAMPLE_CAP).fill(Number.POSITIVE_INFINITY);
  private readonly sorted = new Float64Array(SOLVE_SAMPLE_CAP);
  private next = 0;
  private count = 0;
  private current: TrackSolveStats | null = null;

  push(ms: number): void {
    this.ring[this.next] = ms;
    this.next = (this.next + 1) % SOLVE_SAMPLE_CAP;
    if (this.count < SOLVE_SAMPLE_CAP) this.count++;
    this.sorted.set(this.ring);
    this.sorted.sort();
    this.current = {
      samples: this.count,
      medianMs: this.at(MEDIAN),
      p95Ms: this.at(P95),
      maxMs: this.sorted[this.count - 1] ?? 0,
    };
  }

  stats(): TrackSolveStats | null {
    return this.current;
  }

  private at(quantile: number): number {
    return this.sorted[Math.min(this.count - 1, Math.floor(quantile * this.count))] ?? 0;
  }
}
