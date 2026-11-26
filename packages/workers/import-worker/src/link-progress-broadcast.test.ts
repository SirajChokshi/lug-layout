import { LINK_PROGRESS } from "@brr/catalog";
import type { RpcPort } from "@brr/rpc";
import { Container } from "inversify";
import { expect, it, vi } from "vitest";
import { importWorkerModules } from "./import-worker.module.ts";

const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };

function workerLinkProgress() {
  const container = new Container();
  container.load(...importWorkerModules(idlePort));
  return container.get(LINK_PROGRESS);
}

it("carries one worker's link progress to another through the versioned broadcast", async () => {
  const reading = workerLinkProgress();
  const waiting = workerLinkProgress();
  expect([reading.silenceMs(), waiting.silenceMs()]).toEqual([Infinity, Infinity]);

  reading.markProgress();

  await vi.waitFor(() => expect(waiting.silenceMs()).toBeLessThan(Infinity));
});
