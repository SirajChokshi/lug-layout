import { describe, expect, it } from "vitest";
import { DOWNLOAD_RETRY, fetchWithRetry, type RetryingFetch } from "./fetch-retry.ts";

const URL = "https://raw.githubusercontent.com/owner/library/pinned/parts/15573.dat";
const BODY = "0 Plate 1 x 2 with 1 Stud with Groove\n";
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const OK = 200;

type Answer =
  | number
  | { readonly status: number; readonly retryAfter: string }
  | { readonly bodyFails: Error }
  | Error;

function respond(answer: Answer): Response {
  if (answer instanceof Error) throw answer;
  if (typeof answer === "number") {
    return new Response(answer === OK ? BODY : null, { status: answer });
  }
  if ("bodyFails" in answer) {
    return new Response(new ReadableStream({ pull: (stream) => stream.error(answer.bodyFails) }));
  }
  return new Response(null, {
    status: answer.status,
    headers: { "retry-after": answer.retryAfter },
  });
}

function scripted(answers: ReadonlyArray<Answer>, random = 0.5) {
  const sleeps: number[] = [];
  const logged: string[] = [];
  let calls = 0;
  const network: RetryingFetch = {
    fetch: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer === undefined) throw new Error("no answer scripted");
      return respond(answer);
    },
    clock: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => random,
      now: () => NOW,
    },
    policy: DOWNLOAD_RETRY,
    log: (line) => logged.push(line),
  };
  return { network, sleeps, logged, calls: () => calls };
}

function connectionFailure(code: string, message = "fetch failed"): Error {
  return new TypeError(message, { cause: Object.assign(new Error(code), { code }) });
}

describe("fetchWithRetry", () => {
  it.each<readonly [string, Answer]>([
    ["408", 408],
    ["429", 429],
    ["500", 500],
    ["503", 503],
    ["ECONNRESET", connectionFailure("ECONNRESET")],
    ["EAI_AGAIN", connectionFailure("EAI_AGAIN")],
    ["UND_ERR_SOCKET", { bodyFails: connectionFailure("UND_ERR_SOCKET", "terminated") }],
  ])(
    "retries a transient %s, logging the URL and the failure, then returns the next answer",
    async (reason, transient) => {
      const network = scripted([transient, OK]);

      const fetched = await fetchWithRetry(URL, network.network);

      expect({
        status: fetched.status,
        body: fetched.bytes && new TextDecoder().decode(fetched.bytes),
        calls: network.calls(),
        sleeps: network.sleeps,
        logged: network.logged,
      }).toEqual({
        status: OK,
        body: BODY,
        calls: 2,
        sleeps: [1000],
        logged: [`GET ${URL} failed with ${reason}; retry 1 of 5 in 1000 ms`],
      });
    },
  );

  it.each([400, 403, 404, 410])("returns a %i at once, without retrying", async (status) => {
    const network = scripted([status, OK]);

    const fetched = await fetchWithRetry(URL, network.network);

    expect({ fetched, calls: network.calls(), sleeps: network.sleeps }).toEqual({
      fetched: { status, bytes: null },
      calls: 1,
      sleeps: [],
    });
  });

  it.each([new TypeError("Invalid URL"), connectionFailure("CERT_HAS_EXPIRED")])(
    "rethrows %s at once, because it isn't a transient network failure",
    async (error) => {
      const network = scripted([error, OK]);

      await expect(fetchWithRetry(URL, network.network)).rejects.toBe(error);
      expect(network.calls()).toBe(1);
    },
  );

  it.each([
    { random: 0.5, sleeps: [1000, 2000, 4000, 8000, 16_000] },
    { random: 0, sleeps: [750, 1500, 3000, 6000, 12_000] },
  ])(
    "doubles the backoff from 1 s with ±25 % jitter (random $random), and gives up after six attempts",
    async ({ random, sleeps }) => {
      const network = scripted([503], random);

      await expect(fetchWithRetry(URL, network.network)).rejects.toThrow(
        `GET ${URL} failed with 503 after 6 attempts`,
      );
      expect({ calls: network.calls(), sleeps: network.sleeps }).toEqual({ calls: 6, sleeps });
    },
  );

  it("waits as long as Retry-After asks, never less than the backoff, and at most 30 s", async () => {
    const network = scripted([
      { status: 429, retryAfter: "3" },
      { status: 503, retryAfter: "0" },
      { status: 503, retryAfter: "120" },
      { status: 503, retryAfter: new Date(NOW + 10_000).toUTCString() },
      OK,
    ]);

    const fetched = await fetchWithRetry(URL, network.network);

    expect({ status: fetched.status, sleeps: network.sleeps }).toEqual({
      status: OK,
      sleeps: [3000, 2000, 30_000, 10_000],
    });
  });
});
