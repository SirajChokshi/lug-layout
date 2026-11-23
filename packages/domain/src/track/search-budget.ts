export interface SearchBudget {
  readonly tablePairs: number;
  readonly curveCandidates: number;
}

export const UNLIMITED_BUDGET: SearchBudget = {
  tablePairs: Number.POSITIVE_INFINITY,
  curveCandidates: Number.POSITIVE_INFINITY,
};

export const CLOSURE_BUDGET: SearchBudget = { tablePairs: 2 ** 21, curveCandidates: 2 ** 16 };

export class SearchAllowance {
  exhausted = false;
  private spentTablePairs = 0;
  private spentCurveCandidates = 0;
  private readonly tablePairLimit: number;
  private readonly curveCandidateLimit: number;

  constructor(budget: SearchBudget) {
    this.tablePairLimit = budget.tablePairs;
    this.curveCandidateLimit = budget.curveCandidates;
  }

  spendTablePairs(count: number): boolean {
    this.spentTablePairs += count;
    if (this.spentTablePairs > this.tablePairLimit) this.exhausted = true;
    return this.exhausted;
  }

  spendCurveCandidate(): boolean {
    this.spentCurveCandidates += 1;
    if (this.spentCurveCandidates > this.curveCandidateLimit) this.exhausted = true;
    return this.exhausted;
  }
}
