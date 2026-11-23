import {
  NETWORK,
  type FetchUrl,
  type RetryClock,
  type RetryPolicy,
  type RetryingFetch,
} from "../fetch-retry.ts";

const TOO_MANY_REQUESTS = 429;

export const PUBLIC_BUCKET_RETRY: RetryPolicy = {
  attempts: 10,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

export class ThrottleGate {
  private readonly clock: RetryClock;
  private readonly policy: RetryPolicy;
  private resumeAtMs = Number.NEGATIVE_INFINITY;
  private throttledAtMs = Number.NEGATIVE_INFINITY;
  private episodes = 0;

  constructor(clock: RetryClock, policy: RetryPolicy) {
    this.clock = clock;
    this.policy = policy;
  }

  async pass(): Promise<number> {
    for (
      let waitMs = this.resumeAtMs - this.clock.now();
      waitMs > 0;
      waitMs = this.resumeAtMs - this.clock.now()
    ) {
      await this.clock.sleep(waitMs);
    }
    return this.clock.now();
  }

  answered(sentAtMs: number, status: number): void {
    if (sentAtMs <= this.throttledAtMs) return;
    if (status !== TOO_MANY_REQUESTS) {
      this.episodes = 0;
      return;
    }
    const nowMs = this.clock.now();
    const pauseMs = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** this.episodes);
    this.episodes += 1;
    this.throttledAtMs = nowMs;
    this.resumeAtMs = nowMs + pauseMs;
  }

  fetch(fetchUrl: FetchUrl): FetchUrl {
    return async (url) => {
      const sentAtMs = await this.pass();
      const response = await fetchUrl(url);
      this.answered(sentAtMs, response.status);
      return response;
    };
  }
}

export function publicBucketNetwork(): RetryingFetch {
  const gate = new ThrottleGate(NETWORK.clock, PUBLIC_BUCKET_RETRY);
  return { ...NETWORK, policy: PUBLIC_BUCKET_RETRY, fetch: gate.fetch(NETWORK.fetch) };
}
