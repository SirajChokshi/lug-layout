import { describe, expect, it } from "vitest";
import { CROSSWALK_FORMAT, type CrosswalkFile, type CrosswalkPart } from "@brr/schema/bundle";
import type { LdrawPartFacts } from "./crosswalk.ts";
import { deriveLibraryParts, inventoryColorCounts } from "./library-parts.ts";
import { parseLdrawCategories } from "./part-categories.ts";

const CA_LICENSE = "Licensed under CC BY 4.0 : see CAreadme.txt";
const NON_CA_LICENSE = "Not redistributable : see NonCAreadme.txt";

const categories = parseLdrawCategories(`<?php
enum PartCategory: string implements HasLabel
{
    case Brick = 'Brick';
    case Plant = 'Plant';
    case Fence = 'Fence';
    case Moved = 'Moved';

    public static function inactiveCategories(): array
    {
        return [PartCategory::Moved];
    }

    public function retired(): array
    {
        return [];
    }
}
`);

function part(title: string, overrides: Partial<LdrawPartFacts> = {}): LdrawPartFacts {
  return {
    title,
    keywords: [],
    ldrawOrg: "Part",
    license: CA_LICENSE,
    components: [],
    ...overrides,
  };
}

function mapped(rebrickable: string): CrosswalkPart {
  return { rebrickable, bricklink: null, via: { rebrickable: "rebrickable-api", bricklink: null } };
}

const ldrawParts = new Map<string, LdrawPartFacts>([
  ["3001", part("Brick  2 x  4", { keywords: ["Bricklink 3001"] })],
  ["3471", part("Plant Tree Pyramidal 4 x 4 x 6.667 Type 1", { keywords: ["pine", "Christmas"] })],
  ["3633", part("Fence Lattice  1 x  4 x  1")],
  ["72841", part("=Brick  2 x  4 with Bottom Tubes")],
  ["3556", part("~Brick  2 x  4 without Bottom Tubes")],
  ["2865", part("~Moved to 74746")],
  ["3001p11", part("_Brick  2 x  4 Red with Pattern")],
  ["3010", part("Brick  1 x  4", { license: NON_CA_LICENSE })],
  ["3009", part("Brick  1 x  6", { ldrawOrg: "Unofficial_Part" })],
  ["3008", part("Brick  1 x  8")],
  ["3007", part("Brick  2 x  8")],
]);

const crosswalk: CrosswalkFile = {
  format: CROSSWALK_FORMAT,
  sources: {},
  parts: {
    "ldraw:3001": mapped("3001"),
    "ldraw:3471": mapped("3471"),
    "ldraw:3633": mapped("3633"),
    "ldraw:3010": mapped("3010"),
    "ldraw:3009": mapped("3009"),
    "ldraw:3007": mapped("3007"),
  },
  colors: {
    "1": { name: "Blue", rebrickable: 1, bricklink: 7 },
    "2": { name: "Green", rebrickable: 2, bricklink: 6 },
    "4": { name: "Red", rebrickable: 4, bricklink: 5 },
    "15": { name: "White", rebrickable: 15, bricklink: 1 },
    "71": { name: "Light_Bluish_Grey", rebrickable: 71, bricklink: 86 },
    "151": { name: "Very_Light_Bluish_Grey", rebrickable: 71, bricklink: 99 },
    "500": { name: "Not_In_The_Bundle", rebrickable: 500, bricklink: null },
  },
  bricklinkParts: {},
  bricklinkPartVariants: {},
  bricklinkColors: {},
};

const inventoryCsv = [
  "inventory_id,part_num,color_id,quantity,is_spare,img_url",
  "1,3001,4,2,False,",
  "2,3001,4,8,False,",
  "3,3001,15,1,False,",
  "4,3001,1,4,True,",
  "4,3001,15,4,False,",
  "5,3001,71,1,False,",
  "6,3001,500,1,False,",
  "7,3471,2,1,False,",
  '8,3633,15,1,False,"https://cdn.example/3633,15.jpg"',
  "9,3010,4,1,False,",
  "10,3009,4,1,False,",
  "11,3007,9999,1,False,",
  "",
].join("\n");

const derived = deriveLibraryParts(
  {
    ldrawParts,
    categories,
    crosswalk,
    inventoryColors: inventoryColorCounts(inventoryCsv),
    ldrawColors: new Set([1, 2, 4, 15, 71, 151]),
  },
  {},
);

function listedPart(id: string) {
  const { parts, categories: names } = derived.file;
  const index = parts.id.indexOf(id);
  const start = parts.colorCount.slice(0, index).reduce((sum, count) => sum + count, 0);
  return {
    title: parts.title[index],
    category: names[parts.category[index] ?? -1],
    keywords: parts.keywords[index],
    rebrickable: parts.rebrickable[index],
    colors: parts.colors.slice(start, start + (parts.colorCount[index] ?? 0)),
  };
}

describe("library part index", () => {
  it("lists only canonical, contributor-agreement parts in an active category that have a produced colour", () => {
    expect(derived.file.parts.id).toEqual(["3001", "3471", "3633"]);
    expect(derived.report).toEqual({
      scanned: 11,
      listed: 3,
      unlisted: 4,
      notContributorAgreement: 1,
      unofficial: 1,
      withoutRebrickable: 1,
      withoutProducedColor: 1,
    });
  });

  it("keeps each part's own title, category, keywords and Rebrickable number", () => {
    expect(listedPart("3471")).toEqual({
      title: "Plant Tree Pyramidal 4 x 4 x 6.667 Type 1",
      category: "Plant",
      keywords: ["pine", "Christmas"],
      rebrickable: "3471",
      colors: [2],
    });
    expect(derived.file.categories).toEqual(["Brick", "Fence", "Plant"]);
  });

  it("orders produced colours by how many inventories list them, and drops colours that map to no single LDConfig colour", () => {
    expect(listedPart("3001").colors).toEqual([4, 15, 1]);
  });

  it("reads quoted inventory cells", () => {
    expect(listedPart("3633").colors).toEqual([15]);
  });

  it("refuses an inventory line whose cell count differs from the header", () => {
    expect(() => inventoryColorCounts("inventory_id,part_num,color_id\n1,3001\n")).toThrow(
      "inventory parts line 2 has 2 cells, not 3",
    );
  });
});
