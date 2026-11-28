import { LINK_PROGRESS_SHARE } from "@brr/catalog/link-progress";
import type { RpcPort } from "@brr/rpc";
import { Container } from "inversify";
import { afterEach, expect, it, vi } from "vitest";
import { importWorkerModules } from "./import-worker.module.ts";
import { SharedProgress } from "./shared-progress.test-support.ts";
import { IMPORT_FETCH } from "./tokens.ts";

const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };
const RECORD_FILE =
  "https://bucket.test/library-connectors/connectivity-3755a.0123456789abcdef.json";
const MIRROR_FILE =
  "https://ldraw-library.test/kulits/ldraw-parts/c70360d1c588be894997b2168c61909bc8058c4d/ldraw/parts/3023b.dat";
const ALL_WAITS_MS = 31_000;
const SILENCE_LIMIT_MS = 55_000;

function importFetch(): (url: string) => Promise<Response> {
  const container = new Container();
  container.load(...importWorkerModules(idlePort));
  container.rebind(LINK_PROGRESS_SHARE).toConstantValue(new SharedProgress());
  return container.get(IMPORT_FETCH);
}

type Answer = number | "network error" | "cut body";

function cutBody(): Response {
  let pulls = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("answ"));
        else controller.error(new TypeError("network error"));
      },
    }),
  );
}

function answering(answers: ReadonlyArray<Answer>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? "network error";
    calls += 1;
    if (answer === "network error") throw new TypeError("Failed to fetch");
    if (answer === "cut body") return cutBody();
    return new Response(`answered ${answer}`, { status: answer });
  });
  return { calls: () => calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads a file again after a network error, a 429 or a body cut off mid-read, as the page's bundle reads do, and hands back a 404 at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  for (const failure of ["network error", 429, "cut body"] as const) {
    const network = answering([failure, 200]);
    const reading = importFetch()(RECORD_FILE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await (await reading).text()).toBe("answered 200");
    expect(network.calls()).toBe(2);
  }
  const missing = answering([404, 200]);
  expect((await importFetch()(RECORD_FILE)).status).toBe(404);
  expect(missing.calls()).toBe(1);
});

it("hands back the sixth 503 as the response, for the worker's own message", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const network = answering([503]);
  const reading = importFetch()(RECORD_FILE);
  await vi.advanceTimersByTimeAsync(ALL_WAITS_MS);
  expect((await reading).status).toBe(503);
  expect(network.calls()).toBe(6);
});

it("fails an import worker read that hears nothing on the link for 55 s, naming the file and aborting the request", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let aborted = false;
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_answer, refuse) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          refuse(new DOMException("aborted", "AbortError"));
        });
      }),
  );
  const read = importFetch()(MIRROR_FILE);
  let settled = false;
  read.then(
    () => (settled = true),
    () => (settled = true),
  );

  await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(read).rejects.toMatchObject({
    url: MIRROR_FILE,
    message: `GET ${MIRROR_FILE} sent nothing for 55 s`,
  });
  expect(aborted).toBe(true);
});
