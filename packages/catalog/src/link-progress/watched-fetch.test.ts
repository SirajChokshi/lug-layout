import { afterEach, expect, it, vi } from "vitest";
import { LinkProgress } from "./link-progress.ts";
import { Peers } from "./link-progress.test-support.ts";
import { watchedFetch } from "./watched-fetch.ts";

afterEach(() => {
  vi.useRealTimers();
});

const MIRROR_FILE = "https://mirror.test/ldraw/parts/3023b.dat";
const STATUS_TEXT = "Not Found";
const encoder = new TextEncoder();

it("answers once the whole body is in, with the server's status, status text, headers and bytes, counting the headers and each chunk as progress and leaving no timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const link = new LinkProgress(new Peers());
  const chunks = ["404: ", "Not ", "Found"];
  const headersAfterMs = 4_000;
  const chunkEveryMs = 1_000;
  const pacedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk, i) =>
        setTimeout(
          () => {
            controller.enqueue(encoder.encode(chunk));
            if (i === chunks.length - 1) controller.close();
          },
          headersAfterMs + chunkEveryMs * (i + 1),
        ),
      );
    },
  });
  const read = watchedFetch(
    () =>
      new Promise((answer) =>
        setTimeout(
          () =>
            answer(
              new Response(pacedBody, {
                status: 404,
                statusText: STATUS_TEXT,
                headers: { "x-mirror": "raw" },
              }),
            ),
          headersAfterMs,
        ),
      ),
    link,
  )(MIRROR_FILE);
  let answered = false;
  void read.then(() => (answered = true));

  await vi.advanceTimersByTimeAsync(headersAfterMs);
  expect(link.silenceMs()).toBe(0);
  for (let i = 0; i < chunks.length; i++) {
    await vi.advanceTimersByTimeAsync(chunkEveryMs / 2);
    expect([answered, link.silenceMs()]).toEqual([false, chunkEveryMs / 2]);
    await vi.advanceTimersByTimeAsync(chunkEveryMs / 2);
    expect(link.silenceMs()).toBe(0);
  }

  const response = await read;
  expect(vi.getTimerCount()).toBe(0);
  expect([response.status, response.statusText, response.headers.get("x-mirror")]).toEqual([
    404,
    STATUS_TEXT,
    "raw",
  ]);
  await expect(response.text()).resolves.toBe(chunks.join(""));
});
