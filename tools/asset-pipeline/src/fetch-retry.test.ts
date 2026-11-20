import { describe, expect, it } from "vitest";
import { DOWNLOAD_RETRY, fetchWithRetry, type FetchUrl } from "./fetch-retry.ts";

const URL = "https://raw.githubusercontent.com/owner/library/pinned/parts/15573.dat";
const BODY = "0 Plate 1 x 2 with 1 Stud with Groove\n";

type Answer = number | { readonly status: number; readonly retryAfter: string } | Error;

function network(answers: ReadonlyArray<Answer>) {
  const sleeps: number[] = [];
  const logged: string[] = [];
  let calls = 0;
  const fetch: FetchUrl = async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer === undefined) throw new Error("no answer scripted");
    if (answer instanceof Error) throw answer;
    const { status, retryAfter } =
      typeof answer === "number" ? { status: answer, retryAfter: null } : answer;
    const headers: Record<string, string> =
      retryAfter === null ? {} : { "retry-after": retryAfter };
    return new Response(status === 200 ? BODY : null, { status, headers });
  };
  return {
    sleeps,
    logged,
    calls: () => calls,
    fetching: {
      fetch,
      clock: {
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
        now: () => 0,
      },
      policy: DOWNLOAD_RETRY,
      log: (line: string) => logged.push(line),
    },
  };
}

function reset(): Error {
  return new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
}

describe("fetchWithRetry", () => {
  it("retries 503s with doubling backoff and returns the first 200's bytes, logging each retry", async () => {
    const scripted = network([503, 503, 200]);

    const fetched = await fetchWithRetry(URL, scripted.fetching);

    expect({
      body: fetched.bytes && new TextDecoder().decode(fetched.bytes),
      calls: scripted.calls(),
      sleeps: scripted.sleeps,
      logged: scripted.logged,
    }).toEqual({
      body: BODY,
      calls: 3,
      sleeps: [1000, 2000],
      logged: [
        `GET ${URL} failed with 503; retry 1 of 4 in 1000 ms`,
        `GET ${URL} failed with 503; retry 2 of 4 in 2000 ms`,
      ],
    });
  });

  it.each([404, 403])("returns a %i at once, without retrying", async (status) => {
    const scripted = network([status, 200]);

    const fetched = await fetchWithRetry(URL, scripted.fetching);

    expect({ fetched, calls: scripted.calls(), sleeps: scripted.sleeps }).toEqual({
      fetched: { status, bytes: null },
      calls: 1,
      sleeps: [],
    });
  });

  it("gives up after five attempts and names the last failure", async () => {
    const scripted = network([503]);

    await expect(fetchWithRetry(URL, scripted.fetching)).rejects.toThrow(
      `GET ${URL} failed with 503 after 5 attempts`,
    );
    expect({ calls: scripted.calls(), sleeps: scripted.sleeps }).toEqual({
      calls: 5,
      sleeps: [1000, 2000, 4000, 8000],
    });
  });

  it("retries a reset connection, waits as long as a longer Retry-After asks, and never less than the backoff", async () => {
    const scripted = network([
      reset(),
      { status: 429, retryAfter: "3" },
      { status: 503, retryAfter: "0" },
      200,
    ]);

    const fetched = await fetchWithRetry(URL, scripted.fetching);

    expect({ status: fetched.status, sleeps: scripted.sleeps }).toEqual({
      status: 200,
      sleeps: [1000, 3000, 4000],
    });
  });

  it("rethrows an error that isn't a transient network failure, without retrying", async () => {
    const scripted = network([new TypeError("Invalid URL"), 200]);

    await expect(fetchWithRetry(URL, scripted.fetching)).rejects.toThrow("Invalid URL");
    expect(scripted.calls()).toBe(1);
  });
});
