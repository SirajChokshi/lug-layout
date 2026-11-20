export interface RetryClock {
  sleep(ms: number): Promise<void>;
  random(): number;
  now(): number;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface Fetched {
  readonly status: number;
  readonly bytes: Uint8Array | null;
}

export type FetchUrl = (url: string) => Promise<Response>;

export interface RetryingFetch {
  readonly fetch: FetchUrl;
  readonly clock: RetryClock;
  readonly policy: RetryPolicy;
  readonly log: (line: string) => void;
}

export const DOWNLOAD_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

const SYSTEM_CLOCK: RetryClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

export const NETWORK: RetryingFetch = {
  fetch: (url) => fetch(url),
  clock: SYSTEM_CLOCK,
  policy: DOWNLOAD_RETRY,
  log: (line) => process.stderr.write(`${line}\n`),
};

const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;
const JITTER = 0.25;
const MS_PER_SECOND = 1000;
const CAUSE_DEPTH = 5;
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

type Attempt =
  | { readonly kind: "done"; readonly fetched: Fetched }
  | { readonly kind: "retry"; readonly reason: string; readonly retryAfterMs: number | null };

function transientStatus(status: number): boolean {
  return status === TOO_MANY_REQUESTS || status >= FIRST_SERVER_ERROR;
}

function errorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && typeof current.code === "string") return current.code;
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

async function attempt(url: string, network: RetryingFetch): Promise<Attempt> {
  try {
    const response = await network.fetch(url);
    if (response.ok) {
      return {
        kind: "done",
        fetched: { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) },
      };
    }
    if (!transientStatus(response.status)) {
      return { kind: "done", fetched: { status: response.status, bytes: null } };
    }
    return {
      kind: "retry",
      reason: String(response.status),
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), network.clock.now()),
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === null || !TRANSIENT_CODES.has(code)) throw error;
    return { kind: "retry", reason: code, retryAfterMs: null };
  }
}

function backoffMs(retry: number, policy: RetryPolicy, clock: RetryClock): number {
  const nominal = policy.baseDelayMs * 2 ** retry;
  return Math.round(nominal * (1 - JITTER + 2 * JITTER * clock.random()));
}

export async function fetchWithRetry(url: string, network: RetryingFetch): Promise<Fetched> {
  const { policy, clock } = network;
  let reason = "";
  for (let retry = 0; retry < policy.attempts; retry++) {
    const result = await attempt(url, network);
    if (result.kind === "done") return result.fetched;
    reason = result.reason;
    if (retry === policy.attempts - 1) break;
    const delayMs = Math.min(
      policy.maxDelayMs,
      result.retryAfterMs ?? backoffMs(retry, policy, clock),
    );
    network.log(
      `GET ${url} failed with ${reason}; retry ${retry + 1} of ${policy.attempts - 1} in ${delayMs} ms`,
    );
    await clock.sleep(delayMs);
  }
  throw new Error(`GET ${url} failed with ${reason} after ${policy.attempts} attempts`);
}
