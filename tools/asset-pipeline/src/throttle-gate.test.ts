import { describe, expect, it } from "vitest";
import { BUCKET_RETRY, type RetryClock } from "./fetch-retry.ts";
import { ThrottleGate } from "./throttle-gate.ts";

const OK = 200;
const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;
const SERVICE_UNAVAILABLE = 503;
const IN_FLIGHT = 16;
const ANSWERED_AFTER_MS = 40;

class SteppedClock implements RetryClock {
  nowMs = 0;
  readonly sleeps: number[] = [];

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.nowMs += ms;
  }

  random(): number {
    return 0.5;
  }

  now(): number {
    return this.nowMs;
  }
}

function connectTimeout(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
}

async function throttledPause(gate: ThrottleGate): Promise<number> {
  const sentAtMs = await gate.pass();
  gate.answered(sentAtMs, TOO_MANY_REQUESTS);
  return (await gate.pass()) - sentAtMs;
}

describe("ThrottleGate", () => {
  it("holds every request after a 429 for one pause, however many requests already in flight are throttled too", async () => {
    const clock = new SteppedClock();
    const gate = new ThrottleGate(clock, BUCKET_RETRY);
    const burst = await Promise.all(Array.from({ length: IN_FLIGHT }, () => gate.pass()));
    clock.nowMs = ANSWERED_AFTER_MS;
    for (const sentAtMs of burst) gate.answered(sentAtMs, TOO_MANY_REQUESTS);

    expect(await gate.pass()).toBe(ANSWERED_AFTER_MS + BUCKET_RETRY.baseDelayMs);
    expect(clock.sleeps).toEqual([BUCKET_RETRY.baseDelayMs]);
  });

  it.each<readonly [string, () => Promise<Response>]>([
    ["a 429", async () => new Response(null, { status: TOO_MANY_REQUESTS })],
    ["a 503", async () => new Response(null, { status: SERVICE_UNAVAILABLE })],
    [
      "a connection that times out",
      async () => {
        throw connectTimeout();
      },
    ],
  ])("pauses every later request after %s answers one sent through it", async (_, request) => {
    const clock = new SteppedClock();
    const gate = new ThrottleGate(clock, BUCKET_RETRY);
    await gate.send(request).catch(() => undefined);

    expect(await gate.pass()).toBe(BUCKET_RETRY.baseDelayMs);
  });

  it("doesn't pause for a failure that isn't transient, and rethrows it", async () => {
    const clock = new SteppedClock();
    const gate = new ThrottleGate(clock, BUCKET_RETRY);
    const refused = new TypeError("Invalid URL");

    await expect(
      gate.send(async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect(await gate.pass()).toBe(0);
  });

  it.each([OK, NOT_FOUND])(
    "doubles the pause while requests sent after it are throttled again, up to the cap, until a %i answer resets it",
    async (answer) => {
      const gate = new ThrottleGate(new SteppedClock(), BUCKET_RETRY);
      const pauses: number[] = [];
      for (let episode = 0; episode < 8; episode++) pauses.push(await throttledPause(gate));
      gate.answered(await gate.pass(), answer);
      pauses.push(await throttledPause(gate));

      expect(pauses).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 1000]);
    },
  );

  it("doesn't reset the pause on an answer to a request sent before the latest 429", async () => {
    const clock = new SteppedClock();
    const gate = new ThrottleGate(clock, BUCKET_RETRY);
    const early = await gate.pass();
    expect(await throttledPause(gate)).toBe(1000);
    gate.answered(early, OK);

    expect(await throttledPause(gate)).toBe(2000);
  });
});
