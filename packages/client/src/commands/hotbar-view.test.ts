import { describe, expect, it } from "vitest";
import type { CatalogItemView } from "../catalog/placeable-catalog.ts";
import type { RoadKitView } from "../edit/road-drawing.ts";
import { EMPTY_HOTBAR, hotbarWith, hotbarWithPinToggled } from "./hotbar.ts";
import { hotbarView } from "./hotbar-view.ts";

const GREEN = { code: 2, name: "Green", rgb: "#237841" };

function catalogItem(
  id: string,
  label: string,
  studsWide: number,
  studsDeep: number,
  color: CatalogItemView["color"],
): CatalogItemView {
  return {
    id,
    label,
    shortLabel: label,
    group: id,
    groupLabel: label,
    color,
    kind: "model",
    parts: 1,
    studsWide,
    studsDeep,
    thumbnail: null,
    aliases: [],
    elements: [],
    displayColor: false,
    draggable: true,
    toggleable: false,
    listedUnder: null,
    customParts: 0,
  };
}

const PLATE = catalogItem("plate", "Baseplate 32 x 32, Green", 32, 32, GREEN);
const IMPORTED = catalogItem("import:custom", "Custom_yard", 16, 8, null);
const MISSING = "import:no-longer-in-the-catalog";
const ROAD_KIT: RoadKitView = {
  id: "road-kit:0",
  label: "Dark Bluish Grey road plates, 6-stud sidewalks",
  edge: "edge 6 + 20 road + 6 studs",
  tileStuds: 32,
  shapes: ["straight"],
  pieces: [],
};

describe("hotbar view", () => {
  it("draws each footprint as a share of the largest one in the hotbar, in the catalog colour when there is one, and marks pinned slots", () => {
    const hotbar = hotbarWithPinToggled(
      [PLATE.id, IMPORTED.id, MISSING].reduce(hotbarWith, EMPTY_HOTBAR),
      0,
    );

    expect(hotbarView(hotbar, [PLATE, IMPORTED])).toEqual([
      {
        item: PLATE.id,
        label: "Baseplate 32 x 32, Green",
        caption: "Baseplate 32 x 32, Green",
        footprint: { studsWide: 32, studsDeep: 32, wideShare: 1, deepShare: 1 },
        color: GREEN.rgb,
        pinned: true,
        pinnable: true,
      },
      {
        item: IMPORTED.id,
        label: "Custom yard",
        caption: "Custom_yard",
        footprint: { studsWide: 16, studsDeep: 8, wideShare: 0.5, deepShare: 0.25 },
        color: null,
        pinned: false,
        pinnable: true,
      },
      {
        item: MISSING,
        label: MISSING,
        caption: MISSING,
        footprint: null,
        color: null,
        pinned: false,
        pinnable: true,
      },
    ]);
  });

  it("names a road kit's slot after the kit, with its tile as the footprint, instead of its id", () => {
    const hotbar = [PLATE.id, ROAD_KIT.id].reduce(hotbarWith, EMPTY_HOTBAR);

    expect(hotbarView(hotbar, [PLATE], [ROAD_KIT])[1]).toEqual({
      item: ROAD_KIT.id,
      label: "Dark Bluish Grey road plates, 6-stud sidewalks",
      caption: "Road",
      footprint: { studsWide: 32, studsDeep: 32, wideShare: 1, deepShare: 1 },
      color: null,
      pinned: false,
      pinnable: true,
    });
  });
});
