import { BUCKET_RETRY, NETWORK, type RetryingFetch } from "../fetch-retry.ts";
import { ThrottleGate } from "../throttle-gate.ts";

export function publicBucketNetwork(): RetryingFetch {
  const gate = new ThrottleGate(NETWORK.clock, BUCKET_RETRY);
  return { ...NETWORK, policy: BUCKET_RETRY, fetch: gate.fetch(NETWORK.fetch) };
}
