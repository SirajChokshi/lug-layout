import { afterEach, expect, it, vi } from "vitest";
import { LINK_PROGRESS_MIN_SHARE_GAP_MS, LinkProgress } from "./link-progress.ts";
import { Peers } from "./link-progress.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("shares a burst of progress with its peers once per gap, and counts what a peer shares", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const peers = new Peers();
  const link = new LinkProgress(peers);
  const burst = 9;
  const step = Math.floor(LINK_PROGRESS_MIN_SHARE_GAP_MS / (burst + 1));

  for (let i = 0; i < burst; i++) {
    link.markProgress();
    await vi.advanceTimersByTimeAsync(step);
  }
  expect(peers.shared).toBe(1);
  await vi.advanceTimersByTimeAsync(LINK_PROGRESS_MIN_SHARE_GAP_MS - burst * step);
  link.markProgress();
  expect(peers.shared).toBe(2);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(link.silenceMs()).toBe(20_000);
  peers.deliverShare();
  expect(link.silenceMs()).toBe(0);
  expect(peers.shared).toBe(2);
});
