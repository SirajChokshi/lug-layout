import { afterEach, describe, expect, it } from "vitest";
import {
  LibraryFilters,
  LocalStorageLibraryFilterStore,
  NO_FILTER,
  readLibraryFilters,
} from "./library-filters.ts";

const TAN = 19;
const WHITE = 15;

function perTabSearches(): LibraryFilters {
  return LibraryFilters.DEFAULT.withScope("per-tab")
    .withTab("baseplates")
    .withQuery('"32 x 32"')
    .withColor(TAN)
    .withTab("track")
    .withQuery("9v");
}

describe("library filters", () => {
  it("gives each tab its own search and colour when searching per tab, and one search for every tab otherwise", () => {
    const perTab = perTabSearches();
    expect(perTab.current()).toEqual({ query: "9v", color: null });
    expect(perTab.filterOf("baseplates")).toEqual({ query: '"32 x 32"', color: TAN });
    expect(perTab.filterOf("road")).toEqual(NO_FILTER);
    expect(perTab.withTab("baseplates").current()).toEqual({ query: '"32 x 32"', color: TAN });

    const shared = LibraryFilters.DEFAULT.withTab("baseplates").withQuery("tan").withColor(WHITE);
    expect(shared.withTab("road").current()).toEqual({ query: "tan", color: WHITE });
    expect(shared.withTab("road").withQuery("").filterOf("baseplates")).toEqual({
      query: "",
      color: WHITE,
    });
  });

  it("keeps what the current tab shows when switching between one search and per-tab searches, and gives each tab its own search back", () => {
    const shared = perTabSearches().withScope("shared");
    expect(shared.current()).toEqual({ query: "9v", color: null });
    expect(shared.withTab("baseplates").current()).toEqual({ query: "9v", color: null });

    const again = shared.withTab("road").withQuery("crossroads").withScope("per-tab");
    expect(again.current()).toEqual({ query: "crossroads", color: null });
    expect(again.filterOf("baseplates")).toEqual({ query: '"32 x 32"', color: TAN });
    expect(again.filterOf("track")).toEqual({ query: "9v", color: null });
  });

  it("marks only the tabs whose own search or colour narrows them", () => {
    const filters = perTabSearches().withTab("road").withColor(WHITE).withColor(null);
    const tabs = ["all", "track", "baseplates", "road"] as const;
    expect(tabs.map((tab) => filters.filtered(tab))).toEqual([false, true, true, false]);
  });

  it("reads back what it saved, ignores tabs it doesn't know, and starts from the defaults on anything it can't trust", () => {
    const saved = perTabSearches();
    expect(readLibraryFilters(JSON.stringify(saved.toRecord()))).toEqual(saved);

    const record = {
      ...saved.toRecord(),
      tab: "club",
      tabs: { club: { query: "x", color: null } },
    };
    const unknownTabs = readLibraryFilters(JSON.stringify(record));
    expect(unknownTabs.tab).toBe("all");
    expect(unknownTabs.toRecord().tabs).toEqual({});

    for (const raw of [
      null,
      "{not json",
      JSON.stringify({ ...saved.toRecord(), version: 2 }),
      JSON.stringify({ ...saved.toRecord(), scope: "everywhere" }),
      JSON.stringify({ ...saved.toRecord(), shared: { query: "", color: 1.5 } }),
    ]) {
      expect(readLibraryFilters(raw)).toBe(LibraryFilters.DEFAULT);
    }
  });
});

describe("library filter store", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("saves to and loads from site storage", () => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    new LocalStorageLibraryFilterStore().save(perTabSearches());
    expect(new LocalStorageLibraryFilterStore().load()).toEqual(perTabSearches());
  });

  it("starts from the defaults and keeps working when the browser blocks site data or refuses a save", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(new LocalStorageLibraryFilterStore().load()).toBe(LibraryFilters.DEFAULT);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        },
      },
    });
    expect(() => new LocalStorageLibraryFilterStore().save(perTabSearches())).not.toThrow();
  });
});
