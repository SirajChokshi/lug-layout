import { LINK_PROGRESS } from "@brr/catalog";
import { Container } from "inversify";
import { expect, it, vi } from "vitest";
import { mainThreadModules } from "./client.module.ts";

function tabContainer(): Container {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  return container;
}

it("carries one tab's link progress to another tab's main thread through the broadcast it binds", async () => {
  const reading = tabContainer().get(LINK_PROGRESS);
  const waiting = tabContainer().get(LINK_PROGRESS);
  expect(waiting.silenceMs()).toBe(Infinity);

  reading.markProgress();

  await vi.waitFor(() => expect(waiting.silenceMs()).toBeLessThan(Infinity));
});
