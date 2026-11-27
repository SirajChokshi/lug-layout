import { AssetResponseError } from "./asset-response-error.ts";

const ATTEMPTS = 6;
const FIRST_WAIT_MS = 1_000;
const ALL_WAITS_MS = FIRST_WAIT_MS * (2 ** (ATTEMPTS - 1) - 1);
const TOO_MANY_REQUESTS = 429;
const SERVICE_UNAVAILABLE = 503;
const MS_PER_S = 1_000;
const DELTA_SECONDS = /^\d+$/u;

function throttleStatus(status: number): boolean {
  return status === TOO_MANY_REQUESTS || status === SERVICE_UNAVAILABLE;
}

export function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("Retry-After")?.trim() ?? "";
  return DELTA_SECONDS.test(value) ? Number(value) * MS_PER_S : null;
}

function offline(): boolean {
  return globalThis.navigator?.onLine === false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resume) => setTimeout(resume, ms));
}

class RetryBackoff {
  private retries = 0;
  private waitedMs = 0;

  afterError(error: unknown): number | null {
    if (error instanceof AssetResponseError)
      return this.afterStatus(error.status, error.retryAfterMs);
    return error instanceof TypeError && !offline() ? this.next(null) : null;
  }

  afterStatus(status: number, retryAfter: number | null): number | null {
    return throttleStatus(status) ? this.next(retryAfter) : null;
  }

  private next(retryAfter: number | null): number | null {
    if (this.retries + 1 >= ATTEMPTS) return null;
    const waitMs = Math.max(FIRST_WAIT_MS * 2 ** this.retries, retryAfter ?? 0);
    if (this.waitedMs + waitMs > ALL_WAITS_MS) return null;
    this.retries += 1;
    this.waitedMs += waitMs;
    return waitMs;
  }
}

export async function retried<T>(attempt: () => Promise<T>): Promise<T> {
  const backoff = new RetryBackoff();
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const waitMs = backoff.afterError(error);
      if (waitMs === null) throw error;
      await wait(waitMs);
    }
  }
}

export function retryingFetch(
  fetchUrl: (url: string) => Promise<Response>,
): (url: string) => Promise<Response> {
  return async (url) => {
    const backoff = new RetryBackoff();
    for (;;) {
      let waitMs: number | null;
      try {
        const response = await fetchUrl(url);
        waitMs = backoff.afterStatus(response.status, retryAfterMs(response.headers));
        if (waitMs === null) return response;
        await response.body?.cancel();
      } catch (error) {
        waitMs = backoff.afterError(error);
        if (waitMs === null) throw error;
      }
      await wait(waitMs);
    }
  };
}
