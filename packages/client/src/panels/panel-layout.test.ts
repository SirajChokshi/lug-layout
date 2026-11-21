import type { PanelLayout } from "@brr/schema/panels";
import { Container } from "inversify";
import { afterEach, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { PANEL_LAYOUT, PANEL_LAYOUT_STORE } from "../tokens.ts";
import {
  DEFAULT_PANEL_LAYOUT,
  LocalStoragePanelLayoutStore,
  readPanelLayout,
  type IPanelLayoutStore,
} from "./panel-layout.ts";

class MemoryStore implements IPanelLayoutStore {
  saved: PanelLayout | null = null;

  load(): PanelLayout {
    return this.saved ?? DEFAULT_PANEL_LAYOUT;
  }

  save(layout: PanelLayout): void {
    this.saved = layout;
  }
}

function openEditor(store: IPanelLayoutStore) {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  container.rebind(PANEL_LAYOUT_STORE).toConstantValue(store);
  return container.get(PANEL_LAYOUT);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

it("opens with the library shown and the stats folded, and a folded library stays folded on the next visit", () => {
  const store = new MemoryStore();
  const first = openEditor(store);
  expect(first.snapshot()).toEqual({ version: 1, library: true, stats: false });

  let notified = 0;
  first.subscribe(() => notified++);
  first.setOpen("library", false);
  first.setOpen("library", false);
  expect(notified).toBe(1);

  expect(openEditor(store).snapshot()).toEqual({ version: 1, library: false, stats: false });
});

it("reads a saved layout and falls back to the default from anything it can't trust", () => {
  const saved = { version: 1, library: false, stats: true };
  expect(readPanelLayout(JSON.stringify(saved))).toEqual(saved);
  expect(readPanelLayout(null)).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(readPanelLayout("{not json")).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(readPanelLayout(JSON.stringify({ ...saved, version: 2 }))).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(readPanelLayout(JSON.stringify({ ...saved, library: "no" }))).toEqual(
    DEFAULT_PANEL_LAYOUT,
  );
});

it("keeps the default layout when the browser blocks site data", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  const store = new LocalStoragePanelLayoutStore();
  expect(store.load()).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(() => store.save({ ...DEFAULT_PANEL_LAYOUT, library: false })).not.toThrow();
});
