export interface SearchBudget {
  readonly now: () => number;
  readonly limitMs: number;
}

export const UNLIMITED_BUDGET: SearchBudget = { now: () => 0, limitMs: Number.POSITIVE_INFINITY };

const BUDGET_CHECK_NODES = 256;

export class Deadline {
  private nodes = 0;
  expired = false;
  private readonly started: number;

  constructor(private readonly budget: SearchBudget) {
    this.started = budget.now();
  }

  tick(): boolean {
    this.nodes++;
    if (this.nodes % BUDGET_CHECK_NODES === 0) this.check();
    return this.expired;
  }

  check(): boolean {
    if (this.budget.now() - this.started > this.budget.limitMs) this.expired = true;
    return this.expired;
  }
}
