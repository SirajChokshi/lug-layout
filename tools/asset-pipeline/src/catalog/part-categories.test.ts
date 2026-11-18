import { describe, expect, it } from "vitest";
import type { Palette, PartRole } from "@brr/schema/bundle";
import type { LdrawPartFacts } from "./crosswalk.ts";
import {
  ldrawCategoryOf,
  paletteCategoryProblems,
  parseLdrawCategories,
  partCategory,
} from "./part-categories.ts";

const TRACKER_ENUM = `<?php
enum PartCategory: string implements HasLabel
{
    case Baseplate = 'Baseplate';
    case Brick = 'Brick';
    case Plate = 'Plate';
    case Tile = 'Tile';
    case Train = 'Train';
    case MinifigAccessory = 'Minifig Accessory';
    case Moved = 'Moved';
    case Obsolete = 'Obsolete';
    case Minifig = 'Minifig';

    public static function inactiveCategories(): array
    {
        return [PartCategory::Moved, PartCategory::Obsolete];
    }

    public function retired(): array
    {
        return [
            self::Minifig,
        ];
    }
}
`;

const categories = parseLdrawCategories(TRACKER_ENUM);

function facts(title: string, keywords: string[] = [], category?: string): LdrawPartFacts {
  return {
    title,
    keywords,
    ldrawOrg: "Part",
    components: [],
    ...(category === undefined ? {} : { category }),
  };
}

const library = new Map<string, LdrawPartFacts>([
  ["3811", facts("Baseplate 32 x 32")],
  ["44336p01", facts("Baseplate 32 x 32 Road 6-Stud Straight", ["roadplate"])],
  ["69958", facts("Plate 16 x 16 x  0.667 with Cutouts and Recessed Studs", ["road", "Street"])],
  ["51595", facts("Baseplate 16 x 16 Driveway", ["BrickLink 30225"])],
  ["74746", facts("Train Track  9V Straight", ["BrickLink 2865c01"])],
  ["3020", facts("Plate  2 x  4")],
  ["3062b", facts("Brick  1 x  1 Round with Hollow Stud")],
  ["3068b", facts("Tile  2 x  2 with Groove")],
  ["3023", { ...facts("~Moved to 3023b"), components: [{ id: "3023b", color: 16 }] }],
  ["3023b", facts("Plate  1 x  2 with Groove with 1 Centre Stud")],
  ["63325", { ...facts("=Plate  2 x  2 Corner"), components: [{ id: "2420", color: 16 }] }],
  ["973p01", facts("Minifig Torso with Pattern")],
  ["4522", facts("~Minifig Tool Mallet (Obsolete)", [], "Obsolete")],
  ["4073", facts("Plate  1 x  1 Round", ["Minifig Accessory"])],
  ["2617", facts("Platform 16 x 16 x  2.333 Even")],
]);

function palette(
  parts: ReadonlyArray<readonly [string, PartRole]>,
  models: Palette["models"] = [],
): Palette {
  return { parts: parts.map(([id, role]) => ({ id, role })), models } as unknown as Palette;
}

describe("LDraw category", () => {
  it.each([
    ["3811", "Baseplate"],
    ["3023", "Moved"],
    ["63325", "Plate"],
    ["4522", "Obsolete"],
    ["973p01", "Minifig"],
    ["2617", null],
  ])("of %s is %s", (id, expected) => {
    const part = library.get(id);
    if (!part) throw new Error(id);
    expect(ldrawCategoryOf(part, categories)).toBe(expected);
  });

  it("takes !CATEGORY over the first word of the title, and refuses an unknown one", () => {
    expect(ldrawCategoryOf(facts("Plate  1 x  1 Round", [], "Minifig Accessory"), categories)).toBe(
      "Minifig Accessory",
    );
    expect(ldrawCategoryOf(facts("Plate  1 x  1", [], "Plates"), categories)).toBeNull();
  });

  it("follows a moved stub to the part it names", () => {
    expect(partCategory("3023", library, categories)).toEqual({
      ldrawCategory: "Plate",
      keywords: [],
    });
  });
});

describe("palette categories", () => {
  it("accepts parts whose role matches their LDraw category and keywords", () => {
    const ok = palette([
      ["3811", "ground"],
      ["44336p01", "road"],
      ["69958", "road"],
      ["51595", "road"],
      ["74746", "track"],
      ["3020", "roof"],
      ["3062b", "detail"],
      ["3068b", "detail"],
    ]);
    expect(paletteCategoryProblems(ok, library, categories)).toEqual([]);
  });

  it.each([
    ["3023", "detail", 'ldraw:3023 (detail) is a "~Moved to 3023b" stub; bundle 3023b instead'],
    [
      "63325",
      "roof",
      'ldraw:63325 (roof) is an alias ("=Plate  2 x  2 Corner"); bundle 2420 instead',
    ],
    ["4522", "detail", 'ldraw:4522 (detail) is a "~" file'],
    ["3001", "wall", "ldraw:3001 (wall) is not a part of the pinned LDraw library"],
    [
      "2617",
      "ground",
      'ldraw:2617 (ground) "Platform 16 x 16 x  2.333 Even" has no LDraw category',
    ],
    [
      "973p01",
      "detail",
      "ldraw:973p01 (detail) is in the inactive or retired LDraw category Minifig",
    ],
    [
      "44336p01",
      "ground",
      "ldraw:44336p01 (ground) has role ground, but its title or keywords say road, roadplate",
    ],
    [
      "3020",
      "road",
      "ldraw:3020 (road) has role road, but neither its title nor its keywords say road",
    ],
    ["3068b", "wall", "ldraw:3068b (wall) is LDraw category Tile, but role wall takes Brick"],
    ["74746", "model", "ldraw:74746 (model) has role model, which no palette part may carry"],
  ] as const)("reports %s filed as %s", (id, role, problem) => {
    const [reported, ...rest] = paletteCategoryProblems(palette([[id, role]]), library, categories);
    expect(rest).toEqual([]);
    expect(reported).toContain(problem);
  });

  it("reports an OMR set the palette would list by file name", () => {
    const models = [
      { name: "10014-1", origin: "omr" },
      { name: "10133-1", origin: "omr", set: { name: "Locomotive", year: 2004, source: "S13" } },
      { name: "mils-plain", origin: "generated" },
    ] as unknown as Palette["models"];
    expect(paletteCategoryProblems(palette([], models), library, categories)).toEqual([
      "10014-1 is an OMR set with no Rebrickable set name, so the palette would list it by file name",
    ]);
  });
});
