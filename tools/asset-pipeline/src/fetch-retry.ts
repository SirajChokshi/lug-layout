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

export interface RetryRunner {
  readonly clock: RetryClock;
  readonly policy: RetryPolicy;
  readonly log: (line: string) => void;
}

export interface RetryingFetch extends RetryRunner {
  readonly fetch: FetchUrl;
}

export const DOWNLOAD_RETRY: RetryPolicy = { attempts: 6, baseDelayMs: 1000, maxDelayMs: 30_000 };
export const BUCKET_RETRY: RetryPolicy = { attempts: 10, baseDelayMs: 1000, maxDelayMs: 60_000 };

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

const REQUEST_TIMEOUT = 408;
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

type Attempt<T> =
  | { readonly kind: "done"; readonly value: T }
  | {
      readonly kind: "retry";
      readonly reason: string;
      readonly retryAfterMs: number | null;
      readonly error: unknown;
    };

function transientStatus(status: number): boolean {
  return status === REQUEST_TIMEOUT || status === TOO_MANY_REQUESTS || status >= FIRST_SERVER_ERROR;
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

export function transientFailureCode(error: unknown): string | null {
  const code = errorCode(error);
  return code !== null && TRANSIENT_CODES.has(code) ? code : null;
}

function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

async function attempt<T>(
  send: () => Promise<Response>,
  read: (response: Response) => Promise<T>,
  clock: RetryClock,
): Promise<Attempt<T>> {
  try {
    const response = await send();
    if (!transientStatus(response.status)) return { kind: "done", value: await read(response) };
    return {
      kind: "retry",
      reason: String(response.status),
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), clock.now()),
      error: null,
    };
  } catch (error) {
    const code = transientFailureCode(error);
    if (code === null) throw error;
    return { kind: "retry", reason: code, retryAfterMs: null, error };
  }
}

function backoffMs(retry: number, policy: RetryPolicy, clock: RetryClock): number {
  const nominal = policy.baseDelayMs * 2 ** retry;
  return Math.round(nominal * (1 - JITTER + 2 * JITTER * clock.random()));
}

export async function requestWithRetry<T>(
  label: string,
  send: () => Promise<Response>,
  read: (response: Response) => Promise<T>,
  runner: RetryRunner,
): Promise<T> {
  const { policy, clock } = runner;
  let reason = "";
  let cause: unknown = null;
  for (let retry = 0; retry < policy.attempts; retry++) {
    const result = await attempt(send, read, clock);
    if (result.kind === "done") return result.value;
    reason = result.reason;
    cause = result.error;
    if (retry === policy.attempts - 1) break;
    const delayMs = Math.min(
      policy.maxDelayMs,
      Math.max(backoffMs(retry, policy, clock), result.retryAfterMs ?? 0),
    );
    runner.log(
      `${label} failed with ${reason}; retry ${retry + 1} of ${policy.attempts - 1} in ${delayMs} ms`,
    );
    await clock.sleep(delayMs);
  }
  throw new Error(
    `${label} failed with ${reason} after ${policy.attempts} attempts`,
    cause === null ? undefined : { cause },
  );
}

async function fetched(response: Response): Promise<Fetched> {
  return {
    status: response.status,
    bytes: response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
  };
}

export function fetchWithRetry(url: string, network: RetryingFetch): Promise<Fetched> {
  return requestWithRetry(`GET ${url}`, () => network.fetch(url), fetched, network);
}
