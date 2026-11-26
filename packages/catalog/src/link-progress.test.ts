import { afterEach, expect, it, vi } from "vitest";
import {
  LINK_PROGRESS_SHARE_EVERY_MS,
  LinkProgress,
  reportingProgress,
  type LinkChannel,
} from "./link-progress.ts";

const opened: BroadcastChannel[] = [];
let channels = 0;

function channelPair(): [BroadcastChannel, BroadcastChannel] {
  channels += 1;
  const name = `link-progress-test-${channels}`;
  const pair: [BroadcastChannel, BroadcastChannel] = [
    new BroadcastChannel(name),
    new BroadcastChannel(name),
  ];
  opened.push(...pair);
  return pair;
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.close();
  vi.useRealTimers();
});

const encoder = new TextEncoder();
const STATUS_TEXT = "Not Found";

it("counts the headers and every chunk as progress and passes the response through unchanged", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const [own] = channelPair();
  const link = new LinkProgress(own);
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
  const response = reportingProgress(
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
  expect(link.quietMs()).toBe(0);
  const text = answered.text();
  for (let i = 0; i < chunks.length; i++) {
    await vi.advanceTimersByTimeAsync(chunkEveryMs / 2);
    expect(link.quietMs()).toBe(chunkEveryMs / 2);
    await vi.advanceTimersByTimeAsync(chunkEveryMs / 2);
    expect(link.quietMs()).toBe(0);
  }
  expect([answered.status, answered.statusText, answered.headers.get("x-mirror")]).toEqual([
    404,
    STATUS_TEXT,
    "raw",
  ]);
  await expect(text).resolves.toBe(chunks.join(""));
});

it("counts progress another context shares, and shares its own at most once a second", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const [own, other] = channelPair();
  const link = new LinkProgress(own);
  const shared: unknown[] = [];
  const allShared = new Promise<void>((done) =>
    other.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data === "end") done();
      else shared.push(event.data);
    }),
  );

  const burst = 10;
  for (let i = 0; i < burst; i++) {
    link.mark();
    await vi.advanceTimersByTimeAsync((LINK_PROGRESS_SHARE_EVERY_MS - 1) / burst);
  }
  await vi.advanceTimersByTimeAsync(1);
  link.mark();
  const ownSide: LinkChannel = own;
  ownSide.postMessage("end", []);
  await allShared;
  expect(shared).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(link.quietMs()).toBe(20_000);
  const heard = new Promise((done) => own.addEventListener("message", done, { once: true }));
  const otherSide: LinkChannel = other;
  otherSide.postMessage(null, []);
  await heard;
  expect(link.quietMs()).toBe(0);
});
