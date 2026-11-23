import {
  transientFailureCode,
  type FetchUrl,
  type RetryClock,
  type RetryPolicy,
} from "./fetch-retry.ts";

const TOO_MANY_REQUESTS = 429;
const SERVICE_UNAVAILABLE = 503;
const BACK_PRESSURE: ReadonlySet<number> = new Set([TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE]);

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
    if (BACK_PRESSURE.has(status)) this.pause();
    else this.episodes = 0;
  }

  unreachable(sentAtMs: number): void {
    if (sentAtMs > this.throttledAtMs) this.pause();
  }

  async send(request: () => Promise<Response>): Promise<Response> {
    const sentAtMs = await this.pass();
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      if (transientFailureCode(error) !== null) this.unreachable(sentAtMs);
      throw error;
    }
    this.answered(sentAtMs, response.status);
    return response;
  }

  fetch(fetchUrl: FetchUrl): FetchUrl {
    return (url) => this.send(() => fetchUrl(url));
  }

  private pause(): void {
    const nowMs = this.clock.now();
    const pauseMs = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** this.episodes);
    this.episodes += 1;
    this.throttledAtMs = nowMs;
    this.resumeAtMs = nowMs + pauseMs;
  }
}
