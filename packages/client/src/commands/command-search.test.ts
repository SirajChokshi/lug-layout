import { describe, expect, it } from "vitest";
import type { CatalogSearchView } from "../catalog/catalog-search.ts";
import { PaletteIndex } from "../catalog/palette-index.ts";
import type { CatalogItemView } from "../catalog/placeable-catalog.ts";
import { searchPalette, type PaletteResult } from "./command-search.ts";
import type { CommandId } from "./editor-commands.ts";

function baseplate(
  part: string,
  studs: number,
  code: number,
  colorName: string,
  rgb: string,
  elements: ReadonlyArray<string> = [],
): CatalogItemView {
  const title = `Baseplate ${studs} x ${studs}`;
  return {
    id: `ldraw:${part}@${code}`,
    label: `${part} ${title}, ${colorName}`,
    group: `ldraw:${part}`,
    shortLabel: `${part} ${studs}×${studs}`,
    groupLabel: `${part} ${title}`,
    color: { code, name: colorName, rgb },
    kind: "baseplate",
    parts: 1,
    studsWide: studs,
    studsDeep: studs,
    thumbnail: null,
    aliases: [],
    elements,
    displayColor: false,
    draggable: true,
    toggleable: false,
    listedUnder: null,
    customParts: 0,
    shelf: null,
  };
}

function roadPlate(part: string, title: string, studs: number, alias: string): CatalogItemView {
  return {
    id: `ldraw:${part}@72`,
    label: `${part} ${title}, Dark_Bluish_Grey`,
    group: `ldraw:${part}`,
    shortLabel: `${part} ${studs}×${studs}`,
    groupLabel: `${part} ${title}`,
    color: { code: 72, name: "Dark_Bluish_Grey", rgb: "#6C6E68" },
    kind: "road-plate",
    parts: 1,
    studsWide: studs,
    studsDeep: studs,
    thumbnail: null,
    aliases: [alias],
    elements: [],
    displayColor: false,
    draggable: true,
    toggleable: false,
    listedUnder: null,
    customParts: 0,
    shelf: null,
  };
}

const catalog: ReadonlyArray<CatalogItemView> = [
  baseplate("3811", 32, 10, "Bright_Green", "#58AB41"),
  baseplate("3811", 32, 2, "Green", "#00852B", ["381128", "4219692"]),
  baseplate("3811", 32, 1, "Blue", "#1E5AA8"),
  baseplate("3867", 16, 2, "Green", "#00852B"),
  {
    id: "ldraw:44336p01@2",
    label: "44336p01 Baseplate 32 x 32 Road 6-Stud Straight with Yellow Road Edge Pattern, Green",
    group: "ldraw:44336p01",
    shortLabel: "44336p01 32×32",
    groupLabel: "44336p01 Baseplate 32 x 32 Road 6-Stud Straight with Yellow Road Edge Pattern",
    color: { code: 2, name: "Green", rgb: "#00852B" },
    kind: "road-plate",
    parts: 1,
    studsWide: 32,
    studsDeep: 32,
    thumbnail: null,
    aliases: ["44336pr0001"],
    elements: [],
    displayColor: false,
    draggable: true,
    toggleable: false,
    listedUnder: null,
    customParts: 0,
    shelf: null,
  },
  roadPlate(
    "44336p03",
    "Baseplate 32 x 32 Road 6-Stud Straight with Runway Pattern",
    32,
    "44336pr0003",
  ),
  roadPlate("2358p02", "Baseplate 48 x 48 Road 7-Stud Crossroads", 48, "2358pr0002"),
  baseplate("4186", 48, 2, "Green", "#00852B"),
];

const index = new PaletteIndex(catalog);
const SERVER_OFF: CatalogSearchView = { query: "", status: "off", hits: [] };

function served(query: string, ids: ReadonlyArray<string>): CatalogSearchView {
  return {
    query,
    status: "ready",
    hits: ids.map((id) => ({
      id,
      label: id,
      section: "baseplates",
      kind: "baseplate",
      file: null,
    })),
  };
}

