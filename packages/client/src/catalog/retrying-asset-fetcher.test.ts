import {
  ASSET_FETCHER,
  AssetResponseError,
  AssetStalledError,
  LINK_PROGRESS_SHARE,
  LINK_SILENCE_LIMIT_MS,
  NETWORK_ASSET_FETCHER,
  type IAssetFetcher,
} from "@brr/catalog";
import { Container } from "inversify";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { silentPeers } from "./silent-peers.test-support.ts";

const BUCKET = "https://bucket.test/";
const PART = "standard/part.0123456789abcdef.glb";
const WHOLE_FILE = "the whole file";
const ALL_WAITS_MS = 31_000;
const utf8 = new TextEncoder();

type Attempt = () => Promise<ArrayBuffer>;

const whole: Attempt = async () => utf8.encode(WHOLE_FILE).buffer;
const networkError: Attempt = async () => {
  throw new TypeError("Failed to fetch");
};

const stall: Attempt = async () => {
  throw new AssetStalledError(`${BUCKET}${PART}`, LINK_SILENCE_LIMIT_MS);
};

function refused(status: number, retryAfterMs: number | null = null): Attempt {
  return async () => {
    throw new AssetResponseError(`${BUCKET}${PART}`, status, retryAfterMs);
  };
}

class ScriptedNetwork implements IAssetFetcher {
  readonly startedAtMs: number[] = [];
  private readonly startMs = performance.now();

  constructor(private readonly attempts: ReadonlyArray<Attempt>) {}

  bytes(): Promise<ArrayBuffer> {
    const attempt = this.attempts[Math.min(this.startedAtMs.length, this.attempts.length - 1)];
    this.startedAtMs.push(performance.now() - this.startMs);
    return (attempt ?? whole)();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }
}

function bundleFetcher(network?: IAssetFetcher): IAssetFetcher {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: BUCKET,
      bundleManifestFile: "manifest.0123456789abcdef.json",
      disclaimer: "unused",
    }),
  );
  container.rebind(LINK_PROGRESS_SHARE).toConstantValue(silentPeers);
  if (network !== undefined) container.rebind(NETWORK_ASSET_FETCHER).toConstantValue(network);
  return container.get(ASSET_FETCHER);
}

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads a bundle file again after a network error, a 429 or a 503, and returns the bytes a first read returns", async () => {
  fakeClock();
  for (const failure of [networkError, refused(429), refused(503)]) {
    const network = new ScriptedNetwork([failure, whole]);
    const reading = bundleFetcher(network).text(PART);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reading).resolves.toBe(WHOLE_FILE);
    expect(network.startedAtMs).toEqual([0, 1_000]);
  }
});

it("waits 1, 2, 4, 8 and 16 s between attempts, and fails with the sixth attempt's error", async () => {
  fakeClock();
  const network = new ScriptedNetwork([refused(503)]);
  const outcome = bundleFetcher(network)
    .bytes(PART)
    .catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(ALL_WAITS_MS);

  expect(network.startedAtMs).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
  expect(await outcome).toMatchObject({ status: 503 });
});

it("reads a 404, a 500, a stall, and a network error while the browser is offline only once", async () => {
  fakeClock();
  for (const { failure, offline } of [
    { failure: refused(404), offline: false },
    { failure: refused(500), offline: false },
    { failure: stall, offline: false },
    { failure: networkError, offline: true },
  ]) {
    if (offline) vi.stubGlobal("navigator", { onLine: false });
    const network = new ScriptedNetwork([failure, whole]);
    const outcome = bundleFetcher(network)
      .bytes(PART)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ALL_WAITS_MS);
    expect(await outcome).toBeInstanceOf(Error);
    expect(network.startedAtMs).toEqual([0]);
  }
});

it("waits as long as a Retry-After asks, and fails at once when that would take the waits past 31 s", async () => {
  fakeClock();
  const asked = new ScriptedNetwork([refused(429, 5_000), whole]);
  const reading = bundleFetcher(asked).text(PART);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(asked.startedAtMs).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(reading).resolves.toBe(WHOLE_FILE);

  const tooLong = new ScriptedNetwork([refused(503, 32_000), whole]);
  await expect(bundleFetcher(tooLong).text(PART)).rejects.toMatchObject({ status: 503 });
  expect(tooLong.startedAtMs).toEqual([0]);
});

type Answer = (init: RequestInit) => Promise<Response>;

function answers(sequence: ReadonlyArray<Answer>): { readonly startedAtMs: number[] } {
  const startedAtMs: number[] = [];
  const startMs = performance.now();
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    const answer = sequence[Math.min(startedAtMs.length, sequence.length - 1)];
    startedAtMs.push(performance.now() - startMs);
    return answer === undefined ? Promise.resolve(new Response(WHOLE_FILE)) : answer(init);
  });
  return { startedAtMs };
}

const wholeResponse: Answer = async () => new Response(WHOLE_FILE);
const hung: Answer = (init) =>
  new Promise((_answer, refuse) =>
    init.signal?.addEventListener("abort", () => refuse(new DOMException("aborted", "AbortError"))),
  );

function tooManyRequests(retryAfter: string): Answer {
  return async () => new Response(null, { status: 429, headers: { "Retry-After": retryAfter } });
}

it("reads a body cut off by a network error again from the start, and keeps none of the cut-off bytes", async () => {
  fakeClock();
  let pulls = 0;
  const cutOff: Answer = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(utf8.encode(WHOLE_FILE.slice(0, 5)));
          else controller.error(new TypeError("network error"));
        },
      }),
    );
  const { startedAtMs } = answers([cutOff, wholeResponse]);
  const reading = bundleFetcher().bytes(PART);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(new Uint8Array(await reading)).toEqual(utf8.encode(WHOLE_FILE));
  expect(startedAtMs).toEqual([0, 1_000]);
});

it("reads Retry-After from a response in seconds, and falls back to the schedule for an HTTP date", async () => {
  fakeClock();
  for (const [retryAfter, waitMs] of [
    ["5", 5_000],
    ["Fri, 27 Nov 2099 00:00:05 GMT", 1_000],
  ] as const) {
    const { startedAtMs } = answers([tooManyRequests(retryAfter), wholeResponse]);
    const reading = bundleFetcher().text(PART);
    await vi.advanceTimersByTimeAsync(waitMs);
    await expect(reading).resolves.toBe(WHOLE_FILE);
    expect(startedAtMs).toEqual([0, waitMs]);
  }
});

it("doesn't count a wait between attempts as silence: the next attempt still waits 50 s of its own", async () => {
  fakeClock();
  const refusedAtMs = LINK_SILENCE_LIMIT_MS - 1_000;
  const refusedLate: Answer = () =>
    new Promise((_answer, refuse) =>
      setTimeout(() => refuse(new TypeError("Failed to fetch")), refusedAtMs),
    );
  const { startedAtMs } = answers([refusedLate, hung]);
  let settled = false;
  const outcome = bundleFetcher()
    .bytes(PART)
    .catch((error: unknown) => error)
    .finally(() => (settled = true));
  const secondStartMs = refusedAtMs + 1_000;

  await vi.advanceTimersByTimeAsync(secondStartMs + LINK_SILENCE_LIMIT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  expect(await outcome).toBeInstanceOf(AssetStalledError);
  expect(startedAtMs).toEqual([0, secondStartMs]);
});
