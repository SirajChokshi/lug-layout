import { describe, expect, it } from "vitest";
import type { CatalogItemView } from "../edit/editor.ts";
import { searchPalette, type PaletteResult } from "./command-search.ts";
import type { CommandId } from "./editor-commands.ts";

function baseplate(
  part: string,
  studs: number,
  code: number,
  colorName: string,
  rgb: string,
): CatalogItemView {
  const title = `Baseplate ${studs} x ${studs}`;
  return {
    id: `ldraw:${part}@${code}`,
    label: `${part} ${title}, ${colorName}`,
    group: `ldraw:${part}`,
    groupLabel: `${part} ${title}`,
    color: { code, name: colorName, rgb },
    kind: "baseplate",
    parts: 1,
    studsWide: studs,
    studsDeep: studs,
    thumbnail: null,
    aliases: [],
    elements: [],
  };
}

const catalog: ReadonlyArray<CatalogItemView> = [
  baseplate("3811", 32, 10, "Bright_Green", "#58AB41"),
  baseplate("3811", 32, 2, "Green", "#00852B"),
  baseplate("3811", 32, 1, "Blue", "#1E5AA8"),
  baseplate("3867", 16, 2, "Green", "#00852B"),
  {
    id: "ldraw:44336p01@2",
    label: "44336p01 Baseplate 32 x 32 Road 6-Stud Straight with Yellow Road Edge Pattern, Green",
    group: "ldraw:44336p01",
    groupLabel: "44336p01 Baseplate 32 x 32 Road 6-Stud Straight with Yellow Road Edge Pattern",
    color: { code: 2, name: "Green", rgb: "#00852B" },
    kind: "road-plate",
    parts: 1,
    studsWide: 32,
    studsDeep: 32,
    thumbnail: null,
    aliases: ["44336pr0001"],
    elements: [],
  },
];

function search(query: string, recent: ReadonlyArray<string> = []) {
  return searchPalette(query, {
    catalog,
    recent,
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
});
