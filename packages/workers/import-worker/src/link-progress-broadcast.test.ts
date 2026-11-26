import { LINK_PROGRESS, LINK_PROGRESS_SHARE } from "@brr/catalog";
import type { RpcPort } from "@brr/rpc";
import { Container } from "inversify";
import { expect, it, vi } from "vitest";
import { importWorkerModules } from "./import-worker.module.ts";

const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };

function workerContainer(): Container {
  const container = new Container();
  container.load(...importWorkerModules(idlePort));
  return container;
}

it("carries one worker's link progress to every listener in another worker through the versioned broadcast", async () => {
  const reading = workerContainer().get(LINK_PROGRESS);
  const waitingWorker = workerContainer();
  const waiting = waitingWorker.get(LINK_PROGRESS);
  let heardBySecondListener = 0;
  waitingWorker.get(LINK_PROGRESS_SHARE).listen(() => {
    heardBySecondListener += 1;
  });
  expect([reading.silenceMs(), waiting.silenceMs()]).toEqual([Infinity, Infinity]);

  reading.markProgress();

  await vi.waitFor(() => expect(waiting.silenceMs()).toBeLessThan(Infinity));
  expect(heardBySecondListener).toBe(1);
});
