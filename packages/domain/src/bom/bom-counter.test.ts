import { describe, expect, it } from "vitest";
import { BomCounter } from "./bom-counter.ts";
import { toCatalog, type Crosswalk } from "./catalog-ids.ts";

const crosswalk: Crosswalk = {
  parts: new Map([["ldraw:3001", { rebrickable: "3001", bricklink: "3001" }]]),
  colors: new Map([[4, { rebrickable: 4, bricklink: 5 }]]),
};

describe("parts list counting", () => {
  it("reports a colour outside the colour table as unmapped instead of failing", () => {
    const counter = new BomCounter(["ldraw:3001"], [4]);
    counter.add(0, 4, 2);
    counter.add(0, 0x2ff0000, 1);
    const bom = toCatalog(counter.lines(), crosswalk, "rebrickable");
    expect(counter.total()).toBe(3);
    expect(bom.lines).toEqual([{ part: "3001", color: 4, quantity: 2, fromKeywordOnly: false }]);
    expect(bom.unmapped).toEqual([
      {
        part: "ldraw:3001",
        ldrawColor: 0x2ff0000,
        quantity: 1,
        expandedFrom: null,
        missing: "color",
      },
    ]);
  });
});
