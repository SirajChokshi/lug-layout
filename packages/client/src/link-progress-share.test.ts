import { LINK_PROGRESS } from "@brr/catalog";
import { Container } from "inversify";
import { expect, it, vi } from "vitest";
import { mainThreadModules } from "./client.module.ts";

function tab() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  return container.get(LINK_PROGRESS);
}

it("carries one tab's link progress to another tab's main thread through the broadcast it binds", async () => {
  const reading = tab();
  const waiting = tab();
  expect(waiting.silenceMs()).toBe(Infinity);

  reading.markProgress();

  await vi.waitFor(() => expect(waiting.silenceMs()).toBeLessThan(Infinity));
});
