import { LIBRARY_PARTS_FORMAT, type BundleColor } from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { LibraryPartIndex } from "./library-part-index.ts";
import { LibraryQuery } from "./library-query.ts";

interface Part {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly rebrickable?: string;
  readonly colors: ReadonlyArray<number>;
}

const COLORS: ReadonlyArray<BundleColor> = [
  { code: 1, name: "Blue", rgb: "#1E5AA8", alpha: 255 },
  { code: 2, name: "Green", rgb: "#00852B", alpha: 255 },
  { code: 4, name: "Red", rgb: "#B40000", alpha: 255 },
  { code: 15, name: "White", rgb: "#F4F4F4", alpha: 255 },
  { code: 71, name: "Light_Bluish_Grey", rgb: "#A0A5A9", alpha: 255 },
];

const PARTS: ReadonlyArray<Part> = [
  { id: "2456", title: "Brick  2 x  6", category: "Brick", colors: [4, 15] },
  { id: "3001", title: "Brick  2 x  4", category: "Brick", colors: [4, 15, 1, 71] },
  {
    id: "3001p11",
    title: "Brick  2 x  4 with Black Stripes Pattern",
    category: "Brick",
    colors: [15],
  },
  { id: "3010", title: "Brick  1 x  4", category: "Brick", colors: [4] },
  {
    id: "3020",
    title: "Plate  2 x  4",
    category: "Plate",
    keywords: ["Bricklink 3020b"],
    colors: [4, 71],
  },
  {
    id: "3471",
    title: "Plant Tree Pyramidal 4 x 4 x 6.667 Type 1",
    category: "Plant",
    keywords: ["pine", "Christmas"],
    colors: [2],
  },
  { id: "3633", title: "Fence Lattice  1 x  4 x  1", category: "Fence", colors: [15, 4] },
  {
    id: "44343",
    title: "Baseplate 16 x 16 Road Street Pattern",
    category: "Baseplate",
    colors: [71],
  },
  { id: "4073", title: "Plate  1 x  1 Round", category: "Plate", rebrickable: "6141", colors: [4] },
  { id: "69858", title: "Flame 4L", category: "Plant", keywords: ["tree", "bush"], colors: [4] },
  { id: "3004", title: "Brick  1 x  2", category: "Brick", colors: [4, 15] },
  { id: "3004prc", title: "Brick  1 x  2 with Red Cross Pattern", category: "Brick", colors: [15] },
  {
    id: "4066bp2i",
    title: "Duplo Brick  1 x  2 x  2 with Pineapples Pattern",
    category: "Duplo",
    colors: [15],
  },
];

function index(): LibraryPartIndex {
  const categories = [...new Set(PARTS.map((part) => part.category))].toSorted();
  return new LibraryPartIndex({
    colors: COLORS,
    file: {
      format: LIBRARY_PARTS_FORMAT,
      sources: {},
      categories,
      parts: {
        id: PARTS.map((part) => part.id),
        title: PARTS.map((part) => part.title),
        category: PARTS.map((part) => categories.indexOf(part.category)),
        keywords: PARTS.map((part) => [...(part.keywords ?? [])]),
        rebrickable: PARTS.map((part) => part.rebrickable ?? part.id),
        colorCount: PARTS.map((part) => part.colors.length),
        colors: PARTS.flatMap((part) => part.colors),
      },
    },
  });
}

const NOTHING: ReadonlySet<string> = new Set();

function ids(query: string, excluded = NOTHING): ReadonlyArray<string> {
  return index()
    .search(LibraryQuery.parse(query), 10, excluded)
    .hits.map((hit) => hit.part.id);
}

function colorsOf(query: string): ReadonlyArray<number> {
  return index()
    .search(LibraryQuery.parse(query), 1, NOTHING)
    .hits.flatMap((hit) => hit.colors.map((color) => color.code));
}

describe("library part search", () => {
  it.each([
    ["brick 2 x 4", ["3001", "3001p11"]],
    ["2x4 brick", ["3001", "3001p11"]],
    ["brick 4 x 2", ["3001", "3001p11"]],
    ["brick 4 x", ["3001", "3010", "3001p11"]],
    ["fen", ["3633"]],
  ])(
    "needs every word of %j to start a word of the part, and ranks shorter titles first",
    (query, expected) => {
      expect(ids(query)).toEqual(expected);
    },
  );

  it("matches part numbers, Rebrickable and BrickLink numbers and keywords, exactly or as a prefix", () => {
    expect(ids("3001")).toEqual(["3001", "3001p11"]);
    expect(ids("6141")).toEqual(["4073"]);
    expect(ids("3020b")).toEqual(["3020"]);
    expect(ids("christmas")).toEqual(["3471"]);
  });

  it("matches the start of words only, so a word inside another word finds nothing", () => {
    expect(ids("tree")).toEqual(["3471", "69858"]);
    expect(ids("ree")).toEqual([]);
  });

  it("ranks a word of the part's own title above the same word in its category or keywords, and an exact keyword above a title word it only starts", () => {
    expect(ids("tree")[0]).toBe("3471");
    expect(ids("pine")).toEqual(["3471", "4066bp2i"]);
  });

  it("ranks a part made in the named colour above a part whose title only mentions it", () => {
    expect(ids("red brick 1 x 2")).toEqual(["3004", "3004prc"]);
  });

  it("narrows the colours offered to the colour a word names, and drops parts never made in it", () => {
    expect(colorsOf("red brick 2 x 4")).toEqual([4]);
    expect(colorsOf("brick 2 x 4 gray")).toEqual([71]);
    expect(ids("green brick")).toEqual([]);
  });

  it("lists a part for a colour word alone only when its own title says it, and keeps every produced colour when no colour is named", () => {
    expect(ids("red")).toEqual(["3004prc"]);
    expect(colorsOf("brick 2 x 4")).toEqual([4, 15, 1, 71]);
  });

  it("reads quoted phrases in order and # as numbers only, and a minus before either excludes all of it, colour names included", () => {
    expect(ids('"brick 2 x 4"')).toEqual(["3001", "3001p11"]);
    expect(ids('"2 x 4 brick"')).toEqual([]);
    expect(ids("#6141")).toEqual(["4073"]);
    expect(ids("#brick")).toEqual([]);
    expect(ids("brick 2 x 4 -#3001p11")).toEqual(["3001"]);
    expect(ids('brick 2 x 4 -"black stripes"')).toEqual(["3001"]);
    expect(ids('brick 2 x 4 -"stripes black"')).toEqual(["3001", "3001p11"]);
    expect(colorsOf('brick 2 x 4 "light bluish"')).toEqual([71]);
    expect(colorsOf('brick 2 x 4 -"bluish grey"')).toEqual([4, 15, 1]);
  });

  it("leaves out parts whose word a minus excludes, and parts the caller already offers", () => {
    expect(ids("brick 2 x 4 -pattern")).toEqual(["3001"]);
    expect(ids("brick 2 x 4", new Set(["3001"]))).toEqual(["3001p11"]);
  });

  it("collapses LDraw's padded titles for display", () => {
    expect(index().part("3001")?.title).toBe("Brick 2 x 4");
  });
});
