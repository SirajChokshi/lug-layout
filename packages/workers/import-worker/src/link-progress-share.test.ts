import { LINK_PROGRESS, LINK_PROGRESS_SHARE } from "@brr/catalog/link-progress";
import { LINK_PROGRESS_PROTOCOL, RpcEndpoint, type RpcPort } from "@brr/rpc";
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

it("ignores messages on the broadcast that aren't link progress envelopes, and still carries the envelope sent after them", async () => {
  const waiting = workerContainer().get(LINK_PROGRESS);
  const { name, version } = LINK_PROGRESS_PROTOCOL;
  const stranger = new BroadcastChannel(`${name}.v${version}`);
  const strangerPort: RpcPort = stranger;
  strangerPort.postMessage({ kind: "progress" }, []);
  strangerPort.postMessage({ protocol: name, version }, []);
  new RpcEndpoint(strangerPort, LINK_PROGRESS_PROTOCOL).post({ kind: "progress" });

  await vi.waitFor(() => expect(waiting.silenceMs()).toBeLessThan(Infinity));
  stranger.close();
});
