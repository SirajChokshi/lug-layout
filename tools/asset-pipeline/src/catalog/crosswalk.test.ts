import { describe, expect, it } from "vitest";
import { deriveCrosswalk, type CrosswalkInputs, type LdrawPartFacts } from "./crosswalk.ts";

function facts(title: string, ...keywords: string[]): LdrawPartFacts {
  return { title, keywords };
}

const inputs: CrosswalkInputs = {
  apiParts: [{ r: "3001", b: ["3001"], l: ["3001"] }],
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
  ]),
  ldrawColors: [],
};

const crosswalk = deriveCrosswalk(inputs, {});

describe("BrickLink keywords on alias and variant files", () => {
  it.each([
    ["3001", ["ldraw:3001"], ["ldraw:3556", "ldraw:72841"]],
    ["4589b", ["ldraw:59900"], undefined],
    ["2865c01", ["ldraw:74746"], undefined],
    ["4032", ["ldraw:4032a", "ldraw:4032b"], undefined],
  ])("BrickLink %s lists canonical LDraw candidates only", (bricklink, candidates, variants) => {
    expect(crosswalk.bricklinkParts[bricklink]).toEqual(candidates);
    expect(crosswalk.bricklinkPartVariants[bricklink]).toEqual(variants);
  });

  it("never takes another file's keyword for a canonical part", () => {
    expect(crosswalk.parts["ldraw:3001"]?.bricklink).toBe("3001");
    expect(crosswalk.parts["ldraw:59900"]?.bricklink).toBe("4589b");
    expect(crosswalk.parts["ldraw:64288"]?.bricklink).toBe("4589");
  });
});
