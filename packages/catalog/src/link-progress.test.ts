import { afterEach, expect, it, vi } from "vitest";
import {
  LINK_PROGRESS_MIN_SHARE_GAP_MS,
  LinkProgress,
  reportingFetch,
  type ILinkShare,
} from "./link-progress.ts";

class OtherContexts implements ILinkShare {
  shared = 0;
  private readonly listeners: Array<() => void> = [];

  share(): void {
    this.shared += 1;
  }

  onShared(listener: () => void): void {
    this.listeners.push(listener);
  }

  report(): void {
    for (const listener of this.listeners) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

const encoder = new TextEncoder();
const STATUS_TEXT = "Not Found";

it("counts the headers and every chunk as they arrive, and passes the response through unchanged", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const link = new LinkProgress(new OtherContexts());
  const chunks = ["0 FILE ", "parts/", "3001.dat"];
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
  const response = reportingFetch(
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
  )("https://mirror.test/parts/3001.dat");

  await vi.advanceTimersByTimeAsync(headersAfterMs);
  const answered = await response;
  expect(link.silenceMs()).toBe(0);
  const text = answered.text();
  for (let i = 0; i < chunks.length; i++) {
    await vi.advanceTimersByTimeAsync(chunkEveryMs / 2);
    expect(link.silenceMs()).toBe(chunkEveryMs / 2);
    await vi.advanceTimersByTimeAsync(chunkEveryMs / 2);
    expect(link.silenceMs()).toBe(0);
  }
  expect([answered.status, answered.statusText, answered.headers.get("x-mirror")]).toEqual([
    404,
    STATUS_TEXT,
    "raw",
  ]);
  await expect(text).resolves.toBe(chunks.join(""));
});

it("shares a burst of progress once per gap, and counts what another context shares", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const others = new OtherContexts();
  const link = new LinkProgress(others);
  const burst = 9;
  const step = Math.floor(LINK_PROGRESS_MIN_SHARE_GAP_MS / (burst + 1));

  for (let i = 0; i < burst; i++) {
    link.markProgress();
    await vi.advanceTimersByTimeAsync(step);
  }
  expect(others.shared).toBe(1);
  await vi.advanceTimersByTimeAsync(LINK_PROGRESS_MIN_SHARE_GAP_MS - burst * step);
  link.markProgress();
  expect(others.shared).toBe(2);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(link.silenceMs()).toBe(20_000);
  others.report();
  expect(link.silenceMs()).toBe(0);
  expect(others.shared).toBe(2);
});
