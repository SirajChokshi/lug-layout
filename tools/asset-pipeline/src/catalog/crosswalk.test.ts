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
    { r: "2557c02", b: ["2557c02"], l: ["2557c01"] },
    { r: "2557c03", b: ["2557c03"], l: ["2557c01"] },
    { r: "970c05pr0401", b: ["970c00pb0401"], l: ["3815bpc44"] },
    { r: "970c32pr0401", b: ["970c32pb0401"], l: ["3815bpc44"] },
    { r: "7065", b: ["7065"], l: ["n/a"] },
    { r: "37364c04pr0001", b: ["970cm00pb018"], l: ["37364p01"] },
  ],
  apiColors: [],
  rebrickableParts: new Set(["3001", "4032a", "4032b", "74746", "2889", "37364c04pr0001"]),
  ldrawParts: new Map([
    ["3001", facts("Brick  2 x  4")],
    ["72841", facts("=Brick  2 x  4 with Bottom Tubes", "BrickLink 3001")],
    ["3556", facts("~Brick  2 x  4 without Bottom Tubes", "BrickLink 3001")],
    ["59900", facts("Cone  1 x  1 with Stop", "BrickLink 4589b", "BrickLink 4589")],
    [
      "64288",
      {
        title: "=Cone  1 x  1 with Stop",
        keywords: ["BrickLink 4589"],
        ldrawOrg: "Part Alias",
        components: [{ id: "59900", color: 16 }],
      },
    ],
    ["74746", facts("Train Track  9V Straight", "BrickLink 2865c01")],
    ["2865", facts("~Moved to 74746", "BrickLink 2865c01")],
    ["4032a", facts("Plate  2 x  2 Round with Axlehole", "BrickLink 4032")],
    ["4032b", facts("Plate  2 x  2 Round with Reduced Axlehole", "BrickLink 4032")],
    ["973p8o", facts("Minifig Torso with Safety Vest Pattern", "Bricklink 973pb0278")],
    ["2495", facts("Minifig Hand Truck")],
    ["2496", facts("Minifig Hand Truck Wheel")],
    ["2495c01", shortcut("Minifig Hand Truck (Complete)", ["2495", 16], ["2496", 0])],
    ["2889", facts("Animal Dog Alsatian Puppy")],
    ["2557c01", facts("Train Coupling Assembly", "Rebrickable 2557c02")],
    ["3815bpc44", facts("Minifig Hips with Pattern")],
    ["37365p01", facts("Minifig Leg Medium Right with Pattern", "Bricklink 970cm00pb018")],
    [
      "37364p01",
      {
        title: "Minifig Hips and Legs Medium with Pattern",
        keywords: ["Rebrickable 37364c04pr0001"],
        ldrawOrg: "Part",
        components: [
          { id: "3815b", color: 16 },
          { id: "37366p01", color: 16 },
          { id: "37365p01", color: 16 },
        ],
      },
    ],
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

  it("leaves a part unmapped when only a Rebrickable part of the same number exists", () => {
    expect(crosswalk.parts["ldraw:2889"]).toBeUndefined();
  });

  it("prefers the file's own Rebrickable keyword among several API candidates", () => {
    expect(crosswalk.parts["ldraw:2557c01"]?.rebrickable).toBe("2557c02");
  });

  it("leaves a part unmapped, listing the candidates, when nothing names one of them", () => {
    expect(crosswalk.parts["ldraw:3815bpc44"]).toMatchObject({
      rebrickable: null,
      rebrickableAlternatives: ["970c05pr0401", "970c32pr0401"],
    });
  });

  it("never treats a Rebrickable placeholder such as n/a as an LDraw id", () => {
    expect(crosswalk.parts["ldraw:n/a"]).toBeUndefined();
    expect(crosswalk.bricklinkParts["7065"]).toBeUndefined();
  });

  it("does not map a piece to an id that LDraw gives an assembly made of it", () => {
    expect(crosswalk.parts["ldraw:37365p01"]).toMatchObject({
      rebrickable: null,
      bricklink: null,
      rejectedAssemblyIds: {
        assemblies: ["ldraw:37364p01"],
        rebrickable: [],
        bricklink: ["970cm00pb018"],
      },
    });
    expect(crosswalk.bricklinkParts["970cm00pb018"]).toEqual(["ldraw:37364p01"]);
    expect(crosswalk.parts["ldraw:37364p01"]?.rebrickable).toBe("37364c04pr0001");
    expect(crosswalk.parts["ldraw:59900"]?.rejectedAssemblyIds).toBeUndefined();
  });

  it("never takes another file's keyword for a canonical part", () => {
    expect(crosswalk.parts["ldraw:3001"]?.bricklink).toBe("3001");
    expect(crosswalk.parts["ldraw:59900"]?.bricklink).toBe("4589b");
    expect(crosswalk.parts["ldraw:64288"]?.bricklink).toBe("4589");
  });
});
