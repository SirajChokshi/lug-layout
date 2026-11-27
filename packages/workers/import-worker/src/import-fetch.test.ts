import { LINK_PROGRESS_SHARE } from "@brr/catalog/link-progress";
import type { RpcPort } from "@brr/rpc";
import { Container } from "inversify";
import { afterEach, expect, it, vi } from "vitest";
import { importWorkerModules } from "./import-worker.module.ts";
import { IMPORT_FETCH } from "./tokens.ts";

const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };
const FILE = "https://bucket.test/library-connectors/connectivity-3755a.0123456789abcdef.json";
const ALL_WAITS_MS = 31_000;

function importFetch(): (url: string) => Promise<Response> {
  const container = new Container();
  container.load(...importWorkerModules(idlePort));
  container.rebind(LINK_PROGRESS_SHARE).toConstantValue({
    share: () => undefined,
    listen: () => undefined,
  });
  return container.get(IMPORT_FETCH);
}

function answering(statuses: ReadonlyArray<number | "network error">): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const answer = statuses[Math.min(calls, statuses.length - 1)] ?? "network error";
    calls += 1;
    if (answer === "network error") throw new TypeError("Failed to fetch");
    return new Response(`answered ${answer}`, { status: answer });
  });
  return { calls: () => calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads a file again after a network error or a 429, as the page's bundle reads do, and hands back a 404 at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  for (const failure of ["network error", 429] as const) {
    const network = answering([failure, 200]);
    const reading = importFetch()(FILE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await (await reading).text()).toBe("answered 200");
    expect(network.calls()).toBe(2);
  }
  const missing = answering([404, 200]);
  expect((await importFetch()(FILE)).status).toBe(404);
  expect(missing.calls()).toBe(1);
});

it("hands back the sixth 503 as the response, for the worker's own message", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const network = answering([503]);
  const reading = importFetch()(FILE);
  await vi.advanceTimersByTimeAsync(ALL_WAITS_MS);
  expect((await reading).status).toBe(503);
  expect(network.calls()).toBe(6);
});
