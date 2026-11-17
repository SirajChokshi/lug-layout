import { expect, it } from "vitest";
import type { CatalogItemView } from "../edit/editor.ts";
import { PaletteIndex } from "./palette-index.ts";

const GREEN = { code: 2, name: "Green", rgb: "#237841" };
const DARK_GREEN = { code: 288, name: "Dark_Green", rgb: "#184632" };
const TAN = { code: 19, name: "Tan", rgb: "#E4CD9E" };
const LIGHT_GREY = { code: 151, name: "Very_Light_Bluish_Grey", rgb: "#E6E3E0" };
const DARK_GREY = { code: 72, name: "Dark_Bluish_Grey", rgb: "#6C6E68" };

function plate(
  id: string,
  title: string,
  kind: "baseplate" | "road-plate",
  studs: number,
  colors: ReadonlyArray<CatalogItemView["color"] & object>,
): ReadonlyArray<CatalogItemView> {
  return colors.map((color) => ({
    id: `ldraw:${id}@${color.code}`,
    label: `${id} ${title}, ${color.name}`,
    group: `ldraw:${id}`,
    groupLabel: `${id} ${title}`,
    color,
    kind,
    parts: 1,
    studsWide: studs,
    studsDeep: studs,
    thumbnail: null,
    baseplate: null,
  }));
}

const catalog: ReadonlyArray<CatalogItemView> = [
  ...plate("4186", "Baseplate 48 x 48", "baseplate", 48, [GREEN, TAN, LIGHT_GREY]),
  ...plate("3811", "Baseplate 32 x 32", "baseplate", 32, [GREEN, DARK_GREEN, TAN, DARK_GREY]),
  ...plate("3867", "Baseplate 16 x 16", "baseplate", 16, [GREEN, DARK_GREY]),
  ...plate("44336p03", "Baseplate 32 x 32 Road 6-Stud Runway", "road-plate", 32, [DARK_GREY]),
  ...plate("2358p02", "Baseplate 48 x 48 Road Crossroads", "road-plate", 48, [DARK_GREY]),
  {
    id: "omr:7938-1",
    label: "7938-1 Passenger Train",
    group: "omr:7938-1",
    groupLabel: "7938-1 Passenger Train",
    color: null,
    kind: "model",
    parts: 663,
    studsWide: 8,
    studsDeep: 90,
    thumbnail: null,
    baseplate: null,
  },
  {
    id: "track:lego-9v",
    label: "Track: 9V straights and R40 curves",
    group: "track:lego-9v",
    groupLabel: "Track: 9V straights and R40 curves",
    color: null,
    kind: "track",
    parts: 2,
    studsWide: 16,
    studsDeep: 8,
    thumbnail: null,
    baseplate: null,
  },
];

const index = new PaletteIndex(catalog, [
  { entryKey: "track:lego-9v", terms: ["2865", "Train Track 9V Straight", "2867"] },
]);

function keys(query: string, filter: Parameters<PaletteIndex["search"]>[1] = "all") {
  return index.search(query, filter).map((hit) => hit.entry.key);
}

function colorsOf(query: string, key: string) {
  return index
    .search(query, "all")
    .find((hit) => hit.entry.key === key)
    ?.items.map((item) => item.color?.name);
}

it("ranks an exact part number above parts that only contain it", () => {
  expect(keys("3811")[0]).toBe("ldraw:3811");
  expect(keys("44336")).toEqual(["ldraw:44336p03"]);
  expect(keys("2865")).toEqual(["track:lego-9v"]);
});

it("matches a size however it is written, in either order", () => {
  const sixteen = ["ldraw:3867"];
  expect(keys("16x16")).toEqual(sixteen);
  expect(keys("16×16")).toEqual(sixteen);
  expect(keys("16 x 16")).toEqual(sixteen);
  expect(keys("8x90")).toEqual(["omr:7938-1"]);
  expect(keys("90x8")).toEqual(["omr:7938-1"]);
});

it("narrows a part to the colours a colour word names, and drops parts without one", () => {
  expect(colorsOf("green 32x32", "ldraw:3811")).toEqual(["Green", "Dark_Green"]);
  expect(colorsOf("dark green", "ldraw:3811")).toEqual(["Dark_Green"]);
  expect(colorsOf("gray", "ldraw:4186")).toEqual(["Very_Light_Bluish_Grey"]);
  expect(keys("tan baseplate")).toEqual(["ldraw:4186", "ldraw:3811"]);
  expect(keys("dark green road")).toEqual([]);
});

it("keeps every colour when the words describe the part, not a colour", () => {
  expect(colorsOf("baseplate 32", "ldraw:3811")).toHaveLength(4);
});

it("forgives typos and abbreviations but ranks exact words first", () => {
  expect(keys("crosroads")).toEqual(["ldraw:2358p02"]);
  expect(keys("basplate 16")).toEqual(["ldraw:3867"]);
  expect(keys("runwy")).toEqual(["ldraw:44336p03"]);
  expect(keys("passenger")[0]).toBe("omr:7938-1");
});

it("reads quoted phrases, minus to exclude, and # for numbers only", () => {
  expect(keys('"road crossroads"')).toEqual(["ldraw:2358p02"]);
  expect(keys('"crossroads road"')).toEqual([]);
  expect(keys("baseplate -road")).toEqual(["ldraw:4186", "ldraw:3811", "ldraw:3867"]);
  expect(colorsOf("32x32 -dark", "ldraw:3811")).toEqual(["Green", "Tan"]);
  expect(keys('green -"dark green"')).toContain("ldraw:3811");
  expect(colorsOf('green -"dark green"', "ldraw:3811")).toEqual(["Green"]);
  expect(keys("#7938")).toEqual(["omr:7938-1"]);
  expect(keys("#32")).toEqual([]);
  expect(keys("32x32 -#3811")).toEqual(["ldraw:44336p03"]);
});

it("searches only the chosen category", () => {
  expect(keys("32", "road")).toEqual(["ldraw:44336p03"]);
  expect(keys("straight", "baseplates")).toEqual([]);
  expect(keys("", "sets")).toEqual(["omr:7938-1"]);
});
