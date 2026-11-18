import { afterEach, expect, it } from "vitest";
import {
  EMPTY_PALETTE_MEMORY,
  LocalStoragePaletteMemoryStore,
  RECENT_LIMIT,
  readPaletteMemory,
  withFavoriteToggled,
  withRecent,
} from "./palette-memory.ts";

it("keeps recents newest first, once each, and only the last few", () => {
  let memory = EMPTY_PALETTE_MEMORY;
  for (const id of ["a", "b", "a", "c"]) memory = withRecent(memory, id);
  expect(memory.recents).toEqual(["c", "a", "b"]);
  for (let i = 0; i < RECENT_LIMIT + 3; i++) memory = withRecent(memory, `p${i}`);
  expect(memory.recents).toHaveLength(RECENT_LIMIT);
  expect(memory.recents[0]).toBe(`p${RECENT_LIMIT + 2}`);
});

it("toggles a favourite on and off without disturbing the others", () => {
  const one = withFavoriteToggled(withFavoriteToggled(EMPTY_PALETTE_MEMORY, "x"), "y");
  expect(one.favorites).toEqual(["x", "y"]);
  expect(withFavoriteToggled(one, "x").favorites).toEqual(["y"]);
});

it("reads a saved record and starts empty from anything it can't trust", () => {
  const saved = { version: 1, favorites: ["ldraw:3811"], recents: ["ldraw:3811@2"] };
  expect(readPaletteMemory(JSON.stringify(saved))).toEqual(saved);
  expect(readPaletteMemory(null)).toEqual(EMPTY_PALETTE_MEMORY);
  expect(readPaletteMemory("{not json")).toEqual(EMPTY_PALETTE_MEMORY);
  expect(readPaletteMemory(JSON.stringify({ ...saved, version: 2 }))).toEqual(EMPTY_PALETTE_MEMORY);
  expect(readPaletteMemory(JSON.stringify({ ...saved, extra: 1 }))).toEqual(EMPTY_PALETTE_MEMORY);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

it("starts empty and keeps working when the browser blocks site data", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  const store = new LocalStoragePaletteMemoryStore();
  expect(store.load()).toEqual(EMPTY_PALETTE_MEMORY);
  expect(() => store.save(withRecent(EMPTY_PALETTE_MEMORY, "ldraw:3811@2"))).not.toThrow();
});

it("drops a save the storage refuses, such as a full quota", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
    },
  });
  expect(() =>
    new LocalStoragePaletteMemoryStore().save(withRecent(EMPTY_PALETTE_MEMORY, "a")),
  ).not.toThrow();
});
