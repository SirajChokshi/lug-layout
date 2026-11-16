import { describe, expect, it } from "vitest";
import { deriveCrosswalk, type CrosswalkInputs, type LdrawPartFacts } from "./crosswalk.ts";

function facts(title: string, ...keywords: string[]): LdrawPartFacts {
  return { title, keywords, ldrawOrg: "Part", components: [] };
}

function shortcut(title: string, ...components: Array<[string, number]>): LdrawPartFacts {
  return {
    title,
    keywords: [],
    ldrawOrg: "Shortcut",
    components: components.map(([id, color]) => ({ id, color })),
  };
}

const inputs: CrosswalkInputs = {
  apiParts: [
    { r: "3001", b: ["3001"], l: ["3001"] },
    { r: "973pb0278", b: ["973pb0278"], l: [] },
    { r: "2495", b: ["2495"], l: ["2495"] },
    { r: "2496", b: ["2496"], l: ["2496"] },
  ],
  apiColors: [],
  rebrickableParts: new Set(["3001", "4032a", "4032b", "74746"]),
  elementCounts: new Map(),
  ldrawParts: new Map([
    ["3001", facts("Brick  2 x  4")],
    ["72841", facts("=Brick  2 x  4 with Bottom Tubes", "BrickLink 3001")],
    ["3556", facts("~Brick  2 x  4 without Bottom Tubes", "BrickLink 3001")],
    ["59900", facts("Cone  1 x  1 with Stop", "BrickLink 4589b")],
    ["64288", facts("=Cone  1 x  1 with Stop", "BrickLink 4589")],
    ["74746", facts("Train Track  9V Straight", "BrickLink 2865c01")],
    ["2865", facts("~Moved to 74746", "BrickLink 2865c01")],
    ["4032a", facts("Plate  2 x  2 Round with Axlehole", "BrickLink 4032")],
    ["4032b", facts("Plate  2 x  2 Round with Reduced Axlehole", "BrickLink 4032")],
    ["973p8o", facts("Minifig Torso with Safety Vest Pattern", "Bricklink 973pb0278")],
    ["2495", facts("Minifig Hand Truck")],
    ["2496", facts("Minifig Hand Truck Wheel")],
    ["2495c01", shortcut("Minifig Hand Truck (Complete)", ["2495", 16], ["2496", 0])],
  ]),
  ldrawColors: [],
};

const crosswalk = deriveCrosswalk(inputs, {});

describe("crosswalk derivation", () => {
  it.each([
    ["3001", ["ldraw:3001"], ["ldraw:3556", "ldraw:72841"]],
    ["4589b", ["ldraw:59900"], undefined],
    ["2865c01", ["ldraw:74746"], undefined],
    ["4032", ["ldraw:4032a", "ldraw:4032b"], undefined],
  ])("BrickLink %s lists canonical LDraw candidates only", (bricklink, candidates, variants) => {
    expect(crosswalk.bricklinkParts[bricklink]).toEqual(candidates);
    expect(crosswalk.bricklinkPartVariants[bricklink]).toEqual(variants);
  });

  it("reads keyword system names in any case and reaches Rebrickable through its BrickLink ids", () => {
    expect(crosswalk.parts["ldraw:973p8o"]).toMatchObject({
      rebrickable: "973pb0278",
      bricklink: "973pb0278",
      via: { rebrickable: "bricklink-keyword" },
    });
  });

  it("expands an unmapped shortcut into the parts its own file names", () => {
    expect(crosswalk.parts["ldraw:2495c01"]?.components).toEqual([
      { part: "ldraw:2495", color: 16 },
      { part: "ldraw:2496", color: 0 },
    ]);
  });

  it("never takes another file's keyword for a canonical part", () => {
    expect(crosswalk.parts["ldraw:3001"]?.bricklink).toBe("3001");
    expect(crosswalk.parts["ldraw:59900"]?.bricklink).toBe("4589b");
    expect(crosswalk.parts["ldraw:64288"]?.bricklink).toBe("4589");
  });
});