function search(
  query: string,
  recent: ReadonlyArray<string> = [],
  remote: CatalogSearchView = SERVER_OFF,
) {
  return searchPalette(query, {
    catalog,
    index,
    recent,
    remote,
    enabled: (id: CommandId) => id !== "delete",
  });
}

function name(result: PaletteResult | undefined): string {
  if (!result) return "nothing";
  return result.kind === "item" ? result.item.id : result.spec.id;
}

describe("palette search", () => {
  it.each([
    ["green 32x32", "ldraw:3811@2"],
    ["green 32 x 32", "ldraw:3811@2"],
    ["32×32 green", "ldraw:3811@2"],
    ["bright green", "ldraw:3811@10"],
    ["3867", "ldraw:3867@2"],
    ["green road", "ldraw:44336p01@2"],
    ["undo", "undo"],
    ["remove", "delete"],
    ["track", "draw-track"],
    ["help", "show-shortcuts"],
    ["44336pr0003", "ldraw:44336p03@72"],
    ["4219692", "ldraw:3811@2"],
    ["crosroads", "ldraw:2358p02@72"],
    ["-road baseplate 48", "ldraw:4186@2"],
  ])("puts the best match for %s first", (query, expected) => {
    expect(name(search(query)[0])).toBe(expected);
  });

  it("needs every word to match", () => {
    expect(search("blue road").map(name)).toEqual([]);
    expect(search("bright green 16x16").map(name)).toEqual([]);
  });

  it("keeps a disabled command but ranks an enabled one with the same match above it", () => {
    const results = search("selection");
    const del = results.findIndex((r) => name(r) === "delete");
    const focus = results.findIndex((r) => name(r) === "focus");
    expect(del).toBeGreaterThan(focus);
    expect(results[del]).toMatchObject({ kind: "command", enabled: false });
  });

  it("lists recent parts, then commands that can run now, when the query is empty", () => {
    const results = search("", ["ldraw:3867@2", "ldraw:3811@1"]);
    expect(results.slice(0, 2).map(name)).toEqual(["ldraw:3867@2", "ldraw:3811@1"]);
    const commands = results.slice(2);
    expect(commands.every((result) => result.kind === "command")).toBe(true);
    const firstDisabled = commands.findIndex((r) => r.kind === "command" && !r.enabled);
    expect(commands.slice(firstDisabled).every((r) => r.kind === "command" && !r.enabled)).toBe(
      true,
    );
  });

  it("lifts a recent part above an equal match", () => {
    expect(name(search("baseplate 32", ["ldraw:3811@1"])[0])).toBe("ldraw:3811@1");
  });

  it("ranks a command whose title has the word with the parts named by it, not below them", () => {
    const kinds = search("road").map((result) => result.kind);
    expect(kinds.lastIndexOf("command")).toBeLessThan(kinds.indexOf("item"));
    expect(
      search("road")
        .filter((result) => result.kind === "command")
        .map(name),
    ).toEqual(expect.arrayContaining(["toggle-joins", "toggle-road-snap"]));
  });

  it("lists the server's hits on parts the catalog has after every local result, in the server's order, each part once", () => {
    const remote = served("road", [
      "ldraw:3811@1",
      "ldraw:2358p02@72",
      "ldraw:99999@4",
      "ldraw:4186@2",
    ]);

    expect(search("road", [], remote).map(name)).toEqual([
      ...search("road").map(name),
      "ldraw:3811@1",
      "ldraw:4186@2",
    ]);
  });

  it("keeps the server's hits for an earlier query out of the results", () => {
    expect(search("road", [], served("roa", ["ldraw:3811@1"])).map(name)).toEqual(
      search("road").map(name),
    );
  });

  it("lists every matching part once before any part's other colours", () => {
    const groups = search("baseplate").flatMap((result) =>
      result.kind === "item" ? [result.item.group] : [],
    );
    const firstRepeat = groups.findIndex((group, at) => groups.indexOf(group) < at);
    expect(new Set(groups.slice(0, firstRepeat)).size).toBe(new Set(groups).size);
  });
});
